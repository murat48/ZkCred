// Full on-chain zkCredit pipeline via lending_pool.borrow_with_proof.
//
// One transaction fans out across four contracts:
//   lending_pool.borrow_with_proof
//     → proof_verifier.verify_with_context  (BLS12-381 pairing + anti-replay nonce + event)
//     → risk_policy.rate_bps                (trust score → interest tier)
//     → rate_calculator.total_due           (personalised repayment amount)
//     → USDC.transfer                       (pool → borrower)
//     → emits "loan_new" event + writes Loan state
//
// Proof byte conversion mirrors circuits/export_to_soroban.mjs (validated against
// soroban_artifacts.json).

import StellarSdk from "./node_modules/@stellar/stellar-sdk/lib/index.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { rpc: RpcClient, TransactionBuilder, Networks, Keypair, Operation, Address, xdr, BASE_FEE, authorizeEntry, scValToNative, StrKey } =
  StellarSdk;

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "../../circuits");

// Must match lending_pool::PROTOCOL_ID (big-endian "zkcredit_pool_v1").
const PROTOCOL_ID = 162723408271563627761121128780390168113n;

// Maps circuit tier output to credit ratio (mirrors server.mjs creditRatio).
// YELLOW (1) = first-time borrowers → 10%, GREEN (2) → 25%, PRIME (3) → 30%.
function creditRatioFromTier(tier) {
  if (tier >= 3) return 0.30; // PRIME
  if (tier >= 2) return 0.25; // GREEN
  return 0.10;                // YELLOW (first loan)
}

// Per circuit: build artifacts + how many leading public signals are the flag
// outputs (the rest are the bound context the pool appends). Private witness is
// read from input.example.json (demo financials).
const CIRCUITS = {
  solvency: { dir: "solvency_proof", name: "solvency", numFlags: 2 },
  repayment: { dir: "repayment_proof", name: "repayment", numFlags: 1 },
  // tier_proof: legacy — takes a single trust score as private input.
  tier: { dir: "tier_proof", name: "tier", numFlags: 1 },
  // creditworthiness_proof: takes 5 financial attributes as PRIVATE inputs.
  // Proves: income≥2000, loans≥3, defaults=0, DTI<30%, employment≥12mo.
  // Only the tier (1–3) appears on-chain — no salary, debt, or history revealed.
  // numFlags: 2 — circuit outputs [tier, max_loan] as public signals.
  // max_loan is cryptographically derived from income × tier_ratio inside the circuit.
  creditworthiness: { dir: "creditworthiness_proof", name: "creditworthiness", numFlags: 2 },
};
const CONTEXT_FIELDS = ["protocol_id", "nonce_hi", "nonce_lo", "expiry", "borrower_hi", "borrower_lo"];

// Compute SHA-256(borrowerStrKey) split into two u128 BigInt limbs (big-endian).
// Must match what lending_pool appends as borrower_hi / borrower_lo context.
import { createHash } from "node:crypto";
function borrowerLimbs(borrowerAddress) {
  const hash = createHash("sha256").update(borrowerAddress, "utf8").digest();
  const hi = BigInt("0x" + hash.slice(0, 16).toString("hex"));
  const lo = BigInt("0x" + hash.slice(16, 32).toString("hex"));
  return { hi, lo };
}

