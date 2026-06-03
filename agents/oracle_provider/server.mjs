// zkCredit Risk Oracle — x402 seller + attestation provider.
//
// Endpoints:
//   GET  /health                   health check
//   POST /evaluate                 (legacy) proof verify + trust score (x402 gated)
//   POST /attest                   creditworthiness claims for a wallet (boolean only)
//   POST /demo/fund                send 2 testnet USDC from oracle wallet to borrower
//   POST /borrow                   demo path: backend holds borrower key
//   GET  /borrow/trustline         USDC trustline check
//   POST /borrow/prepare           real wallet: oracle co-signs, user signs in wallet
//   POST /borrow/submit            submit user-signed XDR
//   GET  /loan/status              active loan query
//   POST /loan/repay/prepare       build repay tx for user wallet
//   POST /loan/repay/submit        submit user-signed repay XDR
import "dotenv/config";
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { borrowWithProof, borrowWithProofInstallments, prepareBorrow, prepareBorrowInstallment, submitBorrow, checkUsdcTrustline, queryActiveLoan, prepareRepay, submitRepay, queryInstallmentLoans, prepareRepayInstallment } from "./onchain_pipeline.mjs";
import { attestWallet, evaluateClaims, TIER_LABELS } from "./attestation.mjs";
import StellarSdk from "./node_modules/@stellar/stellar-sdk/lib/index.js";

const { Keypair } = StellarSdk;

const RPC_URL = "https://soroban-testnet.stellar.org";
const ONCHAIN_DEMO_AMOUNT = Number(process.env.ONCHAIN_DEMO_AMOUNT ?? 10_000_000); // 1 USDC (7 decimals)
const ONCHAIN_DEMO_TERM = Number(process.env.ONCHAIN_DEMO_TERM ?? 365);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ORACLE_PORT ?? 3001);
const RISK_AGENT_URL = process.env.RISK_AGENT_URL ?? "http://localhost:8000";
const PRICE = process.env.ORACLE_PRICE ?? "$0.05";
const NETWORK = process.env.STELLAR_NETWORK ?? "stellar:testnet";
const X402_MODE = process.env.X402_MODE ?? "mock";

// Circuit verifying keys (produced by circuits/build.sh). Optional in mock mode.
const VK_PATHS = {
  solvency: process.env.SOLVENCY_VK ??
    join(__dirname, "../../circuits/solvency_proof/build/verification_key.json"),
  repayment: process.env.REPAYMENT_VK ??
    join(__dirname, "../../circuits/repayment_proof/build/verification_key.json"),
};

