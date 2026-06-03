#!/usr/bin/env bash
# Launch the full local stack: risk agent -> oracle (x402) -> frontend.
# Defaults to X402_MODE=mock so it runs with no facilitator or funded wallet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Config source of truth is $ROOT/.env (X402_MODE, keys, recipient, facilitator).
# Services load it themselves (oracle via node --env-file, frontend via .env.local)
# so $0.05-style values aren't mangled by shell expansion. A shell-exported
# X402_MODE still wins (e.g. `X402_MODE=mock ./scripts/dev.sh`).
ENV_MODE="$(grep -E '^X402_MODE=' "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' ')"
X402_MODE="${X402_MODE:-${ENV_MODE:-mock}}"

pids=()
cleanup() { echo; echo "Stopping…"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "==> Risk agent on :8000"
( cd "$ROOT/agents/risk_agent" && \
  { [ -d .venv ] && . .venv/bin/activate; } ; \
  python3 server.py ) &
pids+=($!)

echo "==> MockBank Data Provider on :3002"
( cd "$ROOT/agents/bank_agent" && node server.mjs ) &
pids+=($!)

# Network flags (both needed for live mode — see memory/x402_live_mode.md):
#   --dns-result-order=ipv4first      : WSL2 often has no IPv6 route; without this
#                                       the facilitator (Cloudflare) hangs on AAAA.
#   --no-network-family-autoselection : the facilitator resolves to two Cloudflare
#                                       IPv4s, one of which times out from here.
#                                       Node's Happy Eyeballs picks the bad one
#                                       ~half the time ("fetch failed / Failed to
#                                       create payment payload"); this pins the
#                                       first (working) IPv4 from the resolver.
NET_FLAGS="--dns-result-order=ipv4first --no-network-family-autoselection"

echo "==> Risk oracle (x402=$X402_MODE) on :3001"
( cd "$ROOT/agents/oracle_provider" && X402_MODE="$X402_MODE" node $NET_FLAGS --env-file="$ROOT/.env" server.mjs ) &
pids+=($!)

echo "==> Frontend on :3000"
# Same flags: the buyer (route.ts) signs Soroban auth entries against Stellar RPC
# and pays the facilitator; without them live x402 silently times out in WSL2.
( cd "$ROOT/frontend" && NODE_OPTIONS="$NET_FLAGS" npm run dev ) &
pids+=($!)

echo "==> Up: http://localhost:3000  (Ctrl-C to stop all)"
wait
