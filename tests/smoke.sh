#!/usr/bin/env bash
# End-to-end smoke test: risk_agent + oracle (mock x402) answer a real request.
# Verifies the cross-language pipeline (Node oracle -> Python risk agent).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export X402_MODE=mock

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "==> starting risk_agent"
( cd "$ROOT/agents/risk_agent" && { [ -d .venv ] && . .venv/bin/activate; }; python3 server.py >/tmp/zkc_risk.log 2>&1 ) &
pids+=($!)
echo "==> starting oracle"
( cd "$ROOT/agents/oracle_provider" && node server.mjs >/tmp/zkc_oracle.log 2>&1 ) &
pids+=($!)

echo "==> waiting for services"
for i in $(seq 1 30); do
  if curl -sf localhost:8000/health >/dev/null && curl -sf localhost:3001/health >/dev/null; then break; fi
  sleep 0.5
done

echo "==> requesting a solvency evaluation"
RESP=$(curl -sf -X POST localhost:3001/evaluate \
  -H 'content-type: application/json' \
  -d '{"proofType":"solvency","proof":{"demo":true},"publicSignals":["1","1","1"],
       "signals":{"wallet_age_days":540,"tx_count":320,"prior_loans_repaid":8}}')
echo "    $RESP"

echo "$RESP" | grep -q '"proof_valid":true' || { echo "FAIL: proof not valid"; exit 1; }
echo "$RESP" | grep -q '"rate_bps":600'     || { echo "FAIL: expected 6% tier"; exit 1; }
echo "PASS: oracle returned a 6% rate for the strong solvency borrower"
