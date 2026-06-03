export type ProofType = "solvency" | "repayment" | "creditworthiness" | "none";

export interface BorrowerSignals {
  income_ok?: boolean;
  solvency_ok?: boolean;
  repayment_ok?: boolean;
  wallet_age_days?: number;
  tx_count?: number;
  prior_loans_repaid?: number;
  default_events?: number;
  fraud_signals?: number;
}

// Creditworthiness claims returned by oracle /attest
// Boolean only — raw financial values are NEVER sent to client.
export interface CreditClaims {
  income_ok: boolean;      // monthly income ≥ $2,000
  loans_ok: boolean;       // repaid loans ≥ 3
  default_ok: boolean;     // zero defaults
  dti_ok: boolean;         // debt-to-income < 30%
  employment_ok: boolean;  // employed ≥ 12 months
  bills_ok: boolean;       // regular bill payments (electricity/water/internet/phone)
}

export interface AttestResult {
  borrower: string;
  claims: CreditClaims;
  total_criteria: number;
  tier: number;
  tier_label: "PRIME" | "GREEN" | "YELLOW" | "RED";
  thresholds: Record<string, string>;
  proof_type: "creditworthiness";
}

export interface ScoreResult {
  trust_score: number;
  rate_bps: number;
  rate_pct: number;
  has_proof: boolean;
  breakdown?: Record<string, number | string>;
  proof_valid?: boolean;
  verification_mode?: string;
  onchain_tx?: string;
  onchain_kind?: "borrow_with_proof" | "verify_proof" | string;
  source: "oracle" | "local";
  tier?: number;
  tier_label?: string;
  claims?: CreditClaims;
}

export interface Quote extends ScoreResult {
  principal: number;
  term_days: number;
  interest: number;
  total_due: number;
  proofType?: string;
  x402_paid?: boolean;
  x402_mode?: string;
  settlement_tx?: string;
  x402_error?: string;
  // creditworthiness-specific
  attest?: AttestResult;
}
