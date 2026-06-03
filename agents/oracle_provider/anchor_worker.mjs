// anchor_worker.mjs — forked child process for phase-1 ZK proof anchoring.
// Runs snarkjs fullProve + verify_with_context in isolation so the main oracle
// process event loop is never blocked by CPU-heavy proof generation.
// Invoked by server.mjs via child_process.fork(); exits after one anchor.
import { anchorProof } from "./onchain_pipeline.mjs";

const proofType = process.env.ANCHOR_PROOF_TYPE;
const verifierId = process.env.PROOF_VERIFIER;
const signerSecret = process.env.STELLAR_SECRET_KEY;

if (!proofType || !verifierId || !signerSecret) {
  console.error("[anchor_worker] missing env vars");
  process.exit(1);
}

try {
  const { tx_hash } = await anchorProof({ proofType, verifierId, signerSecret });
  console.log(`[anchor_worker] anchored (non-replayable): ${tx_hash}`);
} catch (err) {
  console.error("[anchor_worker] failed:", err?.message ?? err);
}
process.exit(0);
