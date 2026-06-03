// x402 buyer client — the lending protocol's autonomous payment to the Risk Oracle.
//
// Machine-to-machine: no human in the loop. The protocol pays USDC over x402 and
// receives a verified trust score it can submit to the on-chain `lending_pool`.
//
// X402_MODE=mock  -> plain fetch (no payment), for offline demos.
// X402_MODE=live  -> @x402/fetch wraps the request, signs Stellar auth entries,
//                    and the OZ Channels facilitator settles ~$0.05 USDC.
import "dotenv/config";

const X402_MODE = process.env.X402_MODE ?? "mock";
const NETWORK = process.env.STELLAR_NETWORK ?? "stellar:testnet";

async function liveFetch() {
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { createEd25519Signer } = await import("@x402/stellar");
  const { ExactStellarScheme } = await import("@x402/stellar/exact/client");

  // createEd25519Signer takes the raw secret + a CAIP-2 network id.
  const signer = createEd25519Signer(process.env.STELLAR_SECRET_KEY, NETWORK);
  const core = new x402Client().register(NETWORK, new ExactStellarScheme(signer));
  // wrapFetchWithPayment returns a fetch that auto-handles 402 → pay → retry.
  return wrapFetchWithPayment(fetch, core);
}

/**
 * Request a verified trust score from the oracle, paying via x402 when live.
 * @param {object} args
 * @param {string} args.oracleUrl   e.g. http://localhost:3001
 * @param {"solvency"|"repayment"} args.proofType
 * @param {object} args.proof        snarkjs Groth16 proof
 * @param {string[]} args.publicSignals
 * @param {object} [args.signals]    behavioural signals (wallet age, history, ...)
 * @returns {Promise<object>} { proof_valid, trust_score, rate_bps, rate_pct, ... }
 */
export async function requestTrustScore({ oracleUrl, proofType, proof, publicSignals, signals = {} }) {
  const url = `${oracleUrl.replace(/\/$/, "")}/evaluate`;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proofType, proof, publicSignals, signals }),
  };

  const doFetch = X402_MODE === "live" ? await liveFetch() : fetch;
  const res = await doFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`oracle ${res.status}: ${text}`);
  }
  return res.json();
}
