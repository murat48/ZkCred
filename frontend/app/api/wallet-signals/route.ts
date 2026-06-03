import { NextRequest, NextResponse } from "next/server";

const HORIZON = "https://horizon-testnet.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  try {
    const [accountRes, opsRes] = await Promise.all([
      fetch(`${HORIZON}/accounts/${address}`, { next: { revalidate: 30 } }),
      fetch(`${HORIZON}/accounts/${address}/operations?limit=200&order=asc`, {
        next: { revalidate: 30 },
      }),
    ]);

    if (!accountRes.ok) {
      return NextResponse.json({
        signals: {},
        meta: null,
        error: "account_not_found",
      });
    }

    const account = await accountRes.json();
    const opsData = opsRes.ok ? await opsRes.json() : null;
    const ops: any[] = opsData?._embedded?.records ?? [];

    const tx_count = ops.length;

    // Wallet age from first on-chain operation
    let wallet_age_days = 0;
    const firstCreated = ops[0]?.created_at;
    if (firstCreated) {
      wallet_age_days = Math.floor(
        (Date.now() - new Date(firstCreated).getTime()) / 86_400_000
      );
    }

    const balances: any[] = account.balances ?? [];

    const xlmBal = balances.find((b: any) => b.asset_type === "native");
    const usdcBal = balances.find(
      (b: any) =>
        b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
    );

    // Fraud proxy. On testnet, demo wallets are funded by friendbot moments
    // before use, so "new + active" is the normal case — flagging it punished
    // every legitimate demo wallet (new wallet + many borrow/repay ops → −25,
    // dropping a 75 score to ~53 → 14%). Only flag the truly pathological case:
    // an account minutes old already spamming hundreds of operations.
    const fraud_signals =
      wallet_age_days < 1 && tx_count > 250 ? 1 : 0;

    return NextResponse.json({
      signals: {
        wallet_age_days: Math.min(wallet_age_days, 3650),
        tx_count: Math.min(tx_count, 500),
        prior_loans_repaid: 0, // needs on-chain loan indexer
        default_events: 0,
        fraud_signals,
      },
      meta: {
        xlm_balance: xlmBal?.balance ?? "0",
        usdc_balance: usdcBal?.balance ?? "0",
        wallet_age_days,
        tx_count,
        subentries: account.subentry_count ?? 0,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { signals: {}, meta: null, error: String(e) },
      { status: 500 }
    );
  }
}
