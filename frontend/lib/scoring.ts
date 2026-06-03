// TypeScript mirror of agents/risk_agent/scoring.py — used as the local fallback
// when the x402 Risk Oracle is not running, so the demo always renders a quote.
import type { BorrowerSignals, ScoreResult } from "./types";

export const RATE_TIERS: [number, number][] = [
  [90, 600],
  [80, 800],
  [60, 1000],
  [0, 1400],
];
export const ANONYMOUS_RATE_BPS = 1400;

const W = {
  base: 50,
  income_ok: 12,
  solvency_ok: 13,
  repayment_ok: 15,
  wallet_age: 10,
  activity: 5,
  history: 10,
};
const DEFAULT_PENALTY = 20;
const FRAUD_PENALTY = 25;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function rateBpsForScore(score: number): number {
  for (const [min, bps] of RATE_TIERS) if (score >= min) return bps;
  return ANONYMOUS_RATE_BPS;
}

export function scoreBorrower(s: BorrowerSignals): ScoreResult {
  const hasProof = Boolean(s.income_ok || s.solvency_ok || s.repayment_ok);

  if (!hasProof) {
    return {
      trust_score: 0,
      rate_bps: ANONYMOUS_RATE_BPS,
      rate_pct: ANONYMOUS_RATE_BPS / 100,
      has_proof: false,
      breakdown: { reason: "no_zk_proof" },
      source: "local",
    };
  }

  const b: Record<string, number> = { base: W.base };
  if (s.income_ok) b.income_ok = W.income_ok;
  if (s.solvency_ok) b.solvency_ok = W.solvency_ok;
  if (s.repayment_ok) b.repayment_ok = W.repayment_ok;
  b.wallet_age = +(clamp((s.wallet_age_days ?? 0) / 365, 0, 1) * W.wallet_age).toFixed(2);
  b.activity = +(clamp((s.tx_count ?? 0) / 100, 0, 1) * W.activity).toFixed(2);
  b.history = +(clamp((s.prior_loans_repaid ?? 0) / 5, 0, 1) * W.history).toFixed(2);
  if (s.default_events) b.defaults_penalty = -(s.default_events * DEFAULT_PENALTY);
  if (s.fraud_signals) b.fraud_penalty = -(s.fraud_signals * FRAUD_PENALTY);

  const raw = Object.values(b).reduce((a, c) => a + c, 0);
  const score = Math.round(clamp(raw, 0, 100));
  const bps = rateBpsForScore(score);

  return {
    trust_score: score,
    rate_bps: bps,
    rate_pct: bps / 100,
    has_proof: true,
    breakdown: b,
    source: "local",
  };
}