// Generate a FRESH proof bound to this request's context (nonce/expiry/protocol/borrower).
// Returns the snarkjs proof + the flag-only public signals the pool expects.
//
// witnessOverrides: optional private inputs that override the example.json defaults.
// For the tier circuit, pass { score: "45" } so each borrower's real score drives the proof.
async function generateProof(proofType, nonceBuf, expiryLedger, borrowerAddress, witnessOverrides = {}) {
  const meta = CIRCUITS[proofType];
  if (!meta) throw new Error(`unknown proofType: ${proofType}`);
  const base = join(CIRCUITS_DIR, meta.dir, "build");
  const wasm = join(base, `${meta.name}_js`, `${meta.name}.wasm`);
  const zkey = join(base, `${meta.name}_final.zkey`);

  // Base private witness from example.json (strip context fields).
  const example = JSON.parse(
    readFileSync(join(CIRCUITS_DIR, meta.dir, "input.example.json"), "utf8"),
  );
  const witness = {};
  for (const [k, v] of Object.entries(example)) {
    if (!CONTEXT_FIELDS.includes(k)) witness[k] = v;
  }
  // Apply caller overrides — e.g. the real AI trust score for the tier circuit.
  // This is what makes the ZK proof wallet-specific: different borrowers produce
  // different tier outputs because their actual scores drive the private witness.
  Object.assign(witness, witnessOverrides);

  const nonceHi = BigInt("0x" + nonceBuf.subarray(0, 16).toString("hex"));
  const nonceLo = BigInt("0x" + nonceBuf.subarray(16, 32).toString("hex"));
  const { hi: borrowerHi, lo: borrowerLo } = borrowerLimbs(borrowerAddress);

  const input = {
    ...witness,
    protocol_id: PROTOCOL_ID.toString(),
    nonce_hi: nonceHi.toString(),
    nonce_lo: nonceLo.toString(),
    expiry: String(expiryLedger),
    borrower_hi: borrowerHi.toString(),
    borrower_lo: borrowerLo.toString(),
  };

  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const flags = publicSignals.slice(0, meta.numFlags);
  return { proof, publicSignals, flags };
}

// ── proof → ScVal conversion ─────────────────────────────────────────────────

function toBE48(decStr) {
  const hex = BigInt(decStr).toString(16);
  if (hex.length > 96) throw new Error("G1/G2 field element too large");
  return Buffer.from(hex.padStart(96, "0"), "hex");
}
const g1Bytes = (p) => Buffer.concat([toBE48(p[0]), toBE48(p[1])]);
const g2Bytes = (p) =>
  Buffer.concat([toBE48(p[0][1]), toBE48(p[0][0]), toBE48(p[1][1]), toBE48(p[1][0])]);

function proofToScVal(snarkProof) {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("a"), val: xdr.ScVal.scvBytes(g1Bytes(snarkProof.pi_a)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("b"), val: xdr.ScVal.scvBytes(g2Bytes(snarkProof.pi_b)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("c"), val: xdr.ScVal.scvBytes(g1Bytes(snarkProof.pi_c)) }),
  ]);
}

const u128ScVal = (v) => {
  const n = BigInt(v);
  return xdr.ScVal.scvU128(
    new xdr.UInt128Parts({
      hi: xdr.Uint64.fromString((n >> 64n).toString()),
      lo: xdr.Uint64.fromString((n & ((1n << 64n) - 1n)).toString()),
    }),
  );
};
const publicInputsToScVal = (signals) => xdr.ScVal.scvVec(signals.map((s) => u128ScVal(s)));

const i128ScVal = (v) => {
  const n = BigInt(v);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString((n >> 64n).toString()),
      lo: xdr.Uint64.fromString((n & ((1n << 64n) - 1n)).toString()),
    }),
  );
};

// ── tx helpers ───────────────────────────────────────────────────────────────

async function invoke(server, keypair, contractId, fn, args) {
  const account = await server.getAccount(keypair.publicKey());
  const op = Operation.invokeContractFunction({ contract: contractId, function: fn, args });
  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 1000), // multi-contract + BLS pairing is resource-heavy
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate ${fn}: ${sim.error}`);

  const prepared = RpcClient.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send ${fn}: ${JSON.stringify(sent.errorResult ?? sent)}`);

  const hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) return { hash, result: res };
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`${fn} failed on-chain: ${hash}`);
  }
  return { hash, result: null }; // submitted; confirmation timed out
}

