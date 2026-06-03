// MockBank Data Provider — Ed25519 signed financial attestations.
//
// Production equivalent: Plaid, Experian, or a bank's Open Banking API.
// This service is the authoritative source of financial records and signs
// every attestation so the oracle can cryptographically verify data provenance.
//
// Trust model:
//   MockBank holds financial records → signs with Ed25519 private key
//   Oracle fetches signed payload → verifies signature with bank's public key
//   Verified raw values → ZK witness only (never forwarded to frontend)
//
// Endpoints:
//   GET  /health            liveness check
//   GET  /pubkey            oracle fetches once to cache the verification key
//   POST /financial-data    returns { wallet, data, issued_at, issuer, signature }

import http from "node:http";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRecord } from "./financial_records.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(__dirname, "bank_keypair.json");
const PORT = Number(process.env.BANK_PORT ?? 3002);
const ISSUER = "MockBank-Demo";

// ─── Credit history store ──────────────────────────────────────────────────────
import { creditHistory } from "./credit_store.mjs";

// Pre-seed known demo wallets so they work immediately on server start.
creditHistory.set("GDYSNQ74SSCADPFFEIAVWVDIXZNJ5WF3J7LDRBMPW3VFJJHB7SSJ2TEQ", 8); // PRIME
creditHistory.set("GAKPIGNGOWAS75N6SSJVYPVI574JWBSDLUJASIRN6XSM5G3TWE3WAU3S", 5); // GREEN
creditHistory.set("GDXVDPQVKYSSS4YGXZTVE2HATHKMSEZFROVOHA547EUU6UXDCGDAOUXW", 4); // GREEN
creditHistory.set("GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR", 4); // GREEN
creditHistory.set("GBUUARFXB2VJDPSC4UBU5JWOU3VBSS64P67GJFIIHAM5SPKSBNS52ZUU", 3); // YELLOW

// ─── Keypair: load from disk or generate fresh ────────────────────────────────
let privKey, pubKeyHex;

if (existsSync(KEY_PATH)) {
  const stored = JSON.parse(readFileSync(KEY_PATH, "utf8"));
  privKey = createPrivateKey({
    key: Buffer.from(stored.privDer, "hex"),
    format: "der",
    type: "pkcs8",
  });
  pubKeyHex = stored.pubHex;
  console.log("[bank] Keypair loaded from disk.");
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
  pubKeyHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  writeFileSync(KEY_PATH, JSON.stringify({ privDer, pubHex: pubKeyHex }), "utf8");
  privKey = privateKey;
  console.log("[bank] New Ed25519 keypair generated → bank_keypair.json");
}

// ─── Signing ──────────────────────────────────────────────────────────────────
// Canonical message: same JSON serialization the oracle uses for verification.
function signAttestation(wallet, data, issuedAt) {
  const msg = JSON.stringify({ wallet, data, issued_at: issuedAt, issuer: ISSUER });
  return cryptoSign(null, Buffer.from(msg, "utf8"), privKey).toString("hex");
}

// ─── HTTP plumbing ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonRes(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ─── Request handler ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === "GET" && url === "/health") {
    return jsonRes(res, 200, { status: "ok", issuer: ISSUER });
  }

  // Oracle calls this once on startup to cache the verification key.
  if (method === "GET" && url === "/pubkey") {
    return jsonRes(res, 200, {
      pubkey_hex: pubKeyHex,
      format: "spki-der-hex",
      algorithm: "Ed25519",
      issuer: ISSUER,
    });
  }

  if (method === "POST" && url === "/internal/credit-event") {
    return handleCreditEvent(req, res);
  }

  if (method === "POST" && url === "/financial-data") {
    try {
      const body = await readBody(req);
      const { wallet } = JSON.parse(body);
      if (!wallet) return jsonRes(res, 400, { error: "wallet required" });

      const data = await getRecord(wallet);
      const issued_at = new Date().toISOString();
      const signature = signAttestation(wallet, data, issued_at);

      console.log(`[bank] Signed attestation for ${wallet.slice(0, 8)}… (sig: ${signature.slice(0, 16)}…)`);
      return jsonRes(res, 200, { wallet, data, issued_at, issuer: ISSUER, signature });
    } catch (err) {
      return jsonRes(res, 500, { error: String(err.message ?? err) });
    }
  }

  jsonRes(res, 404, { error: "not found" });
});

// ─── Internal: oracle notifies bank after confirmed repayment ─────────────────
// Not exposed publicly — only oracle can call this (same host).
async function handleCreditEvent(req, res) {
  try {
    const body = await readBody(req);
    const { borrower, event } = JSON.parse(body);
    if (!borrower || event !== "repay") return jsonRes(res, 400, { error: "borrower + event:repay required" });
    const current = creditHistory.get(borrower) ?? 0;
    creditHistory.set(borrower, current + 1);
    console.log(`[bank] Credit event: ${borrower.slice(0, 8)}… repaid_count → ${current + 1}`);
    return jsonRes(res, 200, { ok: true, borrower, repaid_count: current + 1 });
  } catch (err) {
    return jsonRes(res, 500, { error: String(err.message ?? err) });
  }
}

server.listen(PORT, () => {
  console.log(`[bank] MockBank Data Provider  →  http://localhost:${PORT}`);
  console.log(`[bank] Public key (first 24): ${pubKeyHex.slice(0, 24)}…`);
  console.log(`[bank] Issuer: ${ISSUER}`);
});
