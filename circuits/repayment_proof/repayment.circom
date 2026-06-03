pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// Repayment proof — proves a healthy repayment record without revealing history,
// and BINDS the proof to a request context (anti-replay + domain separation).
//
// Public signals (snarkjs order = output first, then public inputs):
//   [0] repayment_ok : 1 iff on_time/total >= 80% AND zero defaults
//   [1] protocol_id  : domain separation — enforced in-circuit to equal zkcredit_pool_v1
//   [2] nonce_hi     : high 128 bits of the 32-byte anti-replay nonce
//   [3] nonce_lo     : low  128 bits of the 32-byte anti-replay nonce
//   [4] expiry       : ledger after which the proof must be rejected
//   [5] borrower_hi  : high 128 bits of SHA-256(borrower StrKey)
//   [6] borrower_lo  : low  128 bits of SHA-256(borrower StrKey)
//
// See solvency.circom for full security rationale.
// This order MUST match lending_pool's public_inputs vector and the repayment
// verifying key's ic layout.
template Repayment() {
    // --- private witness ---
    signal input total_loans;         // > 0
    signal input on_time_repayments;  // <= total_loans
    signal input default_events;      // count of defaults

    // --- public inputs (request context) ---
    signal input protocol_id;
    signal input nonce_hi;
    signal input nonce_lo;
    signal input expiry;
    signal input borrower_hi;   // high 128 bits of SHA-256(borrower G... address)
    signal input borrower_lo;   // low  128 bits of SHA-256(borrower G... address)

    // --- public output ---
    signal output repayment_ok;

    // on_time / total >= 0.8  <=>  on_time*100 >= 80*total  (avoids division)
    component scoreCmp = GreaterEqThan(64);
    scoreCmp.in[0] <== on_time_repayments * 100;
    scoreCmp.in[1] <== 80 * total_loans;

    // defaults must be exactly zero
    component noDefault = IsZero();
    noDefault.in <== default_events;

    // both conditions required (product of two booleans)
    repayment_ok <== scoreCmp.out * noDefault.out;

    // Enforce protocol_id in-circuit (same constant as lending_pool::PROTOCOL_ID).
    protocol_id === 162723408271563627761121128780390168113;

    // Bind variable context signals into R1CS via squaring (Groth16 public inputs
    // are already cryptographically bound via vk_x; squaring prevents optimisation away).
    signal nonceHiSq;    nonceHiSq    <== nonce_hi    * nonce_hi;
    signal nonceLoSq;    nonceLoSq    <== nonce_lo    * nonce_lo;
    signal expirySq;     expirySq     <== expiry      * expiry;
    signal borrowerHiSq; borrowerHiSq <== borrower_hi * borrower_hi;
    signal borrowerLoSq; borrowerLoSq <== borrower_lo * borrower_lo;
}

component main { public [protocol_id, nonce_hi, nonce_lo, expiry, borrower_hi, borrower_lo] } = Repayment();
