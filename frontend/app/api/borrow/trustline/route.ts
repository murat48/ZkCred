import { NextRequest, NextResponse } from "next/server";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";

// Does the connected wallet already trust the pool's USDC asset? If not, the
// borrow disbursement would fail, so the UI offers a changeTrust step first.
export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get("account");
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  try {
    const res = await fetch(`${ORACLE_URL}/borrow/trustline?account=${account}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ error: data?.error ?? `oracle ${res.status}` }, { status: 502 });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
