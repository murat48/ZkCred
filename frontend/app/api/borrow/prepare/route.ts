import { NextRequest, NextResponse } from "next/server";
import type { ProofType } from "@/lib/types";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";

// Phase 2, step 1 — the borrower is the user's connected wallet. The oracle
// builds borrow_with_proof (source = user), mints a fresh context-bound proof,
// co-signs the score attestation, and returns the half-signed tx XDR for the
// user to sign in the browser.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const proofType: ProofType = body.proofType ?? "none";
  const trustScore: number = Number(body.trust_score ?? 0);
  const borrower: string = body.borrower;

  if (proofType === "none") {
    return NextResponse.json({ error: "a ZK proof is required to borrow" }, { status: 400 });
  }
  if (!borrower) {
    return NextResponse.json({ error: "connect a wallet to borrow" }, { status: 400 });
  }

  try {
    const res = await fetch(`${ORACLE_URL}/borrow/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofType, trustScore, borrower,
        loan_product: body.loan_product,
        custom_days: body.custom_days,
        amount: body.amount,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ error: data?.error ?? `oracle ${res.status}` }, { status: 502 });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
