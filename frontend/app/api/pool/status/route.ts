import { NextResponse } from "next/server";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";
const LENDING_POOL = "CAUBK4VA6X3H2Y5I53736RPBREQYC42QIF4QPFZETS6ZHKXYOBCSUKMU";
const PROOF_VERIFIER = "CCGZ4HGNOZ4WKXSTGG6KS6XUAGQ3DEIHZRYWSJBWXVAN4TZG2MWQGNZC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const ADMIN = "GDARDKFBSPKPSL66BR2HJFXBHQJ3XO4WZRN64AC4QTDCAPBM3IMGHPF5";

async function queryPoolLiquidity(): Promise<number | null> {
  const { rpc, TransactionBuilder, Networks, Operation, BASE_FEE, scValToNative } =
    await import("@stellar/stellar-sdk");

  const server = new rpc.Server(RPC_URL, { allowHttp: false });
  const source = await server.getAccount(ADMIN).catch(() => null);
  if (!source) return null;

  const op = Operation.invokeContractFunction({
    contract: LENDING_POOL,
    function: "liquidity",
    args: [],
  });

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;

  const retval = sim.result?.retval;
  if (!retval || retval.switch().name === "scvVoid") return null;

  try {
    const raw = scValToNative(retval);
    return Number(BigInt(raw)) / 1e7;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const [liquidityUsdc] = await Promise.all([
      queryPoolLiquidity(),
    ]);

    return NextResponse.json({
      pool: LENDING_POOL,
      verifier: PROOF_VERIFIER,
      available_usdc: liquidityUsdc,
    });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