// Invoke a contract fn that needs TWO independent authorizers.
//
// Security model: lending_pool.borrow_with_proof requires BOTH borrower.require_auth()
// and oracle.require_auth(). They MUST be different keys — otherwise a borrower
// could self-attest any trust_score. Soroban's require_auth binds the exact call
// arguments (incl. trust_score), so the oracle's signature is a tamper-proof
// attestation of the score it computed off-chain.
//
// The oracle (GDAR) is the fee-paying source account → its require_auth is covered
// by the envelope signature. The borrower (GAKP) is a different key → its auth entry
// must be signed separately with authorizeEntry. Any address-credential entry is
// signed by whichever of the two keys owns that address.
async function invokeDualAuth(server, oracleKp, borrowerKp, contractId, fn, args) {
  const source = await server.getAccount(oracleKp.publicKey());
  const op = Operation.invokeContractFunction({ contract: contractId, function: fn, args });
  const tx = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 1000),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate ${fn}: ${sim.error}`);

  const ll = await server.getLatestLedger();
  const validUntil = ll.sequence + 100;
  const signers = {
    [borrowerKp.publicKey()]: borrowerKp,
    [oracleKp.publicKey()]: oracleKp,
  };

  // Sign each address-credential auth entry with the key that owns the address.
  // Source-account-credential entries (the oracle, as fee source) need no entry
  // signature — the tx envelope signature covers them.
  const rawEntries = sim.result?.auth ?? [];
  const signedEntries = [];
  for (const entry of rawEntries) {
    if (entry.credentials().switch().name === "sorobanCredentialsAddress") {
      const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
      const kp = signers[addr];
      if (kp) {
        signedEntries.push(await authorizeEntry(entry, kp, validUntil, NETWORK_PASSPHRASE));
        continue;
      }
    }
    signedEntries.push(entry);
  }

  // Rebuild with the signed auth + the simulated footprint. Re-fetch the source
  // account: the first .build() above already consumed a sequence number.
  const source2 = await server.getAccount(oracleKp.publicKey());
  const fee = (BigInt(Number(BASE_FEE) * 1000) + BigInt(sim.minResourceFee ?? "0")).toString();
  const prepared = new TransactionBuilder(source2, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth: signedEntries }),
    )
    .setSorobanData(sim.transactionData.build())
    .setTimeout(120)
    .build();
  prepared.sign(oracleKp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send ${fn}: ${JSON.stringify(sent.errorResult ?? sent)}`);

  const hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) return { hash, result: res };
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`${fn} failed on-chain: ${hash}`);
  }
  return { hash, result: null };
}

/**
 * Phase-1 on-chain anchor. Generates a fresh per-request proof and calls
 * proof_verifier.verify_with_context (not verify_proof) so the nonce is burned
 * and the same proof can never be replayed. Each quote creates a unique,
 * non-replayable on-chain record that the borrower qualifies.
 *
 * @returns {Promise<{tx_hash: string}>}
 */
export async function anchorProof({ proofType, verifierId, signerSecret }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const kp = Keypair.fromSecret(signerSecret);

  const ll = await server.getLatestLedger();
  const expiryLedger = ll.sequence + 2000;
  const nonceBuf = randomBytes(32);

  const { proof, flags } = await generateProof(proofType, nonceBuf, expiryLedger, kp.publicKey());

  // Build the same full public_inputs the pool would build:
  // [flags…, protocol_id, nonce_hi, nonce_lo, expiry]
  const nonceHi = BigInt("0x" + nonceBuf.subarray(0, 16).toString("hex"));
  const nonceLo = BigInt("0x" + nonceBuf.subarray(16, 32).toString("hex"));
  const fullInputs = [
    ...flags.map(BigInt),
    PROTOCOL_ID,
    nonceHi,
    nonceLo,
    BigInt(expiryLedger),
  ];

  const args = [
    proofToScVal(proof),
    publicInputsToScVal(fullInputs.map(String)),
    xdr.ScVal.scvBytes(nonceBuf),
    xdr.ScVal.scvU32(expiryLedger),
  ];

  const account = await server.getAccount(kp.publicKey());
  const op = Operation.invokeContractFunction({
    contract: verifierId,
    function: "verify_with_context",
    args,
  });
  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 100),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate anchor: ${sim.error}`);

  const prepared = RpcClient.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send anchor: ${JSON.stringify(sent.errorResult ?? sent)}`);

  const hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) return { tx_hash: hash };
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`anchor failed on-chain: ${hash}`);
  }
  return { tx_hash: hash };
}

