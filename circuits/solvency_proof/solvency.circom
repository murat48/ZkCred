pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// Solvency proof — proves financial thresholds without revealing the figures,
// and BINDS the proof to a request context (anti-replay + domain separation).
//
// Public signals (snarkjs order = outputs first, then public inputs):
//   [0] income_ok    : 1 iff monthly_income >= 3000 USDC
//   [1] solvency_ok  : 1 iff total_assets / total_liabilities >= 1.5
//   [2] protocol_id  : domain separation — enforced in-circuit to equal zkcredit_pool_v1
//   [3] nonce_hi     : high 128 bits of the 32-byte anti-replay nonce
//   [4] nonce_lo     : low  128 bits of the 32-byte anti-replay nonce
//   [5] expiry       : ledger after which the proof must be rejected
//   [6] borrower_hi  : high 128 bits of SHA-256(borrower StrKey)
//   [7] borrower_lo  : low  128 bits of SHA-256(borrower StrKey)
//
// Security properties:
//   - protocol_id is constrained to PROTOCOL_ID_CONSTANT in-circuit (not just
//     externally), providing defence-in-depth: a proof generated for a different
//     protocol cannot verify here even if the pool's external check were bypassed.
//   - borrower_hi/lo bind the proof to a specific borrower at the ZK level;
//     lending_pool appends SHA-256(borrower StrKey) as trusted context before
//     calling verify_with_context.
//   - nonce/expiry prevent replay; lending_pool reconstructs them from trusted args.
//
// This order MUST match lending_pool's public_inputs vector and the solvency
// verifying key's ic layout.
template Solvency() {
    // --- private witness (never revealed) ---
    signal input monthly_income;      // integer USDC units
    signal input total_assets;        // integer USDC units
    signal input total_liabilities;   // integer USDC units, > 0

    // --- public inputs (request context) ---
    signal input protocol_id;
    signal input nonce_hi;
    signal input nonce_lo;
    signal input expiry;
    signal input borrower_hi;   // high 128 bits of SHA-256(borrower G... address)
    signal input borrower_lo;   // low  128 bits of SHA-256(borrower G... address)

    // --- public outputs ---
    signal output income_ok;
    signal output solvency_ok;

    // monthly_income >= 3000
    component incCmp = GreaterEqThan(64);
    incCmp.in[0] <== monthly_income;
    incCmp.in[1] <== 3000;
    income_ok <== incCmp.out;

    // assets / liabilities >= 1.5  <=>  2*assets >= 3*liabilities  (avoids division)
    component solvCmp = GreaterEqThan(64);
    solvCmp.in[0] <== 2 * total_assets;
    solvCmp.in[1] <== 3 * total_liabilities;
    solvency_ok <== solvCmp.out;

    // Enforce protocol_id in-circuit. A proof compiled for a different protocol_id
    // fails this constraint, providing defence-in-depth beyond the external check.
    // Value = big-endian "zkcredit_pool_v1" = lending_pool::PROTOCOL_ID.
    protocol_id === 162723408271563627761121128780390168113;

    // Bind the variable context signals into the R1CS via squaring.
    // They are already cryptographically bound as Groth16 public inputs (folded into
    // vk_x), but explicit constraints ensure the compiler cannot optimise them away.
    signal nonceHiSq;    nonceHiSq    <== nonce_hi    * nonce_hi;
    signal nonceLoSq;    nonceLoSq    <== nonce_lo    * nonce_lo;
    signal expirySq;     expirySq     <== expiry      * expiry;
    signal borrowerHiSq; borrowerHiSq <== borrower_hi * borrower_hi;
    signal borrowerLoSq; borrowerLoSq <== borrower_lo * borrower_lo;
}

component main { public [protocol_id, nonce_hi, nonce_lo, expiry, borrower_hi, borrower_lo] } = Solvency();
