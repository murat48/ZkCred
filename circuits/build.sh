#!/usr/bin/env bash
# Compile a circuit and run a full Groth16 trusted setup on BLS12-381 (CAP-0059).
#
# Usage:  ./build.sh solvency_proof solvency
#         ./build.sh repayment_proof repayment
#
# Requires: circom 2.x, snarkjs, circomlib (npm i circomlib), node.
set -euo pipefail

DIR="${1:?usage: build.sh <circuit_dir> <circuit_name>}"
NAME="${2:?usage: build.sh <circuit_dir> <circuit_name>}"
PTAU_POWER="${PTAU_POWER:-13}"

cd "$(dirname "$0")/$DIR"
mkdir -p build
cd build

echo "==> Compiling $NAME.circom (BLS12-381)"
circom "../$NAME.circom" --r1cs --wasm --sym --prime bls12381 -l ../../node_modules -o .

echo "==> Powers of Tau (phase 1)"
snarkjs powersoftau new bls12381 "$PTAU_POWER" pot_0000.ptau -v
snarkjs powersoftau contribute pot_0000.ptau pot_0001.ptau \
  --name="zkcredit-dev" -v -e="$(head -c 32 /dev/urandom | xxd -p)"
snarkjs powersoftau prepare phase2 pot_0001.ptau pot_final.ptau -v

echo "==> Groth16 setup (phase 2)"
snarkjs groth16 setup "$NAME.r1cs" pot_final.ptau "${NAME}_0000.zkey"
snarkjs zkey contribute "${NAME}_0000.zkey" "${NAME}_final.zkey" \
  --name="zkcredit-dev-2" -v -e="$(head -c 32 /dev/urandom | xxd -p)"
snarkjs zkey export verificationkey "${NAME}_final.zkey" verification_key.json

echo "==> Example proof from input.example.json"
node "${NAME}_js/generate_witness.js" "${NAME}_js/${NAME}.wasm" \
  ../input.example.json witness.wtns
snarkjs groth16 prove "${NAME}_final.zkey" witness.wtns proof.json public.json
snarkjs groth16 verify verification_key.json public.json proof.json

echo "==> Exporting verifying key + proof to Soroban byte layout"
node ../../export_to_soroban.mjs verification_key.json proof.json public.json \
  > soroban_artifacts.json

echo "Done. Artifacts in $DIR/build/ (soroban_artifacts.json feeds proof_verifier)."