// Read the borrower's active loan (returns null if none).
export async function queryActiveLoan(poolId, borrower) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  // We need any funded account as the fee-source for simulation; use the RPC
  // directly via a throwaway account. getActiveLoan already handles this by
  // accepting an arbitrary keypair as the fee source, so we reuse it with a
  // fresh server instance — but here we just need any loaded account.
  // Simplest: derive a stable dummy from the pool address bytes.
  // Actually simpler: just pass the borrower address itself.
  const source = await server.getAccount(borrower).catch(() => null);
  if (!source) return null;
  const op = Operation.invokeContractFunction({
    contract: poolId,
    function: "get_loan",
    args: [new Address(borrower).toScVal()],
  });
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) return null;
  const retval = sim.result?.retval;
  if (!retval || retval.switch().name === "scvVoid") return null;
  try {
    return scValToNative(retval);
  } catch {
    return { _present: true };
  }
}

// Build a repay tx with SOURCE = the borrower (user wallet).
// repay() calls borrower.require_auth() which the envelope signature satisfies,
// so no separate oracle signature is needed.
export async function prepareRepay({ borrower, poolId }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const loan = await queryActiveLoan(poolId, borrower);
  if (!loan) throw new Error("no active loan for this account");

  const totalDue = BigInt(loan.total_due ?? 0);
  const repaid = BigInt(loan.repaid ?? 0);
  const outstanding = totalDue - repaid;
  if (outstanding <= 0n) throw new Error("loan already fully repaid");

  const source = await server.getAccount(borrower);
  const op = Operation.invokeContractFunction({
    contract: poolId,
    function: "repay",
    args: [new Address(borrower).toScVal(), i128ScVal(outstanding)],
  });
  const tx = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 500),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate repay: ${sim.error}`);

  // assembleTransaction copies the simulation footprint, resource fee, AND auth
  // entries (including the sorobanCredentialsSourceAccount entry for the borrower).
  // The source-account credential is satisfied by the envelope signature the user
  // adds in their wallet — no separate signing needed here.
  const assembled = RpcClient.assembleTransaction(tx, sim).build();

  return {
    xdr: assembled.toXDR(),
    borrower,
    outstanding: outstanding.toString(),
    outstanding_usdc: Number(outstanding) / 1e7,
  };
}

// Submit a user-signed repay tx and wait for confirmation.
export async function submitRepay({ signedXdr }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send repay: ${JSON.stringify(sent.errorResult ?? sent)}`);
  const hash = sent.hash;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) return { tx_hash: hash };
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`repay failed on-chain: ${hash}`);
  }
  return { tx_hash: hash };
}

// Query all 3 installment slots for a borrower.
// Returns array of 3 items: null (slot empty) or Loan object.
export async function queryInstallmentLoans(poolId, borrower) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const source = await server.getAccount(borrower).catch(() => null);
  if (!source) return [null, null, null];
  const op = Operation.invokeContractFunction({
    contract: poolId,
    function: "get_installment_loans",
    args: [new Address(borrower).toScVal()],
  });
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) return [null, null, null];
  const retval = sim.result?.retval;
  if (!retval || retval.switch().name === "scvVoid") return [null, null, null];
  try {
    const raw = scValToNative(retval); // Vec<Option<Loan>>
    // raw is an array of 3 items; each is either null/undefined or a Loan map
    return [0, 1, 2].map(i => {
      const item = raw[i];
      if (!item) return null;
      return item;
    });
  } catch {
    return [null, null, null];
  }
}

