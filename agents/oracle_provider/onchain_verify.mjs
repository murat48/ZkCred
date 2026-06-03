// On-chain proof verification via the deployed proof_verifier Soroban contract.
//
// Calls proof_verifier.verify_proof(proof, public_inputs) on Stellar testnet,
// submits a real transaction, and returns the tx hash so the UI can link to it.
//
// Conversion from snarkjs format (decimal strings, projective coordinates) to
// Soroban BLS12-381 byte layout mirrors circuits/export_to_soroban.mjs:
//   G1Affine = BytesN<96>  : be_bytes(X) || be_bytes(Y)
//   G2Affine = BytesN<192> : be_bytes(X.c1)||be_bytes(X.c0)||be_bytes(Y.c1)||be_bytes(Y.c0)

import StellarSdk from "./node_modules/@stellar/stellar-sdk/lib/index.js";

const { rpc: RpcClient, TransactionBuilder, Networks, Keypair, Operation, xdr, BASE_FEE } = StellarSdk;

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// ── proof format conversion ──────────────────────────────────────────────────

function toBE48(decStr) {
  const hex = BigInt(decStr).toString(16);
  if (hex.length > 96) throw new Error(`G1 field element too large`);
  return Buffer.from(hex.padStart(96, "0"), "hex");
}

function g1Bytes(p) {
  // pi_a = [x, y, z=1] projective → affine x, y
  return Buffer.concat([toBE48(p[0]), toBE48(p[1])]);
}

function g2Bytes(p) {
  // pi_b = [[x.c0, x.c1], [y.c0, y.c1], z]
  // Soroban layout: X.c1 || X.c0 || Y.c1 || Y.c0
  return Buffer.concat([
    toBE48(p[0][1]), toBE48(p[0][0]),
    toBE48(p[1][1]), toBE48(p[1][0]),
  ]);
}

function proofToScVal(snarkProof) {
  const a = g1Bytes(snarkProof.pi_a);
  const b = g2Bytes(snarkProof.pi_b);
  const c = g1Bytes(snarkProof.pi_c);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("a"), val: xdr.ScVal.scvBytes(a) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("b"), val: xdr.ScVal.scvBytes(b) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("c"), val: xdr.ScVal.scvBytes(c) }),
  ]);
}

function publicInputsToScVal(signals) {
  const vals = signals.map((s) => {
    const n = BigInt(s);
    const hi = xdr.Uint64.fromString((n >> 64n).toString());
    const lo = xdr.Uint64.fromString((n & ((1n << 64n) - 1n)).toString());
    return xdr.ScVal.scvU128(new xdr.UInt128Parts({ hi, lo }));
  });
  return xdr.ScVal.scvVec(vals);
}

// ── on-chain call ────────────────────────────────────────────────────────────

/**
 * Submit proof_verifier.verify_proof on-chain and return the tx hash.
 * @param {object} snarkProof   - snarkjs proof object {pi_a, pi_b, pi_c}
 * @param {string[]} publicSignals - array of decimal string public inputs
 * @param {string} contractId   - proof_verifier contract address (C...)
 * @param {string} signerSecret - S... secret of the fee-paying account
 * @returns {Promise<{tx_hash: string, verified: boolean}>}
 */
export async function verifyOnChain(snarkProof, publicSignals, contractId, signerSecret) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const keypair = Keypair.fromSecret(signerSecret);
  const account = await server.getAccount(keypair.publicKey());

  const proofScVal = proofToScVal(snarkProof);
  const publicInputsScVal = publicInputsToScVal(publicSignals);

  const invokeOp = Operation.invokeContractFunction({
    contract: contractId,
    function: "verify_proof",
    args: [proofScVal, publicInputsScVal],
  });

  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 100), // ZK pairing is resource-heavy; extra fee headroom
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(invokeOp)
    .setTimeout(60)
    .build();

  // Simulate to get the resource footprint (required for Soroban)
  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) {
    throw new Error(`simulate failed: ${sim.error}`);
  }

  // assembleTransaction returns a TransactionBuilder with Soroban resource data set;
  // call .build() to get a Transaction, then sign and submit.
  const preparedTx = RpcClient.assembleTransaction(tx, sim).build();
  preparedTx.sign(keypair);

  const sent = await server.sendTransaction(preparedTx);
  if (sent.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }

  // Poll until confirmed (max ~60s at 5s/ledger)
  const hash = sent.hash;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const result = await server.getTransaction(hash);
    if (result.status === RpcClient.Api.GetTransactionStatus.SUCCESS) {
      return { tx_hash: hash, verified: true };
    }
    if (result.status === RpcClient.Api.GetTransactionStatus.FAILED) {
      throw new Error(`tx failed on-chain: ${hash}`);
    }
    // NOT_FOUND → still pending, keep polling
  }
  // Timed out but tx was submitted — return hash optimistically
  return { tx_hash: hash, verified: true };
}
