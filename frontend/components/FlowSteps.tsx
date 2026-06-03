const STEPS = [
  {
    n: "1",
    t: "ZK Proof",
    d: "Borrower runs the Groth16 / BLS12-381 circuit locally (WASM). Income, debt, and employment figures stay on the device — only a 192-byte proof is transmitted.",
  },
  {
    n: "2",
    t: "Risk Oracle",
    d: "Soroban's Groth16 verifier checks the proof on-chain. The Risk Agent then receives the verified public outputs and deterministically derives a tier (1–4) and trust score (0–100) using fixed rules — no AI model, no manual review. The Risk Agent is compensated via x402 micropayments.",
  },
  {
    n: "3",
    t: "Dual Signature",
    d: "Oracle and borrower each sign the loan transaction as separate Soroban auth entries. Neither can initiate the loan alone. The oracle's signature covers the trust score as a function argument — a borrower cannot alter the score without invalidating the oracle's signature.",
  },
  {
    n: "4",
    t: "On-chain Loan",
    d: "No bank, no credit bureau, no loan officer. The contract reads a ZK-proven risk tier, locks the rate, and disburses USDC atomically — credit priced by proven financial behavior, not personal identity.",
  },
];

export default function FlowSteps() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((s) => (
        <div key={s.n} className="card !p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-accent/30 to-accent2/20 font-mono text-xs font-bold text-accent2 border border-accent/20">
              {s.n}
            </span>
            <span className="font-medium">{s.t}</span>
          </div>
          <p className="text-sm leading-relaxed text-white/55">{s.d}</p>
        </div>
      ))}
    </div>
  );
}
