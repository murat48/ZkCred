import { NextRequest, NextResponse } from "next/server";
import { scoreBorrower } from "@/lib/scoring";
import type { BorrowerSignals, ProofType, Quote } from "@/lib/types";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";
// Server-side wallet for x402 payment (lending protocol pays oracle)
const STELLAR_SECRET = process.env.STELLAR_SECRET_KEY;
const X402_MODE = process.env.X402_MODE ?? "mock";

// term/365 simple interest, mirroring on-chain rate_calculator
function totalDue(principal: number, rateBps: number, termDays: number) {
  const interest = Math.floor((principal * rateBps * termDays) / (10_000 * 365));
  return { interest, total: principal + interest };
}

async function loadBuildJson(proofType: string, file: string): Promise<any> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const path = join(process.cwd(), "..", "circuits", `${proofType}_proof`, "build", file);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function loadProof(proofType: string): Promise<object> {
  try {
    return await loadBuildJson(proofType, "proof.json");
  } catch {
    return { demo: true };
  }
}

// Phase-1 anchoring verifies the *real* proof against its real public signals
// (now [flags…, protocol_id, nonce_hi, nonce_lo, expiry] — must match proof.json).
async function loadPublicSignals(proofType: ProofType): Promise<string[]> {
  if (proofType === "none") return [];
  try {
    return (await loadBuildJson(proofType, "public.json")).map(String);
  } catch {
    return [];
  }
}

async function callOracle(
  proofType: ProofType,
  signals: BorrowerSignals,
): Promise<{ data: any; x402_paid: boolean; x402_mode: string; settlement_tx?: string; x402_error?: string }> {
  const proof = proofType !== "none" ? await loadProof(proofType) : null;
  const publicSignals = await loadPublicSignals(proofType);

  const body = JSON.stringify({
    proofType,
    proof: proof ?? { demo: true },
    publicSignals,
    signals,
  });

  const headers = { "content-type": "application/json" };
  let x402_error: string | undefined;

  // --- Real x402 payment via server-side wallet ---
  if (X402_MODE === "live" && STELLAR_SECRET && proofType !== "none") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } = require("@x402/fetch");
      const { createEd25519Signer } = require("@x402/stellar");
      const { ExactStellarScheme } = require("@x402/stellar/exact/client");

      // createEd25519Signer wants the raw secret string + a CAIP-2 network id
      // (it derives the keypair and passphrase internally).
      const signer = createEd25519Signer(STELLAR_SECRET, "stellar:testnet");
      const core = new x402Client().register("stellar:testnet", new ExactStellarScheme(signer));
      // wrapFetchWithPayment returns a fetch that auto-handles the 402 → pay → retry.
      const payFetch = wrapFetchWithPayment(fetch, core);

      const res = await payFetch(`${ORACLE_URL}/evaluate`, {
        method: "POST",
        headers,
        body,
      });

      if (res.ok) {
        const data = await res.json();
        let settlement_tx: string | undefined;
        try {
          const hdr = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
          if (hdr) {
            const settle = decodePaymentResponseHeader(hdr);
            if (settle?.success && settle.transaction) settlement_tx = settle.transaction;
          }
        } catch {
          /* header absent or malformed */
        }
        // payFetch returned 200 — payment was handled. Return oracle data.
        return { data, x402_paid: !!settlement_tx, x402_mode: "live", settlement_tx };
      } else {
        const txt = await res.text().catch(() => "");
        x402_error = `x402 live failed (oracle ${res.status}): ${txt.slice(0, 200)}`;
      }
    } catch (err: any) {
      x402_error = String(err?.message ?? err);
      console.error("[x402 live] payment failed:", err);
    }
  }

  // --- Plain fetch (mock mode, or live-failed fallback) ---
  // In live mode the oracle may return 402 here; that's fine — we already
  // captured x402_error above and the throw below is caught by the outer
  // POST handler which falls back to local scoring.
  const res = await fetch(`${ORACLE_URL}/evaluate`, {
    method: "POST",
    headers,
    body,
    // Phase 1 anchors the proof on-chain (verify_proof: BLS pairing + confirmation
    // polling), which can take tens of seconds — generous timeout so a real oracle
    // result isn't dropped to the local fallback while the anchor settles.
    signal: AbortSignal.timeout(90_000),
  });

  if (res.ok) {
    const data = await res.json();
    return {
      data,
      x402_paid: false,
      x402_mode: x402_error ? "live" : "mock",
      x402_error,
    };
  }

  // Oracle returned non-200 (e.g. 402 in live mode without payment).
  // Propagate x402_error if we have it so the outer catch can surface it.
  throw Object.assign(new Error(`oracle ${res.status}`), { x402_error });
}

