// Server-side bridge to the x402 Risk Oracle.
//
// In a full deployment the lending protocol pays the oracle over x402 (see
// ../../x402/client.mjs). Here the Next.js server requests an evaluation from
// the oracle; if it is unreachable we fall back to the local TS scoring mirror
// so the demo always renders. The fallback is clearly flagged via `source`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreBorrower } from "./scoring";
import type { BorrowerSignals, ScoreResult, ProofType } from "./types";

const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";
const CIRCUITS_DIR = join(process.cwd(), "..", "circuits");

// Load real snarkjs proof from build artifacts (server-side only).
async function loadProof(proofType: ProofType): Promise<object> {
  try {
    const path = join(CIRCUITS_DIR, `${proofType}_proof`, "build", "proof.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Artifacts not built yet — oracle will use mock mode
    return { demo: true };
  }
}

function signalsToPublic(proofType: ProofType, signals: BorrowerSignals): string[] {
  // Mirrors the circuit public-signal layout the oracle expects.
  if (proofType === "solvency") {
    return [signals.income_ok ? "1" : "0", signals.solvency_ok ? "1" : "0", "1"];
  }
  if (proofType === "repayment") {
    return [signals.repayment_ok ? "1" : "0", "1"];
  }
  return [];
}

export async function evaluate(
  proofType: ProofType,
  signals: BorrowerSignals,
): Promise<ScoreResult> {
  if (proofType === "none") {
    return scoreBorrower({}); // anonymous tier, no oracle call needed
  }

  try {
    const res = await fetch(`${ORACLE_URL}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofType,
        // Real snarkjs Groth16 proof — loaded from the circuit build artifacts.
        // The oracle verifies this against the circuit's verifying key before scoring.
        proof: await loadProof(proofType),
        publicSignals: signalsToPublic(proofType, signals),
        signals,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      return { ...data, source: "oracle" as const };
    }
  } catch {
    // oracle offline — fall through to local scoring
  }
  return scoreBorrower(signals);
}
