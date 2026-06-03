const SECTIONS = [
  {
    title: "Deployed Contracts",
    emoji: "🔗",
    links: [
      {
        label: "proof_verifier",
        sub: "Groth16 / BLS12-381 on-chain",
        href: "https://stellar.expert/explorer/testnet/contract/CCGZ4HGNOZ4WKXSTGG6KS6XUAGQ3DEIHZRYWSJBWXVAN4TZG2MWQGNZC",
      },
      {
        label: "lending_pool",
        sub: "Deposit · borrow · repay",
        href: "https://stellar.expert/explorer/testnet/contract/CAUBK4VA6X3H2Y5I53736RPBREQYC42QIF4QPFZETS6ZHKXYOBCSUKMU",
      },
      {
        label: "risk_policy",
        sub: "Trust score → rate tier",
        href: "https://stellar.expert/explorer/testnet/contract/CBSQ4WCUJXT3QT3U7MVTMOY3IAWQYGNCFQSLQKDR6Q4LCRAUVWR36FGL",
      },
      {
        label: "rate_calculator",
        sub: "Simple interest math",
        href: "https://stellar.expert/explorer/testnet/contract/CDFPXWVLZPTQ4EIOWQHG6DOA5VG3O32OHLFRQYUWIYBMP4FS7YTH77KB",
      },
    ],
  },
  {
    title: "Zero-Knowledge",
    emoji: "🔐",
    links: [
      {
        label: "CAP-0059 — BLS12-381",
        sub: "Stellar on-chain ZK host functions",
        href: "https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md",
      },
      {
        label: "Groth16 verifier example",
        sub: "soroban-examples reference",
        href: "https://github.com/stellar/soroban-examples/tree/main/groth16_verifier",
      },
      {
        label: "circom2 compiler",
        sub: "BLS12-381 circuit DSL",
        href: "https://docs.circom.io",
      },
      {
        label: "snarkjs",
        sub: "Off-chain proof generation",
        href: "https://github.com/iden3/snarkjs",
      },
    ],
  },
  {
    title: "x402 Machine Payments",
    emoji: "⚡",
    links: [
      {
        label: "x402 Protocol",
        sub: "HTTP 402 paid API standard",
        href: "https://x402.org",
      },
      {
        label: "OZ Channels Facilitator",
        sub: "Fee-sponsored USDC settlement",
        href: "https://channels.openzeppelin.com",
      },
      {
        label: "@x402/stellar",
        sub: "Stellar auth-entry signing client",
        href: "https://www.npmjs.com/package/@x402/stellar",
      },
      {
        label: "Verify tx on explorer",
        sub: "On-chain ZK proof",
        href: "https://stellar.expert/explorer/testnet/tx/625edea90e14d4b8fd0307245d0cd59e065ac99d0840c27a5a00e582823d90a2",
      },
    ],
  },
  {
    title: "Stellar / Soroban",
    emoji: "🌟",
    links: [
      {
        label: "Soroban docs",
        sub: "Smart contract development",
        href: "https://developers.stellar.org/docs/build/smart-contracts",
      },
      {
        label: "Stellar Wallets Kit",
        sub: "Multi-wallet browser integration",
        href: "https://stellarwalletskit.dev",
      },
      {
        label: "Testnet explorer",
        sub: "stellar.expert / testnet",
        href: "https://stellar.expert/explorer/testnet",
      },
      {
        label: "Stellar RPC",
        sub: "soroban-testnet.stellar.org",
        href: "https://developers.stellar.org/docs/data/apis/rpc",
      },
    ],
  },
];

export default function TechLinks() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {SECTIONS.map((s) => (
        <div key={s.title} className="card !p-4">
          <div className="mb-3 flex items-center gap-2">
            <span>{s.emoji}</span>
            <span className="text-sm font-semibold">{s.title}</span>
          </div>
          <ul className="space-y-2">
            {s.links.map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col hover:bg-white/5 rounded-lg p-1 -mx-1 transition"
                >
                  <span className="text-sm text-accent group-hover:text-accent2 transition">
                    {l.label} ↗
                  </span>
                  <span className="text-xs text-white/40">{l.sub}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
