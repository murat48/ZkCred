import type { BorrowerSignals, ProofType } from "./types";

export interface Profile {
  id: string;
  name: string;
  blurb: string;
  proofType: ProofType;
  signals: BorrowerSignals;
}

// Demo cast. With creditworthiness proofs the actual signals come from
// oracle /attest (wallet-specific), so these are illustrative only.
export const PROFILES: Profile[] = [
  {
    id: "anonymous",
    name: "User A — Anonymous",
    blurb: "No ZK proof. The protocol knows nothing, so it prices for worst-case risk.",
    proofType: "none",
    signals: {},
  },
  {
    id: "creditworthiness",
    name: "User B — Creditworthiness Proof",
    blurb:
      "Proves 5 financial thresholds (income, loans, DTI, employment, no defaults) without revealing a single figure. Tier is computed inside the ZK circuit.",
    proofType: "creditworthiness",
    signals: {},
  },
  {
    id: "solvency",
    name: "User C — ZK Solvency Proof",
    blurb: "Proves income ≥ $3,000/mo and assets/liabilities ≥ 1.5 — without revealing a single figure.",
    proofType: "solvency",
    signals: {
      income_ok: true,
      solvency_ok: true,
      wallet_age_days: 540,
      tx_count: 320,
      prior_loans_repaid: 8,
    },
  },
];
