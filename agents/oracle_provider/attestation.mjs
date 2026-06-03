// Attestation layer for creditworthiness_proof circuit.
//
// The oracle does NOT generate financial data. It fetches a signed attestation
// from the MockBank Data Provider, verifies the Ed25519 signature, then uses
// the verified data as ZK witness inputs.
//
// Trust chain:
//   MockBank (port 3002) → sign(financial_data, Ed25519 privKey)
//   Oracle              → verify(signature, bank pubKey) → reject if invalid
//   ZK circuit          → prove thresholds using verified raw values
//   On-chain            → tier stored, raw values never recorded
//
// Production: replace MockBank with Plaid OAuth + signed data payloads,
// or a credit bureau's signed API response. The verification logic is identical.

import { verify as cryptoVerify, createPublicKey } from "node:crypto";

const BANK_URL = process.env.BANK_URL ?? "http://localhost:3002";

// ─── Thresholds — must match creditworthiness.circom exactly ─────────────────
const INCOME_THRESHOLD    = 2000;
const LOANS_THRESHOLD     = 3;
const DTI_THRESHOLD       = 30;
const EMPLOYMENT_THRESHOLD = 12;

export const TIER_LABELS = { 3: "PRIME", 2: "GREEN", 1: "YELLOW", 0: "RED" };

// ─── Bank public key cache ────────────────────────────────────────────────────
// Fetched once from bank /pubkey on first attestation request.
let _bankPubKey = null;
let _bankIssuer = null;

async function getBankPubKey() {
  if (_bankPubKey) return { key: _bankPubKey, issuer: _bankIssuer };

  const res = await fetch(`${BANK_URL}/pubkey`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`MockBank /pubkey unavailable (HTTP ${res.status})`);

  const { pubkey_hex, issuer } = await res.json();
  _bankPubKey = createPublicKey({
    key: Buffer.from(pubkey_hex, "hex"),
    format: "der",
    type: "spki",
  });
  _bankIssuer = issuer ?? "MockBank";
  console.log(`[attest] Bank public key loaded — issuer: ${_bankIssuer}`);
  return { key: _bankPubKey, issuer: _bankIssuer };
}

// ─── Fetch + cryptographic verification ──────────────────────────────────────
export async function getVerifiedFinancialData(walletAddress) {
  const res = await fetch(`${BANK_URL}/financial-data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: walletAddress }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`MockBank /financial-data error (HTTP ${res.status})`);

  const { wallet, data, issued_at, issuer, signature } = await res.json();

  // Reconstruct the exact message the bank signed.
  const message = JSON.stringify({ wallet, data, issued_at, issuer });

  const { key: pubKey, issuer: knownIssuer } = await getBankPubKey();
  const valid = cryptoVerify(
    null,
    Buffer.from(message, "utf8"),
    pubKey,
    Buffer.from(signature, "hex"),
  );

  if (!valid) {
    // Hard stop — do not use unverified financial data as ZK witness.
    throw new Error(
      `[attest] SIGNATURE INVALID for ${walletAddress.slice(0, 8)}… — financial data REJECTED`,
    );
  }

  console.log(`[attest] Signature OK — ${knownIssuer} attested ${wallet.slice(0, 8)}… at ${issued_at}`);
  return { data, issued_at, issuer, signature_verified: true };
}

// ─── Claims evaluation ────────────────────────────────────────────────────────
// Pure function: maps raw financial values to boolean claims + tier.
// Used after signature verification; also re-used by /attest for UI display.
export function evaluateClaims(profile) {
  const {
    monthly_income,
    repaid_loans_count,
    default_count,
    monthly_debt,
    employment_months,
    bills_ok: bills_ok_raw,
  } = profile;

  const income_ok     = monthly_income >= INCOME_THRESHOLD;
  const loans_ok      = repaid_loans_count >= LOANS_THRESHOLD;
  const default_ok    = default_count === 0;
  const dti_pct       = monthly_income > 0 ? (monthly_debt / monthly_income) * 100 : 100;
  const dti_ok        = dti_pct < DTI_THRESHOLD;
  const employment_ok = employment_months >= EMPLOYMENT_THRESHOLD;
  const bills_ok      = Boolean(bills_ok_raw);

  const total = [income_ok, loans_ok, default_ok, dti_ok, employment_ok, bills_ok].filter(Boolean).length;

  // Mirror creditworthiness.circom v4 tier formula:
  //   PRIME  (3) : total == 6  (all criteria including loans_ok)
  //   GREEN  (2) : total == 5  AND loans_ok proven (repayment history unlocks lower rates)
  //   YELLOW (1) : total 5 without loans_ok, OR total 2–4
  //   REJECT (0) : income_ok or default_ok fails (hard circuit constraint)
  let tier;
  if (!income_ok || !default_ok) {
    tier = 0; // REJECT — circuit hard constraint (min_ok = income×default = 1)
  } else if (total >= 6) {
    tier = 3; // PRIME — all 6 criteria
  } else if (total >= 5 && loans_ok) {
    tier = 2; // GREEN — 5 criteria including repayment history
  } else {
    tier = 1; // YELLOW — no repayment history caps at YELLOW
  }

  return {
    claims: { income_ok, loans_ok, default_ok, dti_ok, employment_ok, bills_ok },
    total_criteria: total,
    tier,
    tier_label: TIER_LABELS[tier],
  };
}

// ─── Full attestation pipeline (async) ───────────────────────────────────────
// Returns:
//   profile         — raw financial data (ZK witness only, never sent to frontend)
//   claims          — boolean { income_ok, loans_ok, default_ok, dti_ok, employment_ok }
//   tier / tier_label
//   bank_attestation — { issued_at, issuer, signature_verified: true }
export async function attestWallet(borrowerAddress) {
  const { data, issued_at, issuer, signature_verified } = await getVerifiedFinancialData(borrowerAddress);
  const evaluation = evaluateClaims(data);
  return {
    profile: data,
    ...evaluation,
    bank_attestation: { issued_at, issuer, signature_verified },
  };
}
