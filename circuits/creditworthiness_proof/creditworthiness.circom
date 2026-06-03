pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";

// Private Creditworthiness Proof — v2 (6-criteria)
//
// Proves a borrower meets lending thresholds WITHOUT revealing any raw financial data.
// The lender learns only the tier (PRIME/GREEN/YELLOW) — never salary, debt, or history.
//
// Private inputs (NEVER leaves the user's device):
//   monthly_income       : gross income in USD (e.g. 3200)
//   repaid_loans_count   : number of successfully repaid loans (e.g. 5)
//   default_count        : number of loan defaults (e.g. 0)
//   monthly_debt         : total monthly debt obligations in USD (e.g. 700)
//   employment_months    : months continuously employed (e.g. 18)
//   bills_ok             : 1 if regular bill payments detected, 0 otherwise
//
// Public outputs/inputs (visible on-chain — NO financial data):
//   tier                 : 1=YELLOW, 2=GREEN, 3=PRIME
//   protocol_id          : domain separation (cross-protocol replay prevention)
//   nonce_hi / nonce_lo  : 256-bit anti-replay nonce split into two 128-bit limbs
//   expiry               : ledger sequence after which this proof is invalid
//   borrower_hi / lo     : SHA-256(borrower Stellar address) split into 128-bit limbs
//
// Creditworthiness thresholds (6 criteria):
//   income_ok       : monthly_income >= 2000
//   loans_ok        : repaid_loans_count >= 3
//   default_ok      : default_count == 0   (HARD — included in min barrier)
//   dti_ok          : monthly_debt * 100 < monthly_income * 30  (<30% DTI)
//   employment_ok   : employment_months >= 12
//   bills_ok        : regular bill payments (electricity/water/internet/phone) detected
//
// Tier assignment (total = sum of 6 passing criteria):
//   PRIME  (3) : all 6 criteria pass
//   GREEN  (2) : 5 criteria pass
//   YELLOW (1) : 2–4 criteria pass (minimum viable)
//
// Minimum barrier (hard constraint):
//   income_ok AND default_ok must BOTH be 1.
//   loans_ok is a tier criterion only — new borrowers start at YELLOW and build history.
//
// Public signals order (matches lending_pool public_inputs vector):
//   [0] tier      — 1/2/3 (YELLOW/GREEN/PRIME)
//   [1] max_loan  — credit limit in stroops, DERIVED from income×tier_ratio (not oracle-chosen)
//   [2] protocol_id
//   [3] nonce_hi
//   [4] nonce_lo
//   [5] expiry
//   [6] borrower_hi
//   [7] borrower_lo
//
// IC length = 9 (8 public signals + gamma_abc[0]).
// Contract reads max_loan from public_inputs[1] — cryptographically enforced limit.