function loadVk(kind) {
  const p = VK_PATHS[kind];
  return p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// Legacy tier helper (for solvency/repayment proof type evaluation).
function scoreToTier(score) {
  if (score >= 80) return 3;
  if (score >= 60) return 2;
  if (score >= 40) return 1;
  return 0;
}

function flagsFromSignals(proofType, publicSignals) {
  const n = publicSignals.map((x) => Number(x));
  if (proofType === "solvency") {
    return { income_ok: n[0] === 1, solvency_ok: n[1] === 1 };
  }
  if (proofType === "repayment") {
    return { repayment_ok: n[0] === 1 };
  }
  throw new Error(`unknown proofType for evaluate: ${proofType}`);
}

async function verifyGroth16(proofType, proof, publicSignals) {
  const vk = loadVk(proofType);
  if (!vk) {
    if (X402_MODE === "mock") return { valid: true, mode: "trusted-no-vk" };
    throw new Error(`verifying key missing for ${proofType}; run circuits/build.sh`);
  }
  const snarkjs = await import("snarkjs");
  const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  return { valid, mode: "snarkjs" };
}

async function scoreFromRiskAgent(payload) {
  const res = await fetch(`${RISK_AGENT_URL}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`risk agent ${res.status}`);
  return res.json();
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// ─── x402 payment gate ────────────────────────────────────────────────────────
if (X402_MODE === "live") {
  const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { ExactStellarScheme } = await import("@x402/stellar/exact/server");

  if (!process.env.STELLAR_RECIPIENT) {
    throw new Error("X402_MODE=live requires STELLAR_RECIPIENT");
  }

  const facilitator = new HTTPFacilitatorClient({
    url: process.env.FACILITATOR_URL ?? "https://channels.openzeppelin.com/x402/testnet",
    createAuthHeaders: process.env.OZ_API_KEY
      ? async () => {
          const h = { Authorization: `Bearer ${process.env.OZ_API_KEY}` };
          return { verify: h, settle: h, supported: h };
        }
      : undefined,
  });

  const resourceServer = new x402ResourceServer(facilitator).register(
    NETWORK,
    new ExactStellarScheme(),
  );

  const priceConfig = {
    scheme: "exact",
    price: PRICE,
    network: NETWORK,
    payTo: process.env.STELLAR_RECIPIENT,
    maxTimeoutSeconds: 60,
  };

  app.use(
    paymentMiddleware(
      {
        "POST /evaluate": {
          description: "zkCredit verified trust score (legacy solvency/repayment proof)",
          accepts: priceConfig,
        },
        "POST /attest": {
          description: "zkCredit creditworthiness attestation (private financial claims)",
          accepts: priceConfig,
        },
      },
      resourceServer,
    ),
  );
  console.log(`x402 LIVE: charging ${PRICE} per /evaluate and /attest on ${NETWORK} → ${process.env.STELLAR_RECIPIENT}`);
} else {
  console.log("x402 MOCK: payment gate bypassed (set X402_MODE=live to enable)");
}

app.get("/health", (_req, res) => res.json({ status: "ok", x402: X402_MODE }));

// ─── Legacy /evaluate (solvency/repayment proof types) ────────────────────────
app.post("/evaluate", async (req, res) => {
  try {
    const { proofType, proof, publicSignals, signals = {} } = req.body ?? {};
    if (!proofType || !proof || !publicSignals) {
      return res.status(400).json({ error: "proofType, proof, publicSignals required" });
    }

    const { valid, mode } = await verifyGroth16(proofType, proof, publicSignals);
    if (!valid) {
      return res.status(422).json({ error: "invalid proof", proof_valid: false });
    }

    const flags = flagsFromSignals(proofType, publicSignals);
    const score = await scoreFromRiskAgent({ ...flags, ...signals });

    const tier = scoreToTier(Number(score.trust_score ?? 0));
    const tier_label = TIER_LABELS[tier];

    res.json({
      proof_valid: true,
      verification_mode: mode,
      ...score,
      tier,
      tier_label,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /attest — Private Creditworthiness Assessment ────────────────────────────
// Returns boolean claims only — never reveals raw financial figures.
// The claims are what the ZK circuit proves (income_ok, loans_ok, etc.).
// Raw financial values go directly into the ZK witness when the borrower proceeds.
app.post("/attest", async (req, res) => {
  try {
    const { borrower } = req.body ?? {};
    if (!borrower) {
      return res.status(400).json({ error: "borrower address required" });
    }

    const { profile, claims, total_criteria, tier, tier_label, bank_attestation } = await attestWallet(borrower);

    // Credit limit — computed from verified bank data, returned as a sizing hint.
    // Raw income never leaves the oracle; only the derived limit is disclosed.
    const repaidCount = profile.repaid_loans_count ?? 0;
    const creditRatioVal = creditRatio(repaidCount);
    const maxBorrowableUsdc = Math.floor((profile.monthly_income / 50) * creditRatioVal * 100) / 100;

    // Return claims (booleans) + tier — NEVER the raw profile values.
    // The raw profile is used server-side only for ZK witness generation.
    res.json({
      borrower,
      claims,           // { income_ok, loans_ok, default_ok, dti_ok, employment_ok }
      total_criteria,
      tier,
      tier_label,
      // Credit limit derived from verified income (raw income not disclosed)
      max_borrowable_usdc: tier > 0 ? maxBorrowableUsdc : 0,
      credit_ratio_pct: Math.round(creditRatioVal * 100),
      // Human-readable thresholds for UI display (not the actual values)
      thresholds: {
        income:     "monthly income ≥ $2,000",
        loans:      "repaid loans ≥ 3",
        defaults:   "zero defaults",
        dti:        "debt-to-income < 30%",
        employment: "employed ≥ 12 months",
      },
      proof_type: "creditworthiness",
      bank_attestation, // { issued_at, issuer, signature_verified: true }
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── Loan product helpers ──────────────────────────────────────────────────────
const LEDGERS_PER_DAY = 17_280;

function termDaysFromProduct(product, customDays) {
  if (product === "daily")         return Math.min(27, Math.max(1, customDays ?? 7));
  if (product === "installment_3m") return 30; // each slot is 30 days; total is 3×30
  return 30; // monthly (default)
}

function creditRatio(repaidCount) {
  if (repaidCount === 0) return 0.10;
  if (repaidCount === 1) return 0.15;
  if (repaidCount === 2) return 0.20;
  if (repaidCount <= 4)  return 0.25;
  return 0.30;
}

function maxBorrowableStroops(monthlyIncome, repaidCount) {
  // monthly_income from bank is testnet-scaled; ÷50 → raw USDC, ×1e7 → stroops
  const incomeUsdc = monthlyIncome / 50;
  const limit = incomeUsdc * creditRatio(repaidCount);
  return Math.floor(limit * 1e7); // stroops
}

// ─── /borrow (demo path — backend holds borrower key) ─────────────────────────
app.post("/borrow", async (req, res) => {
  try {
    const { trustScore, proofType: clientProofType, loan_product, custom_days, amount } = req.body ?? {};

    const poolId = process.env.LENDING_POOL;
    const oracleSecret = process.env.STELLAR_SECRET_KEY;
    const borrowerSecret = process.env.BORROWER_SECRET_KEY;
    if (!poolId || !oracleSecret) {
      return res.status(503).json({ error: "LENDING_POOL / STELLAR_SECRET_KEY not configured" });
    }
    if (!borrowerSecret) {
      return res.status(503).json({ error: "BORROWER_SECRET_KEY missing" });
    }

    // Determine proof strategy:
    //   creditworthiness — use 5 financial attributes as private ZK inputs
    //   tier (legacy)    — use single AI trust score
    const useCredit = !clientProofType || clientProofType === "creditworthiness";
    const borrowerKp = Keypair.fromSecret(borrowerSecret);
    const borrower = borrowerKp.publicKey();

    let rawAttestation = null;
    let rawScore = null;
    let tier;

    if (useCredit) {
      const att = await attestWallet(borrower);
      tier = att.tier;
      rawAttestation = att.profile;

      if (tier === 0) {
        console.log(`[onchain] loan REJECTED: ${borrower} → RED tier (income<2000 or defaults>0)`);
        return res.status(400).json({
          error: `Credit score insufficient — RED tier. Income < $2,000 or past defaults. Loan application rejected.`,
          tier: 0,
          tier_label: "RED",
          claims: att.claims,
        });
      }
    } else {
      if (trustScore == null) return res.status(400).json({ error: "trustScore required" });
      rawScore = Number(trustScore);
      tier = scoreToTier(rawScore);
      if (tier === 0) {
        console.log(`[onchain] loan REJECTED: score=${rawScore} → RED tier`);
        return res.status(400).json({
          error: `Credit score insufficient — RED tier (score: ${rawScore}/100, threshold: 40). Loan application rejected.`,
          tier: 0,
          tier_label: "RED",
          trust_score: rawScore,
        });
      }
    }

    // Determine term and amount from loan product
    const resolvedTermDays = termDaysFromProduct(loan_product ?? "monthly", custom_days);

    // Credit limit check
    let resolvedAmount = ONCHAIN_DEMO_AMOUNT;
    if (useCredit && rawAttestation && amount) {
      const maxStroops = maxBorrowableStroops(rawAttestation.monthly_income, rawAttestation.repaid_loans_count);
      const requestedStroops = Math.round(Number(amount) * 1e7);
      if (requestedStroops > maxStroops) {
        return res.status(400).json({
          error: `Credit limit exceeded. Maximum: ${(maxStroops / 1e7).toFixed(2)} USDC (${Math.round(creditRatio(rawAttestation.repaid_loans_count) * 100)}% of your income)`,
          max_borrowable_usdc: maxStroops / 1e7,
        });
      }
      resolvedAmount = requestedStroops;
    }

    if (loan_product === "installment_3m") {
      const result = await borrowWithProofInstallments({
        proofType: useCredit ? "creditworthiness" : "tier",
        trustScore: tier,
        rawAttestation,
        amount: resolvedAmount,
        poolId,
        oracleSecret,
        borrowerSecret,
      });
      console.log(`[onchain] installment loan originated: slots=${result.installments.map(i => i.slot).join(",")} borrower=${result.borrower}`);
      return res.json({
        onchain_kind: "installment_3m",
        installments: result.installments,
        onchain_amount: resolvedAmount,
        onchain_term_days: 30,
        borrower: result.borrower,
        oracle: result.oracle,
        tier,
        tier_label: TIER_LABELS[tier],
      });
    }

    const result = await borrowWithProof({
      proofType: useCredit ? "creditworthiness" : "tier",
      trustScore: tier,
      rawScore,
      rawAttestation,
      amount: resolvedAmount,
      termDays: resolvedTermDays,
      poolId,
      oracleSecret,
      borrowerSecret,
    });
    console.log(`[onchain] loan originated: ${result.tx_hash} (tier=${tier}/${TIER_LABELS[tier]}, borrower=${result.borrower}, term=${resolvedTermDays}d)`);

    res.json({
      onchain_tx: result.tx_hash,
      onchain_kind: "borrow_with_proof",
      repaid_first: result.repaid_first,
      onchain_amount: resolvedAmount,
      onchain_term_days: resolvedTermDays,
      borrower: result.borrower,
      oracle: result.oracle,
      expiry_ledger: result.expiry_ledger,
      tier,
      tier_label: TIER_LABELS[tier],
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /borrow/trustline ─────────────────────────────────────────────────────────
app.get("/borrow/trustline", async (req, res) => {
  try {
    const account = req.query.account;
    const usdcSac = process.env.USDC_SAC;
    if (!account || !usdcSac) return res.status(400).json({ error: "account + USDC_SAC required" });
    const has = await checkUsdcTrustline({ account, usdcSac });
    res.json({ has_trustline: has, usdc_sac: usdcSac });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /borrow/prepare (real wallet) ────────────────────────────────────────────
app.post("/borrow/prepare", async (req, res) => {
  try {
    const { proofType: clientProofType, trustScore, borrower, loan_product, custom_days, amount } = req.body ?? {};
    if (!borrower) return res.status(400).json({ error: "borrower required" });

    const poolId = process.env.LENDING_POOL;
    const oracleSecret = process.env.STELLAR_SECRET_KEY;
    if (!poolId || !oracleSecret) return res.status(503).json({ error: "on-chain borrowing not configured" });
    if (clientProofType === "none") return res.status(400).json({ error: "ZK proof required to borrow" });

    const useCredit = !clientProofType || clientProofType === "creditworthiness";
    let rawAttestation = null;
    let rawScore = null;
    let tier;

    if (useCredit) {
      const att = await attestWallet(borrower);
      tier = att.tier;
      rawAttestation = att.profile;

      if (tier === 0) {
        console.log(`[onchain] borrow/prepare REJECTED: ${borrower} → RED tier`);
        return res.status(400).json({
          error: `Credit score insufficient — RED tier. Income < $2,000 or past defaults. Loan application rejected.`,
          tier: 0,
          tier_label: "RED",
          claims: att.claims,
        });
      }
    } else {
      if (trustScore == null) return res.status(400).json({ error: "trustScore required" });
      rawScore = Number(trustScore);
      tier = scoreToTier(rawScore);
      if (tier === 0) {
        console.log(`[onchain] borrow/prepare REJECTED: score=${rawScore} → RED tier`);
        return res.status(400).json({
          error: `Credit score insufficient — RED tier (score: ${rawScore}/100, threshold: 40). Loan application rejected.`,
          tier: 0,
          tier_label: "RED",
          trust_score: rawScore,
        });
      }
    }

    // installment_3m is oracle-managed (3 sequential txs): must use /borrow, not /borrow/prepare
    if (loan_product === "installment_3m") {
      return res.status(400).json({ error: "installment_3m not supported via wallet-prepare flow — use demo borrow path" });
    }

    const resolvedTermDays = termDaysFromProduct(loan_product ?? "monthly", custom_days);

    // Credit limit check
    let resolvedAmount = ONCHAIN_DEMO_AMOUNT;
    if (useCredit && rawAttestation && amount) {
      const maxStroops = maxBorrowableStroops(rawAttestation.monthly_income, rawAttestation.repaid_loans_count);
      const requestedStroops = Math.round(Number(amount) * 1e7);
      if (requestedStroops > maxStroops) {
        return res.status(400).json({
          error: `Credit limit exceeded. Maximum: ${(maxStroops / 1e7).toFixed(2)} USDC`,
          max_borrowable_usdc: maxStroops / 1e7,
        });
      }
      resolvedAmount = requestedStroops;
    }

    const prep = await prepareBorrow({
      proofType: useCredit ? "creditworthiness" : "tier",
      trustScore: tier,
      rawScore,
      rawAttestation,
      amount: resolvedAmount,
      termDays: resolvedTermDays,
      poolId,
      oracleSecret,
      borrower,
    });
    console.log(`[onchain] borrow prepared for ${borrower} (tier=${tier}/${TIER_LABELS[tier]}, term=${resolvedTermDays}d, amount=${resolvedAmount})`);
    res.json({ ...prep, onchain_amount: resolvedAmount, onchain_term_days: resolvedTermDays, tier, tier_label: TIER_LABELS[tier] });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /borrow/prepare/installment ──────────────────────────────────────────────
// Prepare a single borrow_installment slot for user-wallet signing.
// Frontend calls this 3 times (slot 0/1/2), user signs each, submits each.
app.post("/borrow/prepare/installment", async (req, res) => {
  try {
    const { proofType: clientProofType, trustScore, borrower, slot, amount } = req.body ?? {};
    if (!borrower || slot == null) return res.status(400).json({ error: "borrower + slot required" });
    const poolId = process.env.LENDING_POOL;
    const oracleSecret = process.env.STELLAR_SECRET_KEY;
    if (!poolId || !oracleSecret) return res.status(503).json({ error: "on-chain borrowing not configured" });

    const useCredit = !clientProofType || clientProofType === "creditworthiness";
    let rawAttestation = null, rawScore = null, tier;
    if (useCredit) {
      const att = await attestWallet(borrower);
      tier = att.tier;
      rawAttestation = att.profile;
      if (tier === 0) return res.status(400).json({ error: "RED tier — loan rejected", tier: 0, tier_label: "RED" });
    } else {
      rawScore = Number(trustScore);
      tier = scoreToTier(rawScore);
      if (tier === 0) return res.status(400).json({ error: "RED tier — loan rejected", tier: 0, tier_label: "RED" });
    }

    let resolvedAmount = ONCHAIN_DEMO_AMOUNT;
    if (useCredit && rawAttestation && amount) {
      const maxStroops = maxBorrowableStroops(rawAttestation.monthly_income, rawAttestation.repaid_loans_count);
      const requestedStroops = Math.round(Number(amount) * 1e7);
      if (requestedStroops > maxStroops) return res.status(400).json({ error: `Credit limit exceeded`, max_borrowable_usdc: maxStroops / 1e7 });
      resolvedAmount = Math.floor(requestedStroops / 3); // per-slot amount
    } else {
      resolvedAmount = Math.floor(resolvedAmount / 3);
    }

    const prep = await prepareBorrowInstallment({
      proofType: useCredit ? "creditworthiness" : "tier",
      trustScore: tier, rawScore, rawAttestation,
      amount: resolvedAmount, slot: Number(slot), poolId, oracleSecret, borrower,
    });
    console.log(`[onchain] installment borrow prepared slot=${slot} for ${borrower.slice(0,8)}… amount=${resolvedAmount}`);
    res.json({ ...prep, tier, tier_label: TIER_LABELS[tier], onchain_amount: resolvedAmount });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /borrow/submit ────────────────────────────────────────────────────────────
app.post("/borrow/submit", async (req, res) => {
  try {
    const { signedXdr } = req.body ?? {};
    if (!signedXdr) return res.status(400).json({ error: "signedXdr required" });
    const result = await submitBorrow({ signedXdr });
    console.log(`[onchain] user loan originated: ${result.tx_hash}`);
    res.json({ onchain_tx: result.tx_hash, onchain_kind: "borrow_with_proof" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /loan/status ──────────────────────────────────────────────────────────────
app.get("/loan/status", async (req, res) => {
  try {
    const account = req.query.account;
    const poolId = process.env.LENDING_POOL;
    if (!account || !poolId) return res.status(400).json({ error: "account + LENDING_POOL required" });
    const loan = await queryActiveLoan(poolId, account);
    if (!loan) return res.json({ active: false });
    const totalDue = BigInt(loan.total_due ?? 0);
    const repaid = BigInt(loan.repaid ?? 0);
    const outstanding = totalDue - repaid;

    // Compute time remaining: expiry_ledger = start_ledger + term_days * 17280
    const startLedger = Number(loan.start_ledger ?? 0);
    const termDays = Number(loan.term_days ?? 365);
    const expiryLedger = startLedger + termDays * 17_280;

    // Fetch current ledger for remaining time calculation
    const { rpc: Rpc } = StellarSdk;
    const rpcServer = new Rpc.Server(RPC_URL);
    const ll = await rpcServer.getLatestLedger();
    const currentLedger = ll.sequence;
    const ledgersRemaining = Math.max(0, expiryLedger - currentLedger);
    const secondsRemaining = ledgersRemaining * 5;

    res.json({
      active: true,
      total_due: totalDue.toString(),
      repaid: repaid.toString(),
      outstanding: outstanding.toString(),
      outstanding_usdc: Number(outstanding) / 1e7,
      start_ledger: startLedger,
      term_days: termDays,
      expiry_ledger: expiryLedger,
      current_ledger: currentLedger,
      seconds_remaining: secondsRemaining,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /loan/repay/prepare ───────────────────────────────────────────────────────
app.post("/loan/repay/prepare", async (req, res) => {
  try {
    const { borrower } = req.body ?? {};
    const poolId = process.env.LENDING_POOL;
    if (!borrower || !poolId) return res.status(400).json({ error: "borrower required" });
    const prep = await prepareRepay({ borrower, poolId });
    console.log(`[onchain] repay prepared for ${borrower} — outstanding ${prep.outstanding_usdc} USDC`);
    res.json(prep);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /loan/repay/submit ────────────────────────────────────────────────────────
app.post("/loan/repay/submit", async (req, res) => {
  try {
    const { signedXdr, borrower } = req.body ?? {};
    if (!signedXdr) return res.status(400).json({ error: "signedXdr required" });
    const result = await submitRepay({ signedXdr });
    console.log(`[onchain] repay confirmed: ${result.tx_hash}`);
    // Notify bank to increment credit history for this borrower
    if (borrower) {
      const BANK_URL = process.env.BANK_URL ?? "http://localhost:3002";
      fetch(`${BANK_URL}/internal/credit-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrower, event: "repay" }),
      }).catch(() => {}); // fire-and-forget
    }
    res.json({ onchain_tx: result.tx_hash });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /creditworthiness/history — on-chain repaid count + defaults ─────────────