// Build a repay_installment tx with SOURCE = borrower.
// repay_installment() only calls borrower.require_auth() — no oracle sig needed.
export async function prepareRepayInstallment({ borrower, slot, poolId }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const loans = await queryInstallmentLoans(poolId, borrower);
  const loan = loans[slot];
  if (!loan) throw new Error(`no active installment loan at slot ${slot}`);

  const totalDue = BigInt(loan.total_due ?? 0);
  const repaid = BigInt(loan.repaid ?? 0);
  const outstanding = totalDue - repaid;
  if (outstanding <= 0n) throw new Error(`slot ${slot} already fully repaid`);

  const source = await server.getAccount(borrower);
  const op = Operation.invokeContractFunction({
    contract: poolId,
    function: "repay_installment",
    args: [
      new Address(borrower).toScVal(),
      xdr.ScVal.scvU32(slot),
      i128ScVal(outstanding),
    ],
  });
  const tx = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 500),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate repay_installment: ${sim.error}`);
  const assembled = RpcClient.assembleTransaction(tx, sim).build();

  return {
    xdr: assembled.toXDR(),
    borrower,
    slot,
    outstanding: outstanding.toString(),
    outstanding_usdc: Number(outstanding) / 1e7,
  };
}

async function getActiveLoan(server, keypair, poolId, borrower) {
  const account = await server.getAccount(keypair.publicKey());
  const op = Operation.invokeContractFunction({
    contract: poolId,
    function: "get_loan",
    args: [new Address(borrower).toScVal()],
  });
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) return null;
  const retval = sim.result?.retval;
  // Loan is Some(...) → scvMap/instance; None → scvVoid
  if (!retval || retval.switch().name === "scvVoid") return null;
  // Decode to a plain object so callers can read total_due / repaid.
  try {
    return scValToNative(retval);
  } catch {
    return { _present: true }; // present but undecodable — caller treats as active
  }
}

/**
 * Run the full pipeline on-chain. Repays any active loan first so the demo is
 * repeatable, then originates a fresh loan against the ZK proof.
 *
 * Two distinct keys sign every loan: the `borrower` (receives the USDC) and the
 * `oracle` (attests the trust_score, pays fees). The contract enforces both via
 * require_auth, so the score cannot be forged by the borrower alone.
 *
 * @returns {Promise<{tx_hash: string, repaid_first: boolean, borrower: string, oracle: string}>}
 */
export async function borrowWithProof({
  proofType,
  trustScore,
  rawScore,        // tier circuit: private AI score
  rawAttestation,  // creditworthiness circuit: private financial attributes
  amount,
  termDays,
  poolId,
  oracleSecret,
  borrowerSecret,
}) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const oracleKp = Keypair.fromSecret(oracleSecret);
  const borrowerKp = Keypair.fromSecret(borrowerSecret);
  const borrower = borrowerKp.publicKey();

  if (borrower === oracleKp.publicKey()) {
    throw new Error(
      "borrower and oracle must be different keys — same key voids the score attestation",
    );
  }

  // Keep the demo repeatable: clear any active loan before borrowing again.
  // repay() requires the borrower's auth, so it also goes through dual-auth.
  let repaid_first = false;
  const active = await getActiveLoan(server, oracleKp, poolId, borrower);
  if (active) {
    // Pay exactly the outstanding balance (total_due − repaid), not a flat
    // multiple — otherwise the borrower is over-charged. Fall back to a generous
    // amount only if the loan couldn't be decoded; the contract caps it anyway.
    let payAmount;
    try {
      const totalDue = BigInt(active.total_due ?? 0);
      const repaid = BigInt(active.repaid ?? 0);
      const outstanding = totalDue - repaid;
      payAmount = outstanding > 0n ? outstanding : BigInt(amount);
    } catch {
      payAmount = BigInt(amount) * 4n;
    }
    await invokeDualAuth(server, oracleKp, borrowerKp, poolId, "repay", [
      new Address(borrower).toScVal(),
      i128ScVal(payAmount),
    ]);
    repaid_first = true;
  }

  const ll = await server.getLatestLedger();
  const expiryLedger = ll.sequence + 2000; // ~2.7h headroom
  const nonceBuf = randomBytes(32);

  // Inject wallet-specific private witness:
  //   creditworthiness: 5 financial attributes (income, loans, defaults, debt, employment)
  //   tier (legacy): single trust score
  //   other circuits: use example.json financials as-is
  const witnessOverrides =
    (proofType === "creditworthiness" && rawAttestation != null)
      ? {
          monthly_income:      String(rawAttestation.monthly_income),
          repaid_loans_count:  String(rawAttestation.repaid_loans_count),
          default_count:       String(rawAttestation.default_count),
          monthly_debt:        String(rawAttestation.monthly_debt),
          employment_months:   String(rawAttestation.employment_months),
          bills_ok:            String(rawAttestation.bills_ok ?? 0),
        }
      : (proofType === "tier" && rawScore != null)
      ? { score: String(rawScore) }
      : {};

  const { proof, flags } = await generateProof(proofType, nonceBuf, expiryLedger, borrower, witnessOverrides);

  // Use the tier value the circuit actually computed (flags[0]) as trust_score.
  const contractTrustScore = proofType === "tier" ? Number(flags[0]) : trustScore;

  const args = [
    new Address(borrower).toScVal(),               // borrower
    i128ScVal(amount),                             // amount
    xdr.ScVal.scvU32(termDays),                    // term_days
    proofToScVal(proof),                           // proof
    publicInputsToScVal(flags),                    // flags = [tier, max_loan] — circuit-computed
    xdr.ScVal.scvU32(contractTrustScore),          // tier (trust_score for rate lookup)
    xdr.ScVal.scvBytes(nonceBuf),                  // nonce
    xdr.ScVal.scvU32(expiryLedger),                // expiry_ledger
    // max_loan is NO LONGER a parameter — contract reads it from public_inputs[1]
  ];

  const { hash } = await invokeDualAuth(server, oracleKp, borrowerKp, poolId, "borrow_with_proof", args);
  return { tx_hash: hash, repaid_first, borrower, oracle: oracleKp.publicKey(), expiry_ledger: expiryLedger };
}

/**
 * 3-month installment borrow: creates 3 independent on-chain loan slots (0, 1, 2).
 * Each slot holds amount/3 with term_days=30. Generates a fresh ZK proof per slot.
 *
 * @returns {Promise<{installments: [{slot, tx_hash, amount_stroops}], borrower, oracle}>}
 */
export async function borrowWithProofInstallments({
  proofType,
  trustScore,
  rawAttestation,
  amount,       // total amount in stroops
  poolId,
  oracleSecret,
  borrowerSecret,
}) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const oracleKp = Keypair.fromSecret(oracleSecret);
  const borrowerKp = Keypair.fromSecret(borrowerSecret);
  const borrower = borrowerKp.publicKey();

  if (borrower === oracleKp.publicKey()) {
    throw new Error("borrower and oracle must be different keys");
  }

  const installmentAmount = BigInt(amount) / 3n;
  // Staggered due dates: slot 0 = 30d, slot 1 = 60d, slot 2 = 90d

  const witnessOverrides =
    (proofType === "creditworthiness" && rawAttestation != null)
      ? {
          monthly_income:     String(rawAttestation.monthly_income),
          repaid_loans_count: String(rawAttestation.repaid_loans_count),
          default_count:      String(rawAttestation.default_count),
          monthly_debt:       String(rawAttestation.monthly_debt),
          employment_months:  String(rawAttestation.employment_months),
          bills_ok:           String(rawAttestation.bills_ok ?? 0),
        }
      : {};

  const contractTrustScore = trustScore;
  const installments = [];

  for (let slot = 0; slot < 3; slot++) {
    const ll = await server.getLatestLedger();
    const expiryLedger = ll.sequence + 2000;
    const nonceBuf = randomBytes(32);

    const { proof, flags } = await generateProof(
      proofType, nonceBuf, expiryLedger, borrower, witnessOverrides,
    );

    const args = [
      new Address(borrower).toScVal(),
      xdr.ScVal.scvU32(slot),
      i128ScVal(installmentAmount),
      xdr.ScVal.scvU32(30 * (slot + 1)),
      proofToScVal(proof),
      publicInputsToScVal(flags),
      xdr.ScVal.scvU32(contractTrustScore),
      xdr.ScVal.scvBytes(nonceBuf),
      xdr.ScVal.scvU32(expiryLedger),
    ];

    const { hash } = await invokeDualAuth(
      server, oracleKp, borrowerKp, poolId, "borrow_installment", args,
    );
    installments.push({ slot, tx_hash: hash, amount_stroops: installmentAmount.toString() });
  }

  return { installments, borrower, oracle: oracleKp.publicKey() };
}

// ── Real-wallet borrower flow (user signs in the browser) ────────────────────
//
// Unlike borrowWithProof (demo: backend holds both keys), here the BORROWER is the
// end user's connected wallet. We:
//   1. build borrow_with_proof with SOURCE = the user (so borrower.require_auth is
//      covered by the user's envelope signature — one Freighter popup, no auth-entry
//      juggling),
//   2. mint a fresh context-bound proof,
//   3. sign ONLY the oracle's address-credential auth entry server-side
//      (oracle.require_auth = the trust-score attestation),
//   4. hand the half-signed tx XDR back to the browser for the user to sign+submit.
//
// The user pays the fee (they are the source). The oracle never touches the user's
// key; the user never sees the oracle's. Both required signatures, two parties.

// Prepare a SINGLE borrow_installment slot for user-wallet signing.
// Caller loops over slots 0/1/2, each needing a fresh ZK proof + user signature.
export async function prepareBorrowInstallment({ proofType, trustScore, rawScore, rawAttestation, amount, slot, poolId, oracleSecret, borrower }) {
  const TERM_DAYS = 30 * (slot + 1); // slot 0→30d, slot 1→60d, slot 2→90d
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const oracleKp = Keypair.fromSecret(oracleSecret);
  if (borrower === oracleKp.publicKey()) throw new Error("borrower must differ from oracle");

  const ll = await server.getLatestLedger();
  const expiryLedger = ll.sequence + 2000;
  const nonceBuf = randomBytes(32);

  const witnessOverrides =
    (proofType === "creditworthiness" && rawAttestation != null)
      ? {
          monthly_income:     String(rawAttestation.monthly_income),
          repaid_loans_count: String(rawAttestation.repaid_loans_count),
          default_count:      String(rawAttestation.default_count),
          monthly_debt:       String(rawAttestation.monthly_debt),
          employment_months:  String(rawAttestation.employment_months),
          bills_ok:           String(rawAttestation.bills_ok ?? 0),
        }
      : (proofType === "tier" && rawScore != null) ? { score: String(rawScore) } : {};

  const { proof, flags } = await generateProof(proofType, nonceBuf, expiryLedger, borrower, witnessOverrides);
  const contractTrustScore = (proofType === "tier" || proofType === "creditworthiness") ? Number(flags[0]) : trustScore;

  const args = [
    new Address(borrower).toScVal(),
    xdr.ScVal.scvU32(slot),
    i128ScVal(amount),
    xdr.ScVal.scvU32(TERM_DAYS),
    proofToScVal(proof),
    publicInputsToScVal(flags),
    xdr.ScVal.scvU32(contractTrustScore),
    xdr.ScVal.scvBytes(nonceBuf),
    xdr.ScVal.scvU32(expiryLedger),
  ];

  const source = await server.getAccount(borrower);
  const op = Operation.invokeContractFunction({ contract: poolId, function: "borrow_installment", args });
  const tx = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 1000),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(op).setTimeout(180).build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate borrow_installment slot=${slot}: ${sim.error}`);

  const validUntil = ll.sequence + 200;
  const signedEntries = [];
  for (const entry of sim.result?.auth ?? []) {
    if (entry.credentials().switch().name === "sorobanCredentialsAddress") {
      const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
      if (addr === oracleKp.publicKey()) {
        signedEntries.push(await authorizeEntry(entry, oracleKp, validUntil, NETWORK_PASSPHRASE));
        continue;
      }
    }
    signedEntries.push(entry);
  }

  const source2 = await server.getAccount(borrower);
  const fee = (BigInt(Number(BASE_FEE) * 1000) + BigInt(sim.minResourceFee ?? "0")).toString();
  const prepared = new TransactionBuilder(source2, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: poolId, function: "borrow_installment", args, auth: signedEntries }))
    .setSorobanData(sim.transactionData.build())
    .setTimeout(180)
    .build();

  return {
    xdr: prepared.toXDR(),
    borrower,
    slot,
    oracle: oracleKp.publicKey(),
    expiry_ledger: expiryLedger,
    amount_stroops: amount.toString(),
  };
}

