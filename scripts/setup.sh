#!/usr/bin/env bash
# One-shot dependency setup for every zkCredit component.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Soroban contracts (build + test)"
(cd "$ROOT/contracts" && cargo test && stellar contract build)

echo "==> Risk agent (Python venv)"
(cd "$ROOT/agents/risk_agent" && python3 -m venv .venv && . .venv/bin/activate && pip install -q -r requirements.txt)

echo "==> Oracle provider (Node)"
(cd "$ROOT/agents/oracle_provider" && npm install)

echo "==> x402 buyer client (Node)"
(cd "$ROOT/x402" && npm install)

echo "==> Circuits tooling (Node)"
(cd "$ROOT/circuits" && npm install)

echo "==> Frontend (Node)"
(cd "$ROOT/frontend" && npm install)

echo "==> Done. Copy .env.example to .env and run scripts/dev.sh"