// Bank agent queries this to get accurate credit history from the contract.
app.get("/creditworthiness/history", async (req, res) => {
  try {
    const account = req.query.account;
    const poolId = process.env.LENDING_POOL;
    if (!account || !poolId) return res.status(400).json({ error: "account + LENDING_POOL required" });

    const { rpc: Rpc, TransactionBuilder, Networks, Keypair, Operation, BASE_FEE, Address } = StellarSdk;
    const server = new Rpc.Server(RPC_URL);
    const oracleKp = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY);
    const borrowerAddr = new Address(account);

    async function viewCall(fn) {
      const op = Operation.invokeContractFunction({ contract: poolId, function: fn, args: [borrowerAddr.toScVal()] });
      const account_ = await server.getAccount(oracleKp.publicKey());
      const tx = new TransactionBuilder(account_, { fee: String(Number(BASE_FEE) * 100), networkPassphrase: Networks.TESTNET })
        .addOperation(op).setTimeout(30).build();
      const sim = await server.simulateTransaction(tx);
      if (Rpc.Api.isSimulationError(sim)) return 0;
      const val = sim.result?.retval;
      return val ? Number(StellarSdk.scValToNative(val)) : 0;
    }

    const [repaid_count, defaults] = await Promise.all([
      viewCall("get_repaid_count"),
      viewCall("get_defaults"),
    ]);
    res.json({ account, repaid_count, defaults });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /admin/force-default — demo: force a wallet into default ─────────────────
app.post("/admin/force-default", async (req, res) => {
  try {
    const { borrower } = req.body ?? {};
    if (!borrower) return res.status(400).json({ error: "borrower required" });
    const poolId = process.env.LENDING_POOL;
    const oracleSecret = process.env.STELLAR_SECRET_KEY;
    if (!poolId || !oracleSecret) return res.status(503).json({ error: "not configured" });

    const { rpc: Rpc, TransactionBuilder, Networks, Keypair, Operation, BASE_FEE, Address } = StellarSdk;
    const server = new Rpc.Server(RPC_URL);
    const kp = Keypair.fromSecret(oracleSecret);
    const args = [new Address(borrower).toScVal()];
    const op = Operation.invokeContractFunction({ contract: poolId, function: "force_default", args });
    const acct = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 500), networkPassphrase: Networks.TESTNET })
      .addOperation(op).setTimeout(60).build();
    const sim = await server.simulateTransaction(tx);
    if (Rpc.Api.isSimulationError(sim)) return res.status(400).json({ error: `simulate: ${sim.error}` });
    const prep = Rpc.assembleTransaction(tx, sim).build();
    prep.sign(kp);
    const sent = await server.sendTransaction(prep);
    if (sent.status === "ERROR") return res.status(400).json({ error: JSON.stringify(sent.errorResult) });
    const hash = sent.hash;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const result = await server.getTransaction(hash);
      if (result.status === Rpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`[admin] force_default OK for ${borrower.slice(0,8)}… tx: ${hash}`);
        return res.json({ ok: true, tx_hash: hash, borrower });
      }
      if (result.status === Rpc.Api.GetTransactionStatus.FAILED)
        return res.status(400).json({ error: `tx failed: ${hash}` });
    }
    res.status(408).json({ error: "timeout", tx_hash: hash });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /installment/status ──────────────────────────────────────────────────────