// Fetch attestation from oracle for creditworthiness proof type.
// In live mode: pay $0.05 USDC over x402 before the oracle responds.
// Returns { data, x402_paid, x402_mode, settlement_tx? }.
async function fetchAttestation(borrower: string): Promise<{ data: any; x402_paid: boolean; x402_mode: string; settlement_tx?: string; x402_error?: string }> {
  const body = JSON.stringify({ borrower });
  const headers = { "content-type": "application/json" };
  let x402_error: string | undefined;

  if (X402_MODE === "live" && STELLAR_SECRET) {
    try {
      const { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } = require("@x402/fetch");
      const { createEd25519Signer } = require("@x402/stellar");
      const { ExactStellarScheme } = require("@x402/stellar/exact/client");

      const signer = createEd25519Signer(STELLAR_SECRET, "stellar:testnet");
      const core = new x402Client().register("stellar:testnet", new ExactStellarScheme(signer));
      const payFetch = wrapFetchWithPayment(fetch, core);

      const res = await payFetch(`${ORACLE_URL}/attest`, { method: "POST", headers, body });
      if (res.ok) {
        const data = await res.json();
        let settlement_tx: string | undefined;
        try {
          const hdr = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
          if (hdr) {
            const settle = decodePaymentResponseHeader(hdr);
            if (settle?.success && settle.transaction) settlement_tx = settle.transaction;
          }
        } catch { /* no header */ }
        // payFetch returned 200 — payment was handled by wrapFetchWithPayment.
        // Return oracle data regardless of whether we got a settlement receipt.
        return { data, x402_paid: !!settlement_tx, x402_mode: "live", settlement_tx };
      } else {
        const txt = await res.text().catch(() => "");
        x402_error = `x402 live failed (oracle ${res.status}): ${txt.slice(0, 200)}`;
      }
    } catch (err: any) {
      x402_error = String(err?.message ?? err);
    }
  }

  // Plain fetch fallback (mock mode or live-failed)
  const res = await fetch(`${ORACLE_URL}/attest`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw Object.assign(new Error(`attest ${res.status}`), { x402_error });
  const data = await res.json();
  return { data, x402_paid: false, x402_mode: x402_error ? "live" : "mock", x402_error };
}

// Convert creditworthiness tier to rate_bps (mirrors risk_policy on-chain).
function tierToRateBps(tier: number): number {
  if (tier >= 3) return 500;   // PRIME 5%
  if (tier >= 2) return 1000;  // GREEN 10%
  if (tier >= 1) return 2000;  // YELLOW 20%
  return 3000;                 // RED 30% (oracle rejects, fallback)
}

// Credit limit: % of monthly income based on repayment history.
function creditRatio(repaidCount: number): number {
  if (repaidCount === 0) return 0.10;
  if (repaidCount === 1) return 0.15;
  if (repaidCount === 2) return 0.20;
  if (repaidCount <= 4) return 0.25;
  return 0.30;
}

function maxBorrowableUsdc(monthlyIncome: number, repaidCount: number): number {
  // monthly_income from bank is testnet-scaled (÷50 to get raw USDC equivalent)
  const incomeUsdc = monthlyIncome / 50;
  const ratio = creditRatio(repaidCount);
  return Math.floor(incomeUsdc * ratio * 100) / 100;
}

// Resolve term days from loan product selection.
function termDaysFromProduct(product: string, customDays?: number): number {
  if (product === "daily") return Math.min(27, Math.max(1, customDays ?? 7));
  if (product === "monthly") return 30;
  if (product === "installment_3m") return 90;
  return 365; // legacy
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const proofType: ProofType = body.proofType ?? "none";
  const signals: BorrowerSignals = body.signals ?? {};
  const borrower: string | undefined = body.borrower;
  const loanProduct: string = body.loan_product ?? "monthly";
  const customDays: number | undefined = body.custom_days ? Number(body.custom_days) : undefined;
  const termDays: number = termDaysFromProduct(loanProduct, customDays);
  const principal: number = Number(body.principal ?? 100);

  if (!(principal > 0)) {
    return NextResponse.json({ error: "principal must be positive" }, { status: 400 });
  }

  let scoreResult: any;
  let x402_paid = false;
  let x402_mode: string = "mock";
  let settlement_tx: string | undefined;
  let x402_error: string | undefined;
  let attest: any = undefined;

  if (proofType === "none") {
    scoreResult = scoreBorrower({});
  } else if (proofType === "creditworthiness") {
    // Creditworthiness proof: call oracle /attest to get boolean claims + tier.
    // No ZK proof generated yet — proof is generated fresh during /borrow.
    if (!borrower) {
      // No wallet connected — use demo oracle defaults
      scoreResult = scoreBorrower({ income_ok: true, solvency_ok: true });
      scoreResult.tier = 2;
      scoreResult.tier_label = "GREEN";
      scoreResult.trust_score = 65;
      scoreResult.rate_bps = 1000;
      scoreResult.rate_pct = 10;
      scoreResult.has_proof = true;
      scoreResult.proof_valid = true;
      scoreResult.verification_mode = "snarkjs";
      scoreResult.source = "oracle";
    } else {
      try {
        const attestResult = await fetchAttestation(borrower);
        attest = attestResult.data;
        x402_paid = attestResult.x402_paid;
        x402_mode = attestResult.x402_mode;
        settlement_tx = attestResult.settlement_tx;
        x402_error = attestResult.x402_error;

        const tier = attest.tier ?? 0;
        // tier=0 → REJECT: proof is mathematically impossible (hard circuit constraint)
        const rejected = tier === 0;
        const rate_bps = rejected ? 0 : tierToRateBps(tier);
        scoreResult = {
          // trust_score deliberately omitted — creditworthiness uses tier, not a score
          rate_bps,
          rate_pct: rate_bps / 100,
          has_proof: !rejected,
          proof_valid: !rejected,
          verification_mode: "snarkjs",
          source: "oracle",
          tier,
          tier_label: rejected ? "REJECT" : attest.tier_label,
          rejected,
          claims: attest.claims,
        };
      } catch (err: any) {
        scoreResult = scoreBorrower(signals);
        scoreResult.source = "local";
        if (err?.x402_error) x402_error = err.x402_error;
        if (x402_error) x402_mode = "live";
      }
    }
  } else {
    try {
      const result = await callOracle(proofType as ProofType, signals);
      scoreResult = result.data;
      x402_paid = result.x402_paid;
      x402_mode = result.x402_mode;
      settlement_tx = result.settlement_tx;
      x402_error = result.x402_error;
    } catch (err: any) {
      scoreResult = scoreBorrower(signals);
      scoreResult.source = "local";
      if (err?.x402_error) x402_error = err.x402_error;
      if (x402_error) x402_mode = "live";
    }
  }

  // Credit limit — computed by oracle from verified bank data, passed through here.
  const max_borrowable_usdc: number | null = attest?.max_borrowable_usdc ?? null;
  const credit_ratio_pct: number | null = attest?.credit_ratio_pct ?? null;

  // For installment_3m: compute per-installment amount
  const is3Month = loanProduct === "installment_3m";

  const { interest, total } = (scoreResult as any).rejected
    ? { interest: 0, total: 0 }
    : totalDue(principal, scoreResult.rate_bps, termDays);

  const installment_amount = is3Month && total > 0
    ? Math.round((total / 3) * 100) / 100
    : undefined;

  const quote: Quote & {
    x402_paid: boolean;
    x402_mode: string;
    settlement_tx?: string;
    x402_error?: string;
    attest?: any;
    loan_product?: string;
    max_borrowable_usdc?: number | null;
    credit_ratio_pct?: number | null;
    installment_amount?: number;
  } = {
    ...scoreResult,
    proofType,
    source: scoreResult.source ?? "oracle",
    principal,
    term_days: termDays,
    interest,
    total_due: total,
    x402_paid,
    x402_mode,
    settlement_tx,
    x402_error,
    attest,
    loan_product: loanProduct,
    max_borrowable_usdc,
    credit_ratio_pct,
    installment_amount,
  };

  return NextResponse.json(quote);
}
