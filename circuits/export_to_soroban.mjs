#!/usr/bin/env node
// Convert snarkjs (BLS12-381) verification_key.json + proof.json + public.json
// into the byte layout expected by the Soroban `proof_verifier` contract.
//
// Confirmed from soroban-env-host src/crypto/bls12_381.rs line 313:
//   G1Affine  = 96 bytes  : be_bytes(X) || be_bytes(Y)
//   G2Affine  = 192 bytes : be_bytes(X.c1) || be_bytes(X.c0) || be_bytes(Y.c1) || be_bytes(Y.c0)
//
// snarkjs G2 coord arrays: p[0] = [x.c0, x.c1]  →  we output x.c1 FIRST.
// snarkjs G1 coord arrays: p[0] = x, p[1] = y (both projective; z[2]=1 for affine).
import { readFileSync } from "node:fs";

function toBE48(decStr) {
  const hex = BigInt(decStr).toString(16);
  if (hex.length > 96) throw new Error(`field element too large: ${decStr.slice(0, 20)}…`);
  return hex.padStart(96, "0");
}

const hexToBytes = (hex) =>
  Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16));

// G1: [x, y, z] (z=1) → 96 bytes big-endian x || y
const g1 = (p) => toBE48(p[0]) + toBE48(p[1]);

// G2: [[x.c0, x.c1], [y.c0, y.c1], z] → 192 bytes
// Stellar layout: X.c1 || X.c0 || Y.c1 || Y.c0  (c1 first — opposite of snarkjs array order)
const g2 = (p) => toBE48(p[0][1]) + toBE48(p[0][0]) + toBE48(p[1][1]) + toBE48(p[1][0]);

const [, , vkPath, proofPath, publicPath] = process.argv;
if (!vkPath) {
  console.error("usage: export_to_soroban.mjs <vk.json> [proof.json] [public.json]");
  process.exit(1);
}

const vk = JSON.parse(readFileSync(vkPath, "utf8"));
const out = {
  verifying_key: {
    alpha: hexToBytes(g1(vk.vk_alpha_1)),
    beta:  hexToBytes(g2(vk.vk_beta_2)),
    gamma: hexToBytes(g2(vk.vk_gamma_2)),
    delta: hexToBytes(g2(vk.vk_delta_2)),
    ic:    vk.IC.map((p) => hexToBytes(g1(p))),
  },
};

if (proofPath) {
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  out.proof = {
    a: hexToBytes(g1(proof.pi_a)),
    b: hexToBytes(g2(proof.pi_b)),
    c: hexToBytes(g1(proof.pi_c)),
  };
}
if (publicPath) {
  out.public_inputs = JSON.parse(readFileSync(publicPath, "utf8")).map(String);
}

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
