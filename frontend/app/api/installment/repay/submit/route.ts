import { NextRequest, NextResponse } from "next/server";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  try {
    const res = await fetch(`${ORACLE_URL}/installment/repay/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr: body.signedXdr, borrower: body.borrower, slot: body.slot }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ error: data?.error ?? `oracle ${res.status}` }, { status: 502 });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
