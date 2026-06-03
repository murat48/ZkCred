// Rotate the proof_verifier's verifying key on-chain (admin only).
//
// After recompiling a circuit (new public inputs → new VK), run this to point the
// deployed proof_verifier at the new VK without redeploying it. Admin = GDAR
// (STELLAR_SECRET_KEY), which is the verifier's stored Admin.
//
//   node --env-file=../../.env set_vk.mjs <verification_key.json>
//
// Byte layout matches onchain_verify.mjs / export_to_soroban.mjs (validated on-chain):
//   G1Affine = BytesN<96>  : be(X) || be(Y)
//   G2Affine = BytesN<192> : be(X.c1) || be(X.c0) || be(Y.c1) || be(Y.c0)

import { readFileSync } from "node:fs";
import StellarSdk from "./node_modules/@stellar/stellar-sdk/lib/index.js";

const { rpc: RpcClient, TransactionBuilder, Networks, Keypair, Operation, xdr, BASE_FEE } =
  StellarSdk;

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

function toBE48(decStr) {
  const hex = BigInt(decStr).toString(16);
  if (hex.length > 96) throw new Error(`field element too large: ${decStr.slice(0, 20)}…`);
  return Buffer.from(hex.padStart(96, "0"), "hex");
}
const g1 = (p) => Buffer.concat([toBE48(p[0]), toBE48(p[1])]);
const g2 = (p) =>
  Buffer.concat([toBE48(p[0][1]), toBE48(p[0][0]), toBE48(p[1][1]), toBE48(p[1][0])]);

const bytes = (buf) => xdr.ScVal.scvBytes(buf);
const sym = (s) => xdr.ScVal.scvSymbol(s);
const entry = (k, v) => new xdr.ScMapEntry({ key: sym(k), val: v });

function vkToScVal(vk) {
  // contracttype struct → ScMap with keys sorted lexicographically.
  return xdr.ScVal.scvMap([
    entry("alpha", bytes(g1(vk.vk_alpha_1))),
    entry("beta", bytes(g2(vk.vk_beta_2))),
    entry("delta", bytes(g2(vk.vk_delta_2))),
    entry("gamma", bytes(g2(vk.vk_gamma_2))),
    entry("ic", xdr.ScVal.scvVec(vk.IC.map((p) => bytes(g1(p))))),
  ]);
}

async function main() {
  const vkPath = process.argv[2];
  if (!vkPath) throw new Error("usage: set_vk.mjs <verification_key.json>");
  const verifierId = process.env.PROOF_VERIFIER;
  const secret = process.env.STELLAR_SECRET_KEY;
  if (!verifierId || !secret) throw new Error("PROOF_VERIFIER and STELLAR_SECRET_KEY required");

  const vk = JSON.parse(readFileSync(vkPath, "utf8"));
  console.log(`Rotating VK on ${verifierId} (IC len ${vk.IC.length}) as admin…`);

  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const kp = Keypair.fromSecret(secret);
  const account = await server.getAccount(kp.publicKey());

  const op = Operation.invokeContractFunction({
    contract: verifierId,
    function: "set_vk",
    args: [vkToScVal(vk)],
  });
  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 100),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate set_vk: ${sim.error}`);

  const prepared = RpcClient.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send: ${JSON.stringify(sent.errorResult ?? sent)}`);

  const hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) {
      console.log(`✓ VK rotated. tx: ${hash}`);
      return;
    }
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`set_vk failed on-chain: ${hash}`);
  }
  console.log(`submitted (confirmation pending): ${hash}`);
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
});
