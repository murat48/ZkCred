import { NextRequest, NextResponse } from "next/server";
import type { ProofType } from "@/lib/types";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";

// Phase 2 — the borrower approved the quote from /api/quote. The oracle mints a
// fresh, context-bound proof and originates the loan on-chain via
// lending_pool.borrow_with_proof. The client only forwards the circuit + the
// attested score; the proof itself is generated server-side per request.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const proofType: ProofType = body.proofType ?? "none";
  const trustScore: number = Number(body.trust_score ?? 0);

  if (proofType === "none") {
    return NextResponse.json(
      { error: "anonymous borrowers cannot draw an on-chain loan — a ZK proof is required" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${ORACLE_URL}/borrow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofType,
        trustScore,
        loan_product: body.loan_product,
        custom_days: body.custom_days,
        amount: body.amount,
      }),
      // Proof generation + multi-contract tx + BLS pairing + confirmation polling.
    // installment_3m: 3 proofs × ~30s each = up to 5 minutes.
      signal: AbortSignal.timeout(360_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ error: data?.error ?? `oracle ${res.status}` }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