app.get("/installment/status", async (req, res) => {
  try {
    const account = req.query.account;
    const poolId = process.env.LENDING_POOL;
    if (!account || !poolId) return res.status(400).json({ error: "account + LENDING_POOL required" });
    const loans = await queryInstallmentLoans(poolId, account);
    const { rpc: Rpc } = StellarSdk;
    const rpcServer = new Rpc.Server(RPC_URL);
    const ll = await rpcServer.getLatestLedger();
    const currentLedger = ll.sequence;
    const slots = loans.map((loan, slot) => {
      if (!loan) return { slot, active: false };
      const totalDue = BigInt(loan.total_due ?? 0);
      const repaid = BigInt(loan.repaid ?? 0);
      const outstanding = totalDue - repaid;
      const startLedger = Number(loan.start_ledger ?? 0);
      const termDays = Number(loan.term_days ?? 30);
      const expiryLedger = startLedger + termDays * 17_280;
      const ledgersRemaining = Math.max(0, expiryLedger - currentLedger);
      return {
        slot,
        active: true,
        outstanding: outstanding.toString(),
        outstanding_usdc: Number(outstanding) / 1e7,
        total_due: totalDue.toString(),
        repaid: repaid.toString(),
        term_days: termDays,
        expiry_ledger: expiryLedger,
        current_ledger: currentLedger,
        seconds_remaining: ledgersRemaining * 5,
      };
    });
    res.json({ slots });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /installment/repay/prepare ───────────────────────────────────────────────
app.post("/installment/repay/prepare", async (req, res) => {
  try {
    const { borrower, slot } = req.body ?? {};
    const poolId = process.env.LENDING_POOL;
    if (!borrower || slot == null || !poolId) return res.status(400).json({ error: "borrower + slot required" });
    const prep = await prepareRepayInstallment({ borrower, slot: Number(slot), poolId });
    console.log(`[onchain] installment repay prepared slot=${slot} for ${borrower.slice(0,8)}… outstanding=${prep.outstanding_usdc} USDC`);
    res.json(prep);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /installment/repay/submit ────────────────────────────────────────────────
app.post("/installment/repay/submit", async (req, res) => {
  try {
    const { signedXdr, borrower, slot } = req.body ?? {};
    if (!signedXdr) return res.status(400).json({ error: "signedXdr required" });
    const result = await submitRepay({ signedXdr });
    console.log(`[onchain] installment repay submitted slot=${slot} borrower=${borrower?.slice(0,8)}… tx=${result.tx_hash}`);
    res.json({ onchain_tx: result.tx_hash, slot });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /installment/repay/demo ──────────────────────────────────────────────────
// Oracle-managed repayment for demo borrower (BORROWER_SECRET_KEY holds the key).
app.post("/installment/repay/demo", async (req, res) => {
  try {
    const { slot } = req.body ?? {};
    const poolId = process.env.LENDING_POOL;
    const borrowerSecret = process.env.BORROWER_SECRET_KEY;
    if (slot == null || !poolId || !borrowerSecret) {
      return res.status(400).json({ error: "slot + LENDING_POOL + BORROWER_SECRET_KEY required" });
    }
    const borrowerKp = Keypair.fromSecret(borrowerSecret);
    const borrower = borrowerKp.publicKey();
    const prep = await prepareRepayInstallment({ borrower, slot: Number(slot), poolId });

    // Sign with the demo borrower key (oracle holds it)
    const { TransactionBuilder, Networks } = StellarSdk;
    const tx = TransactionBuilder.fromXDR(prep.xdr, Networks.TESTNET);
    tx.sign(borrowerKp);
    const result = await submitRepay({ signedXdr: tx.toXDR() });
    console.log(`[onchain] demo installment repay slot=${slot} borrower=${borrower.slice(0,8)}… tx=${result.tx_hash}`);
    res.json({ onchain_tx: result.tx_hash, slot, borrower });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ─── /demo/fund — testnet USDC faucet ─────────────────────────────────────────
// Sends 2 USDC from oracle wallet to borrower so they can repay their loan.
// Testnet only — oracle wallet must have USDC balance and STELLAR_SECRET_KEY set.
app.post("/demo/fund", async (req, res) => {
  try {
    const { borrower } = req.body ?? {};
    if (!borrower) return res.status(400).json({ error: "borrower required" });

    const oracleSecret = process.env.STELLAR_SECRET_KEY;
    const usdcSac = process.env.USDC_SAC;
    if (!oracleSecret || !usdcSac) {
      return res.status(503).json({ error: "STELLAR_SECRET_KEY / USDC_SAC not configured" });
    }

    const { rpc: Rpc, Address, TransactionBuilder, Operation, BASE_FEE, Networks, xdr } = StellarSdk;
    const rpcServer = new Rpc.Server(RPC_URL);
    const oracleKp = Keypair.fromSecret(oracleSecret);

    // Build a SAC transfer: oracle → borrower, 2 USDC = 20_000_000 stroops
    const FUND_AMOUNT = 20_000_000n;
    const transferArgs = [
      new Address(oracleKp.publicKey()).toScVal(),
      new Address(borrower).toScVal(),
      xdr.ScVal.scvI128(new xdr.Int128Parts({
        hi: xdr.Int64.fromString("0"),
        lo: xdr.Uint64.fromString(FUND_AMOUNT.toString()),
      })),
    ];

    const account = await rpcServer.getAccount(oracleKp.publicKey());
    const op = Operation.invokeContractFunction({ contract: usdcSac, function: "transfer", args: transferArgs });
    const tx = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 100),
      networkPassphrase: Networks.TESTNET,
    }).addOperation(op).setTimeout(60).build();

    const sim = await rpcServer.simulateTransaction(tx);
    if (Rpc.Api.isSimulationError(sim)) {
      return res.status(400).json({ error: `simulate fund: ${sim.error}` });
    }
    const prepared = Rpc.assembleTransaction(tx, sim).build();
    prepared.sign(oracleKp);
    const sent = await rpcServer.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      return res.status(400).json({ error: `send fund: ${JSON.stringify(sent.errorResult ?? sent)}` });
    }

    // Poll for confirmation
    const txHash = sent.hash;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const result = await rpcServer.getTransaction(txHash);
      if (result.status === Rpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`[demo/fund] 2 USDC → ${borrower.slice(0, 8)}… tx: ${txHash}`);
        return res.json({ funded: true, amount_usdc: 2, tx_hash: txHash, borrower });
      }
      if (result.status === Rpc.Api.GetTransactionStatus.FAILED) {
        return res.status(400).json({ error: `fund tx failed: ${txHash}` });
      }
    }
    res.status(408).json({ error: "fund tx timeout", tx_hash: txHash });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.listen(PORT, () => console.log(`Risk Oracle (x402) on http://localhost:${PORT}`));
