pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// Tier proof — proves WHICH interest tier a borrower qualifies for without
// revealing their exact trust score.
//
// The score is a PRIVATE witness: only the tier (0–3) appears on-chain.
// Three threshold comparisons fold into a single u32 field element:
//   tier = (score>=80) + (score>=60) + (score>=40)
//
// Tier mapping:
//   3 → score 80–100 : best rate   (Tier A)
//   2 → score 60–79  : mid rate    (Tier B)
//   1 → score 40–59  : higher rate (Tier C)
//   0 → score  0–39  : worst rate  (Tier D)
//
// Public signals (snarkjs order = outputs first, then public inputs):
//   [0] tier         : 0–3 (the ONLY value revealed on-chain)
//   [1] protocol_id  : domain separation — must equal zkcredit_pool_v1 in-circuit
//   [2] nonce_hi     : high 128 bits of the 32-byte anti-replay nonce
//   [3] nonce_lo     : low  128 bits of the 32-byte anti-replay nonce
//   [4] expiry       : ledger after which the proof must be rejected
//   [5] borrower_hi  : high 128 bits of SHA-256(borrower StrKey)
//   [6] borrower_lo  : low  128 bits of SHA-256(borrower StrKey)
//
// This layout MUST match lending_pool's public_inputs vector and the tier
// verifying key's ic layout (IC has 8 entries for 7 public signals).
template TierProof() {
    // --- private witness (never revealed) ---
    signal input score;         // integer 0–100 (AI trust score)

    // --- public inputs (request context) ---
    signal input protocol_id;
    signal input nonce_hi;
    signal input nonce_lo;
    signal input expiry;
    signal input borrower_hi;   // high 128 bits of SHA-256(borrower G... address)
    signal input borrower_lo;   // low  128 bits of SHA-256(borrower G... address)

    // --- public output ---
    signal output tier;         // 0, 1, 2, or 3

    // Threshold comparisons (7 bits: range 0–127 covers 0–100)
    component ge80 = GreaterEqThan(7);
    ge80.in[0] <== score;
    ge80.in[1] <== 80;

    component ge60 = GreaterEqThan(7);
    ge60.in[0] <== score;
    ge60.in[1] <== 60;

    component ge40 = GreaterEqThan(7);
    ge40.in[0] <== score;
    ge40.in[1] <== 40;

    // tier = count of satisfied thresholds (1 bit each → no overflow)
    tier <== ge80.out + ge60.out + ge40.out;

    // Enforce protocol_id in-circuit: defence-in-depth so a proof generated for
    // a different protocol cannot verify here even if the pool's check is bypassed.
    protocol_id === 162723408271563627761121128780390168113;

    // Bind variable context signals into R1CS via squaring.
    // Already cryptographically bound as Groth16 public inputs (folded into vk_x),
    // but explicit constraints prevent the compiler from optimising them away.
    signal nonceHiSq;    nonceHiSq    <== nonce_hi    * nonce_hi;
    signal nonceLoSq;    nonceLoSq    <== nonce_lo    * nonce_lo;
    signal expirySq;     expirySq     <== expiry      * expiry;
    signal borrowerHiSq; borrowerHiSq <== borrower_hi * borrower_hi;
    signal borrowerLoSq; borrowerLoSq <== borrower_lo * borrower_lo;
}

component main { public [protocol_id, nonce_hi, nonce_lo, expiry, borrower_hi, borrower_lo] } = TierProof();