export async function prepareBorrow({ proofType, trustScore, rawScore, rawAttestation, amount, termDays, poolId, oracleSecret, borrower }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const oracleKp = Keypair.fromSecret(oracleSecret);
  if (borrower === oracleKp.publicKey()) {
    throw new Error("borrower must differ from the oracle — same key voids the attestation");
  }

  const ll = await server.getLatestLedger();
  const expiryLedger = ll.sequence + 2000;
  const nonceBuf = randomBytes(32);

  const witnessOverrides =
    (proofType === "creditworthiness" && rawAttestation != null)
      ? {
          monthly_income:      String(rawAttestation.monthly_income),
          repaid_loans_count:  String(rawAttestation.repaid_loans_count),
          default_count:       String(rawAttestation.default_count),
          monthly_debt:        String(rawAttestation.monthly_debt),
          employment_months:   String(rawAttestation.employment_months),
          bills_ok:            String(rawAttestation.bills_ok ?? 0),
        }
      : (proofType === "tier" && rawScore != null)
      ? { score: String(rawScore) }
      : {};

  const { proof, flags } = await generateProof(proofType, nonceBuf, expiryLedger, borrower, witnessOverrides);

  // Use the circuit-computed tier as trust_score for consistency with the proof.
  const contractTrustScore = (proofType === "tier" || proofType === "creditworthiness")
    ? Number(flags[0])
    : trustScore;

  const args = [
    new Address(borrower).toScVal(),
    i128ScVal(amount),
    xdr.ScVal.scvU32(termDays),
    proofToScVal(proof),
    publicInputsToScVal(flags),                  // [tier, max_loan] — both ZK-circuit outputs
    xdr.ScVal.scvU32(contractTrustScore),
    xdr.ScVal.scvBytes(nonceBuf),
    xdr.ScVal.scvU32(expiryLedger),
    // max_loan removed — contract reads from public_inputs[1]
  ];

  // SOURCE = borrower (the user). Their envelope signature will satisfy
  // borrower.require_auth; the oracle's auth entry we sign below.
  const source = await server.getAccount(borrower);
  const op = Operation.invokeContractFunction({ contract: poolId, function: "borrow_with_proof", args });
  const tx = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 1000),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (RpcClient.Api.isSimulationError(sim)) throw new Error(`simulate borrow: ${sim.error}`);

  const validUntil = ll.sequence + 200;
  const rawEntries = sim.result?.auth ?? [];
  const signedEntries = [];
  for (const entry of rawEntries) {
    if (entry.credentials().switch().name === "sorobanCredentialsAddress") {
      const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
      if (addr === oracleKp.publicKey()) {
        // Oracle attests the score by signing its own auth entry.
        signedEntries.push(await authorizeEntry(entry, oracleKp, validUntil, NETWORK_PASSPHRASE));
        continue;
      }
    }
    // Borrower's (source-account) credential and anything else: leave for the user.
    signedEntries.push(entry);
  }

  // Rebuild with the oracle-signed auth + simulated footprint. Source stays the
  // user; the user will add the envelope signature in the browser.
  const source2 = await server.getAccount(borrower);
  const fee = (BigInt(Number(BASE_FEE) * 1000) + BigInt(sim.minResourceFee ?? "0")).toString();
  const prepared = new TransactionBuilder(source2, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({ contract: poolId, function: "borrow_with_proof", args, auth: signedEntries }),
    )
    .setSorobanData(sim.transactionData.build())
    .setTimeout(180)
    .build();

  return {
    xdr: prepared.toXDR(),
    borrower,
    oracle: oracleKp.publicKey(),
    expiry_ledger: expiryLedger,
  };
}

