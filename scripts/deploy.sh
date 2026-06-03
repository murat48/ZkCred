#!/usr/bin/env bash
# Deploy the zkCredit contract suite to a Stellar network.
#
# Order matters: leaf contracts first (verifier, policy, calculator), then the
# lending_pool that wires them together by address.
#
# Prereqs:
#   - stellar-cli v25.2.0+
#   - a funded identity ($STELLAR_SOURCE)
#   - $USDC_SAC : the USDC Stellar Asset Contract id on the target network
#   - proof_verifier needs a verifying key: pass VK_FILE=path to a JSON object
#     matching `VerificationKey` (produced by circuits/export_to_soroban.mjs,
#     re-encoded with BytesN fields as hex strings).
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${STELLAR_SOURCE:-zkcredit-deployer}"
PROTOCOL_ID="${PROTOCOL_ID:-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_DIR="$ROOT/contracts/target/wasm32v1-none/release"
OUT="$ROOT/deployments.$NETWORK.env"

echo "==> Building contracts"
(cd "$ROOT/contracts" && stellar contract build)

echo "==> Ensuring identity '$SOURCE' is funded on $NETWORK"
stellar keys address "$SOURCE" >/dev/null 2>&1 || stellar keys generate --global "$SOURCE" --network "$NETWORK"
stellar keys fund "$SOURCE" --network "$NETWORK" 2>/dev/null || true
ADMIN="$(stellar keys address "$SOURCE")"
echo "    admin: $ADMIN"

deploy() {  # deploy <wasm_name> [-- constructor args...]
  local name="$1"; shift
  stellar contract deploy \
    --wasm "$WASM_DIR/${name}.wasm" \
    --source "$SOURCE" --network "$NETWORK" "$@"
}

echo "==> risk_policy"
POLICY=$(deploy risk_policy -- --admin "$ADMIN")
echo "==> rate_calculator"
CALC=$(deploy rate_calculator)

echo "==> proof_verifier"
if [[ -n "${VK_FILE:-}" && -f "${VK_FILE}" ]]; then
  VERIFIER=$(deploy proof_verifier -- --admin "$ADMIN" --vk "$(cat "$VK_FILE")")
else
  echo "    !! VK_FILE not set — skipping proof_verifier deploy."
  echo "    !! Run circuits/build.sh, encode the vk for Soroban, then re-run with VK_FILE=..."
  VERIFIER="<DEPLOY_MANUALLY_WITH_VK>"
fi

if [[ -z "${USDC_SAC:-}" ]]; then
  echo "    !! USDC_SAC not set — cannot deploy lending_pool. Set it and re-run."
  POOL="<NEEDS_USDC_SAC>"
elif [[ "$VERIFIER" == "<"* ]]; then
  echo "    !! verifier not deployed — skipping lending_pool."
  POOL="<NEEDS_VERIFIER>"
else
  echo "==> lending_pool"
  POOL=$(deploy lending_pool -- \
    --admin "$ADMIN" --usdc "$USDC_SAC" --verifier "$VERIFIER" \
    --policy "$POLICY" --calculator "$CALC" --oracle "$ADMIN")
fi

cat > "$OUT" <<EOF
# zkCredit deployment on $NETWORK ($(date -u +%FT%TZ))
ADMIN=$ADMIN
RISK_POLICY=$POLICY
RATE_CALCULATOR=$CALC
PROOF_VERIFIER=$VERIFIER
LENDING_POOL=$POOL
PROTOCOL_ID=$PROTOCOL_ID
EOF

echo "==> Wrote $OUT"
cat "$OUT"
echo "==> Reminder: simulate every verifier call before live submission:"
echo "    stellar contract invoke --id \$PROOF_VERIFIER --is-view ... (ZK verification is resource-heavy)"
