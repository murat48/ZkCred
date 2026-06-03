import BorrowPanel from "@/components/BorrowPanel";
import FlowSteps from "@/components/FlowSteps";
import TechLinks from "@/components/TechLinks";

function PrivacyDiagram() {
  return (
    <div className="card overflow-hidden">
      <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-edge/50">
        {/* Private side */}
        <div className="p-5">
          <div className="label mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-bad/60" />
            Your device (private)
          </div>
          <div className="space-y-1.5 text-sm text-white/50">
            {[
              "Monthly income: $4,200",
              "Debt: $800 / month",
              "Employment: 18 months",
              "Defaults: 0",
              "Bill payments: regular",
            ].map((item) => (
              <div key={item} className="flex items-center gap-2">
                <span className="text-bad/50 text-xs">✗</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[11px] text-white/20 italic">never transmitted</div>
        </div>

        {/* ZK Circuit middle */}
        <div className="p-5 flex flex-col items-center justify-center text-center gap-3">
          <div className="label">ZK Circuit (Groth16)</div>
          <div className="rounded-xl border border-accent/30 bg-accent/[0.08] px-4 py-3">
            <div className="font-mono text-xs text-accent/80">creditworthiness.circom</div>
            <div className="mt-1 text-[10px] text-white/30">BLS12-381 elliptic curve</div>
          </div>
          <div className="flex items-center gap-3 text-white/25 text-lg font-light">
            <span className="text-sm">private inputs →</span>
          </div>
          <div className="text-[11px] text-white/30 leading-relaxed max-w-[180px]">
            proves thresholds are met without revealing any values
          </div>
        </div>

        {/* Public side */}
        <div className="p-5">
          <div className="label mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-good/70" />
            Stellar Testnet (public)
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center gap-2 text-good">
              <span className="text-xs">✓</span> Tier: GREEN
            </div>
            <div className="flex items-center gap-2 text-white/50">
              <span className="text-xs text-white/25">+</span> Rate: 10% p.a.
            </div>
            <div className="flex items-center gap-2 text-white/50">
              <span className="text-xs text-white/25">+</span> Loan amount
            </div>
            <div className="flex items-center gap-2 text-white/50">
              <span className="text-xs text-white/25">+</span> Proof: ✓ verified
            </div>
          </div>
          <div className="mt-3 text-[11px] text-white/20 italic">no financial data recorded</div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title, sub, children,
}: {
  title: string; sub?: string; children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <h2 className="text-xl font-semibold">{title}</h2>
      {sub && <p className="mb-5 mt-1 text-sm text-white/45">{sub}</p>}
      {!sub && <div className="mb-5" />}
      {children}
    </section>
  );
}

export default function Home() {
  return (
    <main>
      {/* Hero */}
      <div className="mb-16 max-w-3xl">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/[0.08] px-3 py-1 text-xs text-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          Live on Stellar Testnet · 4 contracts deployed
        </div>
        <h1 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          Prove you&apos;re creditworthy.{" "}
          <span className="bg-gradient-to-r from-accent via-purple-400 to-accent2 bg-clip-text text-transparent">
            Reveal nothing.
          </span>
        </h1>
        <p className="mt-5 text-base leading-relaxed text-white/55 max-w-2xl">
          zkCredit is a privacy-preserving credit layer for DeFi lending. Borrowers prove their
          financial standing with Zero-Knowledge proofs (Groth16 / BLS12-381 on Stellar Soroban).
          Lenders get a verifiable trust score purchased via x402 machine-to-machine USDC payment —
          no transaction history, wallet address, or income ever exposed.
        </p>
        <div className="mt-6 flex flex-wrap gap-2 text-xs">
          {[
            ["ZK proofs on Stellar", "https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md"],
            ["x402 protocol", "https://x402.org"],
            ["4 contracts live on testnet", "https://stellar.expert/explorer/testnet"],
          ].map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noopener noreferrer"
               className="pill border-accent/30 text-accent/80 hover:text-accent hover:border-accent/60 transition">
              {label} ↗
            </a>
          ))}
        </div>
      </div>

      {/* Main panel */}
      <Section
        title="Request your rate"
        sub="Connect your wallet to use real on-chain signals, then run the Creditworthiness Proof pipeline."
      >
        <BorrowPanel />
      </Section>

      {/* Privacy model */}
      <Section
        title="Your data never leaves your device"
        sub="The ZK circuit proves thresholds are met without ever revealing the underlying values. The blockchain records only the outcome."
      >
        <PrivacyDiagram />
      </Section>

      {/* How it works */}
      <Section title="How it works">
        <FlowSteps />
      </Section>

      {/* The problem */}
      <Section
        title="The problem with current DeFi lending"
        sub="Capital-inefficient and reputation-blind."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["150–300%", "Overcollateralization required by most protocols today."],
            ["1 flat rate", "Charged to everyone, regardless of repayment history."],
            ["0 privacy", "No mechanism to prove financial identity confidentially."],
          ].map(([big, small]) => (
            <div key={big} className="card !p-5">
              <div className="text-2xl font-bold text-accent2">{big}</div>
              <p className="mt-1 text-sm text-white/55">{small}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Tech links */}
      <Section
        title="Resources & contracts"
        sub="All four contracts are live on Stellar Testnet. Proof verified on-chain."
      >
        <TechLinks />
      </Section>
    </main>
  );
}
