import { NextRequest, NextResponse } from "next/server";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.borrower) {
    return NextResponse.json({ error: "borrower required" }, { status: 400 });
  }
  try {
    const res = await fetch(`${ORACLE_URL}/demo/fund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ borrower: body.borrower }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: String(err.message ?? err) }, { status: 500 });
  }
}
