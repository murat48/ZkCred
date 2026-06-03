// Update risk_policy tiers to use 0–3 tier scale instead of 0–100 score scale.
// Run once after deploying the tier_proof circuit.
//
//   node --env-file=../../.env set_tiers.mjs
//
// Tier mapping (mirrors tier.circom thresholds + business policy):
//   min_score=3 → 500 bps   (PRIME:  score 80+  → 5% interest)
//   min_score=2 → 1000 bps  (GREEN:  score 60–79 → 10% interest)
//   min_score=1 → 2000 bps  (YELLOW: score 40–59 → 20% interest)
//   min_score=0 → 3000 bps  (RED:    score  0–39 → rejected by oracle)
import "dotenv/config";
import StellarSdk from "./node_modules/@stellar/stellar-sdk/lib/index.js";

const { rpc: RpcClient, TransactionBuilder, Networks, Keypair, Operation, Address, xdr, BASE_FEE } =
  StellarSdk;

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const TIERS = [
  { min_score: 3, rate_bps: 500  }, // PRIME: 5%
  { min_score: 2, rate_bps: 1000 }, // GREEN: 10%
  { min_score: 1, rate_bps: 2000 }, // YELLOW: 20%
  { min_score: 0, rate_bps: 3000 }, // RED: 30% (oracle rejects these, but fallback for anonymous)
];

function tiersToScVal(tiers) {
  return xdr.ScVal.scvVec(
    tiers.map((t) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("min_score"),
          val: xdr.ScVal.scvU32(t.min_score),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("rate_bps"),
          val: xdr.ScVal.scvU32(t.rate_bps),
        }),
      ]),
    ),
  );
}

async function main() {
  const policyId = process.env.RISK_POLICY;
  const secret = process.env.STELLAR_SECRET_KEY; // admin = GDAR
  if (!policyId || !secret) throw new Error("RISK_POLICY and STELLAR_SECRET_KEY required");

  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const kp = Keypair.fromSecret(secret);
  const account = await server.getAccount(kp.publicKey());

  console.log(`Updating risk_policy tiers on ${policyId} as admin ${kp.publicKey()}…`);
  console.table(TIERS);

  const op = Operation.invokeContractFunction({
    contract: policyId,
    function: "set_tiers",
    args: [tiersToScVal(TIERS)],
  });
  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 100),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate set_tiers: ${sim.error}`);

  const prepared = RpcClient.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send: ${JSON.stringify(sent.errorResult ?? sent)}`);

  const hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) {
      console.log(`✓ Tiers updated. tx: ${hash}`);
      return;
    }
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`set_tiers failed on-chain: ${hash}`);
  }
  console.log(`submitted (confirmation pending): ${hash}`);
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
});