template CreditworthinessProof() {

    // ─── Private Inputs (financial data — NEVER revealed) ──────────────────────
    signal input monthly_income;       // USD, e.g. 3200
    signal input repaid_loans_count;   // integer, e.g. 5
    signal input default_count;        // integer, e.g. 0
    signal input monthly_debt;         // USD monthly obligations, e.g. 700
    signal input employment_months;    // integer, e.g. 18
    signal input bills_ok;             // 1 = regular bills paid, 0 = not detected

    // ─── Public Inputs (request context — visible on-chain) ────────────────────
    signal input protocol_id;
    signal input nonce_hi;
    signal input nonce_lo;
    signal input expiry;
    signal input borrower_hi;
    signal input borrower_lo;

    // ─── Public Outputs ─────────────────────────────────────────────────────────
    signal output tier;                // 1=YELLOW, 2=GREEN, 3=PRIME
    signal output max_loan;            // credit limit in USDC stroops (1e7 per USDC)
                                       // computed deterministically from monthly_income × tier_ratio
                                       // prover cannot inflate it — circuit enforces the derivation

    // ─── 1. Threshold Checks ────────────────────────────────────────────────────

    // income >= 2000  (15-bit: supports $0–$32,767)
    component chkIncome = GreaterEqThan(15);
    chkIncome.in[0] <== monthly_income;
    chkIncome.in[1] <== 2000;

    // repaid_loans >= 3  (5-bit: supports 0–31)
    component chkLoans = GreaterEqThan(5);
    chkLoans.in[0] <== repaid_loans_count;
    chkLoans.in[1] <== 3;

    // default_count == 0  (IsZero returns 1 if input is 0)
    component chkDefault = IsZero();
    chkDefault.in <== default_count;

    // DTI < 30%:  monthly_debt * 100 < monthly_income * 30
    // Avoids floating-point division; both sides bounded by ~$600k < 2^20.
    signal dti_lhs <== monthly_debt * 100;
    signal dti_rhs <== monthly_income * 30;
    component chkDTI = LessThan(21);   // 21-bit: supports products up to ~2M
    chkDTI.in[0] <== dti_lhs;
    chkDTI.in[1] <== dti_rhs;

    // employment >= 12 months  (7-bit: supports 0–127)
    component chkEmploy = GreaterEqThan(7);
    chkEmploy.in[0] <== employment_months;
    chkEmploy.in[1] <== 12;

    // bills_ok must be binary (0 or 1)
    bills_ok * (bills_ok - 1) === 0;

    // ─── 2. Minimum Barrier (Hard Constraint) ───────────────────────────────────
    // income_ok AND default_ok are BOTH required for any tier.
    // loans_ok is a tier criterion only — new borrowers without history start at
    // YELLOW tier and build credit by repaying. This avoids the cold-start problem.
    //
    // Hard barriers (cryptographic — proof impossible if either fails):
    //   income_ok : monthly income ≥ $2,000 (you must be able to repay)
    //   default_ok : zero defaults (previous defaults permanently bar new loans)
    signal min_ok <== chkIncome.out * chkDefault.out;
    min_ok === 1;

    // ─── 3. Count Passing Criteria (6 total) ────────────────────────────────────
    signal sum1 <== chkIncome.out + chkLoans.out;
    signal sum2 <== sum1 + chkDefault.out;
    signal sum3 <== sum2 + chkDTI.out;
    signal sum4 <== sum3 + chkEmploy.out;
    signal total_criteria <== sum4 + bills_ok;
    // After min_ok constraint: total_criteria ∈ {2, 3, 4, 5, 6}

    // ─── 4. Tier Computation ────────────────────────────────────────────────────
    // PRIME (3) ← all 6 criteria pass (including loans_ok)
    component is6 = IsEqual();
    is6.in[0] <== total_criteria;
    is6.in[1] <== 6;

    // GREEN (2) ← total == 5 AND loans_ok is proven
    // Repayment history is required to unlock the best rates — without it,
    // the borrower is capped at YELLOW regardless of other criteria.
    // is5_with_loans: borrower has 5 criteria AND a proven repayment track record.
    component is5 = IsEqual();
    is5.in[0] <== total_criteria;
    is5.in[1] <== 5;
    signal is5_with_loans <== is5.out * chkLoans.out;

    // YELLOW (1) ← everything else:
    //   • total 5 but loans_ok = 0 (no repayment history → capped at YELLOW)
    //   • total 2–4 regardless of loans_ok
    //
    // tier = is6*2 + is5_with_loans + 1:
    //   total=6, loans=1 → 2+0+1 = 3 (PRIME)
    //   total=5, loans=1 → 0+1+1 = 2 (GREEN)
    //   total=5, loans=0 → 0+0+1 = 1 (YELLOW)  ← no repayment history
    //   total=4           → 0+0+1 = 1 (YELLOW)
    //   total=2,3         → 0+0+1 = 1 (YELLOW)
    tier <== is6.out * 2 + is5_with_loans + 1;

    // ─── 5. Credit Limit (max_loan) ─────────────────────────────────────────────
    // max_loan is a public output computed from monthly_income × tier-dependent ratio.
    // The prover cannot choose it freely — the circuit fixes it to:
    //   PRIME  (3): monthly_income × 60000  (30% of income / 50 scale × 1e7 stroops)
    //   GREEN  (2): monthly_income × 50000  (25%)
    //   YELLOW (1): monthly_income × 20000  (10%)
    //
    // On-chain the contract reads max_loan from public_inputs[1] (not from oracle param).
    // This makes the credit limit cryptographically derived — no one can inflate it.

    // Detect tier for ratio selection
    component isTier3 = IsEqual();
    isTier3.in[0] <== tier;
    isTier3.in[1] <== 3;

    component isTier2 = IsEqual();
    isTier2.in[0] <== tier;
    isTier2.in[1] <== 2;

    // income × tier3 and income × tier2 (non-linear), tier1 derived linearly
    signal income_x_t3 <== monthly_income * isTier3.out;
    signal income_x_t2 <== monthly_income * isTier2.out;
    signal income_x_t1 <== monthly_income - income_x_t3 - income_x_t2;

    // max_loan = income × ratio × 2000  (= income / 50 × ratio/100 × 1e7)
    max_loan <== income_x_t3 * 60000 + income_x_t2 * 50000 + income_x_t1 * 20000;

    // ─── 6. Protocol & Context Binding ──────────────────────────────────────────
    protocol_id === 162723408271563627761121128780390168113;

    signal nonceHiSq;    nonceHiSq    <== nonce_hi    * nonce_hi;
    signal nonceLoSq;    nonceLoSq    <== nonce_lo    * nonce_lo;
    signal expirySq;     expirySq     <== expiry      * expiry;
    signal borrowerHiSq; borrowerHiSq <== borrower_hi * borrower_hi;
    signal borrowerLoSq; borrowerLoSq <== borrower_lo * borrower_lo;
}

component main {
    public [protocol_id, nonce_hi, nonce_lo, expiry, borrower_hi, borrower_lo]
} = CreditworthinessProof();