// Submit the user-signed tx and wait for confirmation.
export async function submitBorrow({ signedXdr }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  if (tx.signatures.length === 0) throw new Error("Unsigned TX — wallet did not sign the transaction.");
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send borrow: ${JSON.stringify(sent.errorResult ?? sent)}`);
  const hash = sent.hash;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await server.getTransaction(hash);
    if (res.status === RpcClient.Api.GetTransactionStatus.SUCCESS) return { tx_hash: hash };
    if (res.status === RpcClient.Api.GetTransactionStatus.FAILED)
      throw new Error(`borrow failed on-chain: ${hash}`);
  }
  return { tx_hash: hash };
}

// Does the borrower's account already trust the pool's USDC asset? If not, the
// disbursement transfer would fail, so the UI must offer a changeTrust first.
export async function checkUsdcTrustline({ account, usdcSac }) {
  const server = new RpcClient.Server(RPC_URL, { allowHttp: false });
  try {
    // Read the SAC's balance entry for the account via the token contract.
    const acc = await server.getAccount(account);
    const op = Operation.invokeContractFunction({
      contract: usdcSac,
      function: "balance",
      args: [new Address(account).toScVal()],
    });
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    // A missing trustline makes the SAC balance call error; present → it returns an i128.
    return !RpcClient.Api.isSimulationError(sim);
  } catch {
    return false;
  }
}
