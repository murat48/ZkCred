"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@/contexts/WalletContext";
import type { Quote, CreditClaims } from "@/lib/types";


const PHASES = [
  "Fetching creditworthiness attestation…",
  "Risk Oracle evaluating claims (off-chain)…",
  "x402 machine payment: protocol → oracle…",
  "Computing tier from financial attributes…",
];

const BORROW_PHASES = [
  "Generating ZK proof (private financial data → tier)…",
  "Submitting borrow_with_proof to lending_pool…",
  "proof_verifier: BLS12-381 pairing + anti-replay…",
  "risk_policy → rate_calculator → USDC transfer…",
];

interface InstallmentInfo {
  slot: number;
  tx_hash: string;
  amount_stroops: string;
}

interface LoanResult {
  onchain_tx?: string;
  onchain_kind: string;
  repaid_first?: boolean;
  onchain_amount?: number;
  onchain_term_days?: number;
  borrower?: string;
  oracle?: string;
  installments?: InstallmentInfo[];
}

interface ActiveLoan {
  active: true;
  outstanding_usdc: number;
  total_due: string;
  repaid: string;
  outstanding: string;
  term_days?: number;
  expiry_ledger?: number;
  current_ledger?: number;
  seconds_remaining?: number;
}

interface InstallmentSlot {
  slot: number;
  active: boolean;
  outstanding_usdc?: number;
  outstanding?: string;
  total_due?: string;
  repaid?: string;
  term_days?: number;
  seconds_remaining?: number;
}

function fmtTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "Expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function fmtU(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function rateCol(bps: number) {
  if (bps <= 600) return "text-good";
  if (bps <= 1000) return "text-accent2";
  return "text-bad";
}

function tierColor(label: string) {
  if (label === "PRIME")  return "border-good/40 bg-good/10 text-good";
  if (label === "GREEN")  return "border-accent/30 bg-accent/10 text-accent";
  if (label === "YELLOW") return "border-warn/40 bg-warn/10 text-warn";
  return "border-bad/40 bg-bad/10 text-bad";
}

function tierPillColor(label: string) {
  if (label === "PRIME")  return "border-good/40 text-good";
  if (label === "GREEN")  return "border-accent/40 text-accent";
  if (label === "YELLOW") return "border-warn/40 text-warn";
  return "border-bad/40 text-bad";
}

// Creditworthiness claim row — shows claim label + pass/fail
// Never shows the actual value, only whether threshold is met.
function ClaimRow({ label, threshold, passed }: { label: string; threshold: string; passed: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-edge/40">
      <div>
        <span className="text-xs text-white/70 font-medium">{label}</span>
        <span className="ml-2 text-xs text-white/30">{threshold}</span>
      </div>
      <span className={`text-sm font-bold ${passed ? "text-good" : "text-bad"}`}>
        {passed ? "✓" : "✗"}
      </span>
    </div>
  );
}

function X402Badge({ paid, mode, tx, error }: { paid: boolean; mode: string; tx?: string; error?: string }) {
  if (paid) {
    const href = tx ? `https://stellar.expert/explorer/testnet/tx/${tx}` : "https://x402.org";
    return (
      <a href={href} target="_blank" rel="noopener noreferrer"
         className="pill border-good/40 text-good hover:border-good/80 transition"
         title={tx ? `USDC settlement tx ${tx}` : undefined}>
        ⚡ x402 live payment ↗
      </a>
    );
  }
  if (mode === "live") {
    return <span className="pill border-bad/40 text-bad" title={error ?? "live payment failed"}>⚡ x402 live failed</span>;
  }
  return (
    <a href="https://x402.org" target="_blank" rel="noopener noreferrer"
       className="pill border-warn/40 text-warn hover:border-warn/70 transition"
       title="Set X402_MODE=live + STELLAR_SECRET_KEY with USDC to enable real payments">
      ⚡ x402 mock ↗
    </a>
  );
}

function PipelineLoader({ phase }: { phase: string }) {
  const nodes: [string, string][] = [
    ["Horizon", "on-chain data"],
    ["bank_agent", "Ed25519 signed"],
    ["Oracle", "sig verified"],
    ["ZK Circuit", "Groth16"],
    ["Tier", "only this ↗"],
  ];
  return (
    <div className="m-auto w-full space-y-5 text-center">
      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent" />
      <div className="text-sm text-white/60">{phase}</div>
      <div className="flex items-start justify-center gap-0.5 text-[10px] flex-wrap">
        {nodes.map(([label, sub], i) => (
          <div key={label} className="flex items-start gap-0.5">
            <div className="text-center px-1">
              <div className="text-white/55 font-medium leading-none">{label}</div>
              <div className="text-white/25 mt-0.5 leading-none">{sub}</div>
            </div>
            {i < nodes.length - 1 && (
              <span className="text-white/20 mt-0.5 leading-none">→</span>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-white/25 italic">
        income · debt · history — never leave your device
      </p>
    </div>
  );
}

interface RowProps { k: string; v: string; strong?: boolean; href?: string }
function Row({ k, v, strong, href }: RowProps) {
  return (
    <div className="flex items-center justify-between border-b border-edge/60 pb-2">
      <dt className="text-white/50">{k}</dt>
      <dd className={strong ? "font-semibold text-white" : "text-white/80"}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer"
             className="hover:text-accent2 underline decoration-dotted transition">
            {v} ↗
          </a>
        ) : v}
      </dd>
    </div>
  );
}

export default function BorrowPanel() {
  const { address, signals: walletSignals, meta, signalsLoading, signTransaction } = useWallet();
  const proofType = "creditworthiness" as const;
  const [loanProduct, setLoanProduct] = useState<"daily" | "monthly" | "installment_3m">("monthly");
  const [customDays, setCustomDays] = useState(7);
  const [amount, setAmount] = useState(1); // USDC
  const [term, setTerm] = useState(30);
  const [quote, setQuote] = useState<(Quote & { x402_paid: boolean; x402_mode: string; attest?: any }) | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [borrowPhase, setBorrowPhase] = useState<string | null>(null);
  const [loan, setLoan] = useState<LoanResult | null>(null);
  const [borrowError, setBorrowError] = useState<string | null>(null);
  const [activeLoan, setActiveLoan] = useState<ActiveLoan | null>(null);
  const [loanLoading, setLoanLoading] = useState(false);
  const [repayPhase, setRepayPhase] = useState<string | null>(null);
  const [repayError, setRepayError] = useState<string | null>(null);
  const [repayTx, setRepayTx] = useState<string | null>(null);
  const [expiryLedger, setExpiryLedger] = useState<number | null>(null);
  const [currentLedger, setCurrentLedger] = useState<number | null>(null);
  const [fundPhase, setFundPhase] = useState<string | null>(null);
  const [fundTx, setFundTx] = useState<string | null>(null);
  const [demoAddress, setDemoAddress] = useState<string | null>(null);
  const [installmentSlots, setInstallmentSlots] = useState<InstallmentSlot[]>([]);
  const [installmentLoading, setInstallmentLoading] = useState(false);
  const [poolUsdc, setPoolUsdc] = useState<number | null>(null);
  const [installmentRepayPhase, setInstallmentRepayPhase] = useState<Record<number, string | null>>({});
  const [installmentRepayError, setInstallmentRepayError] = useState<Record<number, string | null>>({});
  const [installmentRepayTx, setInstallmentRepayTx] = useState<Record<number, string | null>>({});

  // Demo wallets — hardcoded profiles in MockBank, no wallet connection needed
  const DEMO_WALLETS = [
    { label: "PRIME", addr: "GDYSNQ74SSCADPFFEIAVWVDIXZNJ5WF3J7LDRBMPW3VFJJHB7SSJ2TEQ", desc: "All 6 criteria — 5%" },
    { label: "GREEN", addr: "GAKPIGNGOWAS75N6SSJVYPVI574JWBSDLUJASIRN6XSM5G3TWE3WAU3S", desc: "5/6 criteria — 10%" },
    { label: "YELLOW", addr: "GBUUARFXB2VJDPSC4UBU5JWOU3VBSS64P67GJFIIHAM5SPKSBNS52ZUU", desc: "3/6 criteria — 20%" },
    { label: "REJECT", addr: "GAP447AIRSJ4IXJ4CC3QCLFTN4NE3Z7UXO7T5LZVFOXYMOBLR62AYR7Q", desc: "Default detected — proof impossible" },
  ] as const;

  const activeBorrower = address ?? demoAddress ?? undefined;

  async function requestFund() {
    if (!address) return;
    setFundPhase("Requesting testnet USDC from oracle…");
    setFundTx(null);
    try {
      const res = await fetch("/api/demo/fund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrower: address }),
      }).then(r => r.json());
      if (res?.error) { setFundPhase(`Failed: ${res.error}`); return; }
      setFundTx(res.tx_hash);
      setFundPhase(null);
    } catch (e: any) {
      setFundPhase(`Error: ${e.message}`);
    }
  }

  useEffect(() => {
    if (!address) { setActiveLoan(null); return; }
    setLoanLoading(true);
    fetch(`/api/loan/status?account=${address}`)
      .then((r) => r.json())
      .then((d) => setActiveLoan(d?.active ? d : null))
      .catch(() => setActiveLoan(null))
      .finally(() => setLoanLoading(false));
  }, [address]);

  useEffect(() => {
    if (!address) { setInstallmentSlots([]); return; }
    setInstallmentLoading(true);
    fetch(`/api/installment/status?account=${address}`)
      .then((r) => r.json())
      .then((d) => setInstallmentSlots(d?.slots ?? []))
      .catch(() => setInstallmentSlots([]))
      .finally(() => setInstallmentLoading(false));
  }, [address, loan]); // refresh after a new loan

  useEffect(() => {
    fetch("/api/pool/status")
      .then((r) => r.json())
      .then((d) => typeof d?.available_usdc === "number" ? setPoolUsdc(d.available_usdc) : null)
      .catch(() => null);
  }, [loan]); // refresh after borrow/repay

  async function repayInstallmentSlot(slot: number) {
    if (!address || !signTransaction) return;
    setInstallmentRepayError(p => ({ ...p, [slot]: null }));
    setInstallmentRepayTx(p => ({ ...p, [slot]: null }));
    try {
      setInstallmentRepayPhase(p => ({ ...p, [slot]: "Building repay transaction…" }));
      const prep = await fetch("/api/installment/repay/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrower: address, slot }),
      }).then((r) => r.json());
      if (prep?.error || !prep?.xdr) {
        setInstallmentRepayError(p => ({ ...p, [slot]: prep?.error ?? "could not prepare repay" }));
        setInstallmentRepayPhase(p => ({ ...p, [slot]: null }));
        return;
      }
      setInstallmentRepayPhase(p => ({ ...p, [slot]: "Awaiting your signature…" }));
      const signedXdr = await signTransaction(prep.xdr);
      setInstallmentRepayPhase(p => ({ ...p, [slot]: "Submitting repayment to Soroban…" }));
      const out = await fetch("/api/installment/repay/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedXdr, borrower: address, slot }),
      }).then((r) => r.json());
      if (out?.error || !out?.onchain_tx) {
        setInstallmentRepayError(p => ({ ...p, [slot]: out?.error ?? "repay submit failed" }));
        setInstallmentRepayPhase(p => ({ ...p, [slot]: null }));
        return;
      }
      setInstallmentRepayTx(p => ({ ...p, [slot]: out.onchain_tx }));
      setInstallmentSlots(prev => prev.map(s => s.slot === slot ? { ...s, active: false } : s));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/reject|denied|cancel|User declined/i.test(msg)) setInstallmentRepayError(p => ({ ...p, [slot]: "Signature cancelled." }));
      else setInstallmentRepayError(p => ({ ...p, [slot]: msg }));
    } finally {
      setInstallmentRepayPhase(p => ({ ...p, [slot]: null }));
    }
  }

  async function repayLoan() {
    if (!address || !signTransaction) return;
    setRepayError(null);
    setRepayTx(null);
    try {
      setRepayPhase("Building repay transaction…");
      const prep = await fetch("/api/loan/repay/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrower: address }),
      }).then((r) => r.json());
      if (prep?.error || !prep?.xdr) {
        setRepayError(prep?.error ?? "could not prepare repay");
        setRepayPhase(null);
        return;
      }
      setRepayPhase("Awaiting your signature…");
      const signedXdr = await signTransaction(prep.xdr);
      setRepayPhase("Submitting repayment to Soroban…");
      const out = await fetch("/api/loan/repay/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedXdr, borrower: address }),
      }).then((r) => r.json());
      if (out?.error || !out?.onchain_tx) {
        setRepayError(out?.error ?? "repay submit failed");
        setRepayPhase(null);
        return;
      }
      setRepayTx(out.onchain_tx);
      setActiveLoan(null);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/reject|denied|cancel|User declined/i.test(msg)) setRepayError("Signature cancelled.");
      else setRepayError(msg);
    } finally {
      setRepayPhase(null);
    }
  }

  const proofTypeSignals: Record<string, any> = {
    solvency:  { income_ok: true, solvency_ok: true },
    repayment: { repayment_ok: true },
  };
  const signals = address
    ? { ...walletSignals, ...(proofTypeSignals[proofType] ?? {}) }
    : proofTypeSignals[proofType] ?? {};

  async function requestRate() {
    setQuote(null);
    setLoan(null);
    setBorrowError(null);

    const phaseList = proofType === "creditworthiness" ? PHASES : [
      "Generating ZK proof (Groth16 / BLS12-381)…",
      "Risk Oracle verifying proof (snarkjs)…",
      "x402 machine payment: protocol → oracle…",
      "Anchoring ZK proof on-chain (Soroban)…",
    ];
    for (const p of phaseList) {
      setPhase(p);
      await new Promise((r) => setTimeout(r, 340));
    }
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType,
          signals,
          principal: amount,
          loan_product: loanProduct,
          custom_days: loanProduct === "daily" ? customDays : undefined,
          borrower: activeBorrower,
        }),
      });
      setQuote(await res.json());
    } finally {
      setPhase(null);
    }
  }

  async function confirmBorrow() {
    if (!quote) return;
    setBorrowError(null);
    setLoan(null);
    if (address) return confirmBorrowWithWallet();

    let i = 0;
    setBorrowPhase(BORROW_PHASES[0]);
    const ticker = setInterval(() => {
      i = Math.min(i + 1, BORROW_PHASES.length - 1);
      setBorrowPhase(BORROW_PHASES[i]);
    }, 4000);
    try {
      const res = await fetch("/api/borrow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType,
          signals,
          trust_score: quote.trust_score,
          loan_product: loanProduct,
          custom_days: loanProduct === "daily" ? customDays : undefined,
          amount,
        }),
      });
      const data = await res.json();
      if (!res.ok) setBorrowError(data?.error ?? "borrow failed");
      else {
        setLoan(data);
        if (data.expiry_ledger) setExpiryLedger(data.expiry_ledger);
      }
    } catch (e: any) {
      setBorrowError(String(e?.message ?? e));
    } finally {
      clearInterval(ticker);
      setBorrowPhase(null);
    }
  }

  async function confirmBorrowWithWallet() {
    if (!quote || !address) return;
    try {
      setBorrowPhase("Checking USDC trustline…");
      const tl = await fetch(`/api/borrow/trustline?account=${address}`).then((r) => r.json());
      if (tl && tl.has_trustline === false) {
        setBorrowError("Your wallet has no USDC trustline. Add USDC asset (issuer GBBD…FLA5) in your wallet, then try again.");
        setBorrowPhase(null);
        return;
      }

      // ── installment_3m: 3 sequential prepare→sign→submit cycles ──────────────
      if (loanProduct === "installment_3m") {
        const installments: InstallmentInfo[] = [];
        for (let slot = 0; slot < 3; slot++) {
          setBorrowPhase(`Installment ${slot + 1}/3 — generating ZK proof…`);
          const prep = await fetch("/api/borrow/prepare/installment", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              proofType,
              borrower: address,
              slot,
              amount,
            }),
          }).then((r) => r.json());
          if (prep?.error || !prep?.xdr) {
            setBorrowError(prep?.error ?? `slot ${slot} prepare failed`);
            setBorrowPhase(null);
            return;
          }
          setBorrowPhase(`Installment ${slot + 1}/3 — waiting for your signature…`);
          const signedXdr = await signTransaction(prep.xdr);
          setBorrowPhase(`Installment ${slot + 1}/3 — submitting to Soroban…`);
          const out = await fetch("/api/borrow/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signedXdr }),
          }).then((r) => r.json());
          if (out?.error || !out?.onchain_tx) {
            setBorrowError(out?.error ?? `slot ${slot} submit failed`);
            setBorrowPhase(null);
            return;
          }
          installments.push({ slot, tx_hash: out.onchain_tx, amount_stroops: String(prep.onchain_amount ?? 0) });
        }
        setLoan({
          onchain_kind: "installment_3m",
          installments,
          onchain_amount: amount * 1e7,
          onchain_term_days: 30,
          borrower: address,
          oracle: undefined,
        });
        // Refresh installment status
        fetch(`/api/installment/status?account=${address}`)
          .then((r) => r.json())
          .then((d) => setInstallmentSlots(d?.slots ?? []));
        return;
      }

      setBorrowPhase("Building loan tx (oracle generates ZK proof + co-signs)…");
      const prep = await fetch("/api/borrow/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType,
          trust_score: quote.trust_score,
          borrower: address,
          loan_product: loanProduct,
          custom_days: loanProduct === "daily" ? customDays : undefined,
          amount,
        }),
      }).then((r) => r.json());
      if (prep?.error || !prep?.xdr) {
        setBorrowError(prep?.error ?? "could not prepare loan");
        setBorrowPhase(null);
        return;
      }

      setBorrowPhase("Awaiting your signature…");
      const signedXdr = await signTransaction(prep.xdr);

      setBorrowPhase("Submitting to Soroban…");
      const out = await fetch("/api/borrow/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedXdr }),
      }).then((r) => r.json());
      if (out?.error || !out?.onchain_tx) {
        setBorrowError(out?.error ?? "submit failed");
        setBorrowPhase(null);
        return;
      }

      setLoan({
        onchain_tx: out.onchain_tx,
        onchain_kind: "borrow_with_proof",
        onchain_amount: prep.onchain_amount,
        onchain_term_days: prep.onchain_term_days,
        borrower: prep.borrower,
        oracle: prep.oracle,
      });
      if (prep.expiry_ledger) setExpiryLedger(prep.expiry_ledger);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/reject|denied|cancel|User declined/i.test(msg)) setBorrowError("Signature cancelled.");
      else setBorrowError(msg);
    } finally {
      setBorrowPhase(null);
    }
  }

  const tierLabel = (quote as any)?.tier_label ?? quote?.attest?.tier_label;
  const claims: CreditClaims | undefined = (quote as any)?.claims ?? quote?.attest?.claims;
  const isReject = tierLabel === "REJECT" || tierLabel === "RED";
  const isCreditworthiness = proofType === "creditworthiness";

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Controls */}
      <div className="card space-y-5">
        {/* Demo wallet selector — works without connecting a real wallet */}
        {isCreditworthiness && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
            <div className="text-xs text-white/40 font-medium uppercase tracking-wider">Demo Wallets</div>
            <div className="grid grid-cols-2 gap-1.5">
              {DEMO_WALLETS.map(w => (
                <button
                  key={w.addr}
                  onClick={() => { setDemoAddress(w.addr); setQuote(null); }}
                  className={`rounded-lg border px-2 py-1.5 text-left transition text-xs
                    ${demoAddress === w.addr && !address
                      ? tierColor(w.label) + " opacity-100"
                      : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/70"
                    }`}>
                  <span className={`font-bold ${w.label === "PRIME" ? "text-good" : w.label === "GREEN" ? "text-accent" : w.label === "YELLOW" ? "text-warn" : "text-bad"}`}>
                    {w.label}
                  </span>
                  <span className="ml-1.5 text-white/35">{w.desc}</span>
                </button>
              ))}
            </div>
            {demoAddress && !address && (
              <div className="text-[10px] text-white/30 truncate">
                Using: {demoAddress.slice(0, 8)}…{demoAddress.slice(-6)}
              </div>
            )}
          </div>
        )}

        {/* Wallet info */}
        {address ? (
          <div className="rounded-xl border border-good/20 bg-good/5 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-good font-medium">Wallet connected</span>
              {signalsLoading && (
                <span className="text-xs text-white/40 animate-pulse">fetching Horizon data…</span>
              )}
            </div>
            {meta && !signalsLoading && (
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/60">
                <span className="pill border-edge">wallet age: <b className="text-white/80">{meta.wallet_age_days}d</b></span>
                <span className="pill border-edge">txns: <b className="text-white/80">{meta.tx_count}</b></span>
                <span className="pill border-edge">XLM: <b className="text-white/80">{parseFloat(meta.xlm_balance).toFixed(0)}</b></span>
                {parseFloat(meta.usdc_balance) > 0 && (
                  <span className="pill border-good/30 text-good">USDC: <b>{parseFloat(meta.usdc_balance).toFixed(2)}</b></span>
                )}
                <a href={`https://stellar.expert/explorer/testnet/account/${address}`}
                   target="_blank" rel="noopener noreferrer"
                   className="pill border-accent/30 text-accent hover:border-accent/60 transition">
                  view on explorer ↗
                </a>
              </div>
            )}
            {/* Get demo USDC — helps when USDC balance is too low to repay */}
            {meta && parseFloat(meta.usdc_balance) < 1.5 && (
              <div className="mt-2 flex items-center gap-2">
                <button onClick={requestFund} disabled={!!fundPhase}
                        className="text-xs px-2 py-1 rounded-lg border border-accent/30 text-accent hover:border-accent/60 transition">
                  {fundPhase ? "Sending…" : "Get 2 demo USDC"}
                </button>
                {fundTx && (
                  <a href={`https://stellar.expert/explorer/testnet/tx/${fundTx}`}
                     target="_blank" rel="noopener noreferrer"
                     className="text-xs text-good">
                    ✓ funded ↗
                  </a>
                )}
                {fundPhase && fundPhase.startsWith("Failed") && (
                  <span className="text-xs text-bad">{fundPhase}</span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-sm text-white/50">
            Connect wallet for real creditworthiness scoring, or request a demo rate.
          </div>
        )}

        {/* Active loan banner */}
        {address && loanLoading && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-white/40 animate-pulse">
            Checking for active loan…
          </div>
        )}

        {address && !loanLoading && activeLoan && !repayTx && (
          <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-warn font-semibold text-sm">Active loan — repay first</div>
                <div className="mt-1 text-white/60 text-xs space-y-0.5">
                  <div>Outstanding: <b className="text-white/90">{fmtU(activeLoan.outstanding_usdc)} USDC</b></div>
                  {activeLoan.seconds_remaining != null && (
                    <div className={activeLoan.seconds_remaining <= 0 ? "text-bad" : "text-white/50"}>
                      ⏱ {fmtTimeRemaining(activeLoan.seconds_remaining)}
                      {activeLoan.term_days && (
                        <span className="ml-1 text-white/30">({activeLoan.term_days}-day loan)</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <span className="pill border-warn/40 text-warn text-xs">active</span>
            </div>
            <button onClick={repayLoan} disabled={!!repayPhase}
                    className="btn-primary w-full !bg-warn/20 !border-warn/40 hover:!bg-warn/30 !text-warn">
              {repayPhase ? "Repaying…" : `Repay ${fmtU(activeLoan.outstanding_usdc)} USDC`}
            </button>
            {repayPhase && (
              <div className="flex items-center gap-2 text-xs text-white/60">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-warn" />
                {repayPhase}
              </div>
            )}
            {repayError && (
              <div className="rounded-lg border border-bad/30 bg-bad/5 p-2 text-xs text-bad break-words">
                Repay failed: {repayError}
              </div>
            )}
          </div>
        )}

        {address && !loanLoading && repayTx && (
          <div className="rounded-xl border border-good/30 bg-good/5 p-3 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-good font-medium">✓ Loan repaid</span>
              <a href={`https://stellar.expert/explorer/testnet/tx/${repayTx}`}
                 target="_blank" rel="noopener noreferrer"
                 className="text-white/40 hover:text-accent2 underline decoration-dotted">
                tx {repayTx.slice(0, 8)}… ↗
              </a>
            </div>
          </div>
        )}

        {/* Installment loan slots — repay panel */}
        {address && !installmentLoading && installmentSlots.some(s => s.active) && (
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-accent font-semibold text-sm">3-Month Installment Loan</div>
              <span className="pill border-accent/40 text-accent text-xs">active</span>
            </div>
            <div className="space-y-2">
              {installmentSlots.map((s) => (
                <div key={s.slot} className={`rounded-lg border p-3 space-y-2 ${
                  s.active ? "border-accent/20 bg-accent/[0.04]" : "border-good/20 bg-good/[0.04] opacity-60"
                }`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-semibold text-white/80">Installment {s.slot + 1}</span>
                      <span className="ml-2 text-xs text-white/30">Due on day {(s.slot + 1) * 30}</span>
                    </div>
                    {s.active ? (
                      <span className="text-accent font-mono text-xs">
                        {fmtU(s.outstanding_usdc ?? 0)} USDC remaining
                      </span>
                    ) : (
                      <span className="text-good text-xs font-medium">✓ Paid</span>
                    )}
                  </div>
                  {s.active && !installmentRepayTx[s.slot] && (
                    <>
                      {s.seconds_remaining != null && (
                        <div className={`text-xs ${s.seconds_remaining <= 0 ? "text-bad" : "text-white/40"}`}>
                          ⏱ {fmtTimeRemaining(s.seconds_remaining)}
                        </div>
                      )}
                      <button
                        onClick={() => repayInstallmentSlot(s.slot)}
                        disabled={!!installmentRepayPhase[s.slot]}
                        className="btn-primary w-full !bg-accent/20 !border-accent/40 hover:!bg-accent/30 !text-accent text-xs py-1.5">
                        {installmentRepayPhase[s.slot] ? "Paying…" : `Pay installment ${s.slot + 1} — ${fmtU(s.outstanding_usdc ?? 0)} USDC`}
                      </button>
                      {installmentRepayPhase[s.slot] && (
                        <div className="flex items-center gap-2 text-xs text-white/50">
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-accent" />
                          {installmentRepayPhase[s.slot]}
                        </div>
                      )}
                      {installmentRepayError[s.slot] && (
                        <div className="rounded-lg border border-bad/30 bg-bad/5 p-2 text-xs text-bad break-words">
                          {installmentRepayError[s.slot]}
                        </div>
                      )}
                    </>
                  )}
                  {installmentRepayTx[s.slot] && (
                    <a href={`https://stellar.expert/explorer/testnet/tx/${installmentRepayTx[s.slot]}`}
                       target="_blank" rel="noopener noreferrer"
                       className="text-xs text-good hover:text-good/80">
                      ✓ tx {installmentRepayTx[s.slot]!.slice(0, 8)}… ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Loan product selector */}
        <div>
          <div className="label mb-2">Loan type</div>
          <div className="grid grid-cols-3 gap-1.5">
            {([
              ["daily",          "Daily",              "1–27 days"],
              ["monthly",        "Monthly",            "30 days"],
              ["installment_3m", "3-Month Installment","3×30 days"],
            ] as const).map(([id, label, sub]) => (
              <button key={id} onClick={() => { setLoanProduct(id); setQuote(null); }}
                      className={`rounded-xl border px-2 py-2 text-xs text-left transition
                        ${loanProduct === id
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-white/[0.08] text-white/50 hover:border-white/20 hover:text-white/70"}`}>
                <div className="font-semibold">{label}</div>
                <div className="text-[10px] text-white/30 mt-0.5">{sub}</div>
              </button>
            ))}
          </div>

          {/* Daily: day selector */}
          {loanProduct === "daily" && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="label text-xs">Number of days</span>
                <span className="text-accent font-semibold text-sm">{customDays} days</span>
              </div>
              <input type="range" min={1} max={27} value={customDays}
                     onChange={(e) => setCustomDays(Number(e.target.value))}
                     className="w-full accent-accent" />
              <div className="flex justify-between text-[10px] text-white/30 mt-0.5">
                <span>1 day</span><span>27 days (max)</span>
              </div>
            </div>
          )}
        </div>

        {/* Amount + credit limit */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="label">Amount (USDC)</span>
            {quote && (quote as any).max_borrowable_usdc != null && (
              <span className="text-xs text-white/40">
                Limit:{" "}
                <span className="text-accent font-medium">
                  {fmtU((quote as any).max_borrowable_usdc)} USDC
                </span>
                {(quote as any).credit_ratio_pct != null && (
                  <span className="ml-1 text-white/30">
                    ({(quote as any).credit_ratio_pct}% of income)
                  </span>
                )}
              </span>
            )}
          </div>
          <input type="number" min={0.01} step={0.01}
                 max={(quote as any)?.max_borrowable_usdc ?? undefined}
                 value={amount}
                 onChange={(e) => setAmount(Number(e.target.value))}
                 className="w-full rounded-xl border border-white/[0.1] bg-white/[0.04] px-3 py-2.5 text-white outline-none focus:border-accent/70 focus:bg-white/[0.06] transition" />
        </div>

        <button onClick={requestRate}
                disabled={!!phase || signalsLoading || (!!address && !!activeLoan)}
                className="btn-primary w-full"
                title={address && activeLoan ? "Repay your active loan first" : undefined}>
          {phase ? "Working…" : isCreditworthiness && address
            ? "Check creditworthiness (ZK proof)"
            : "Request rate"}
        </button>
      </div>

      {/* Result */}
      <div className="card flex flex-col">
        {phase && <PipelineLoader phase={phase} />}

        {!phase && !quote && (
          <div className="m-auto text-center text-sm text-white/40">
            {address
              ? isCreditworthiness
                ? "Your creditworthiness claims will be proven via ZK — no salary or history revealed."
                : "Real on-chain signals loaded. Pick a proof type and request your rate."
              : "Connect wallet for real scoring, or request a demo rate."}
          </div>
        )}

        {!phase && quote && (
          <div className="flex h-full flex-col gap-4">

            {/* ── Creditworthiness: Tier is the decision ──────────────────── */}
            {isCreditworthiness ? (
              <>
                {/* Hero tier block */}
                <div className={`rounded-xl border p-5 text-center ${isReject
                  ? "border-bad/40 bg-bad/10"
                  : tierColor(tierLabel ?? "")}`}>
                  <div className="text-xs uppercase tracking-widest text-white/40 mb-2">
                    ZK Constraint Satisfaction Result
                  </div>
                  <div className={`text-5xl font-bold tracking-tight ${isReject ? "text-bad" : ""}`}>
                    {tierLabel ?? "—"}
                  </div>
                  {!isReject && (
                    <div className="mt-2 text-lg font-semibold text-white/70">
                      {quote.rate_pct}%
                      <span className="ml-1 text-sm font-normal text-white/40">/ annum</span>
                    </div>
                  )}
                  <div className="mt-2 text-xs text-white/30">
                    {isReject
                      ? "loan application rejected"
                      : "only this tier is recorded on-chain"}
                  </div>
                </div>

                {/* REJECT: mathematical impossibility explanation */}
                {isReject && (
                  <div className="rounded-xl border border-bad/30 bg-bad/5 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-bad font-bold text-sm">ZK Proof Mathematically Impossible</span>
                    </div>
                    <p className="text-xs text-white/60 leading-relaxed">
                      The circuit has two hard constraints:{" "}
                      <code className="text-white/80 bg-white/5 px-1 rounded">income_ok × default_ok === 1</code>.
                      Both must hold — a proof is cryptographically impossible if either fails.
                      This is a <b className="text-white/80">cryptographic guarantee</b>, not a policy.
                    </p>
                    {claims && (
                      <div className="flex flex-wrap gap-2 text-xs">
                        {!claims.income_ok && (
                          <span className="pill border-bad/40 text-bad">✗ income &lt; $2,000/mo</span>
                        )}
                        {!claims.default_ok && (
                          <span className="pill border-bad/40 text-bad">✗ defaults on record</span>
                        )}
                      </div>
                    )}
                    <div className="text-[11px] text-white/30 pt-1">
                      No repayment history? You still qualify — start with a YELLOW tier loan at 20%.
                    </div>
                    <div className="border-t border-white/[0.06] pt-3 text-xs text-white/40">
                      To qualify: <span className="text-warn">YELLOW</span> requires income ≥ $2k + zero defaults →{" "}
                      <span className="text-accent">GREEN</span> +2 more criteria →{" "}
                      <span className="text-good">PRIME</span> all 6 criteria
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* ── Legacy (solvency/repayment): rate + tier side by side ── */
              <div className="flex items-start justify-between">
                <div>
                  <div className="label">Personalised rate</div>
                  <div className={`text-5xl font-bold ${rateCol(quote.rate_bps)}`}>
                    {quote.rate_pct}%
                  </div>
                  <div className="mt-1 text-xs text-white/40">per annum · simple interest</div>
                </div>
                <div className="text-right">
                  <div className="label">Tier</div>
                  {tierLabel ? (
                    <div className={`mt-1 inline-flex items-center gap-1 rounded-lg border px-3 py-1 text-sm font-bold ${tierColor(tierLabel)}`}>
                      {tierLabel}
                    </div>
                  ) : (
                    <div className="text-3xl font-semibold text-white/60">–</div>
                  )}
                </div>
              </div>
            )}

            {/* Creditworthiness claims panel */}
            {isCreditworthiness && claims && (
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="label text-xs">ZK-Proven Claims</div>
                  <span className="text-xs text-white/30 italic">
                    values are private — only ✓/✗ proven
                  </span>
                </div>
                <ClaimRow label="Monthly income"      threshold="≥ $2,000 / mo"          passed={claims.income_ok} />
                <ClaimRow label="Repaid loans"         threshold="≥ 3 completed"          passed={claims.loans_ok} />
                <ClaimRow label="Default history"      threshold="zero defaults"           passed={claims.default_ok} />
                <ClaimRow label="Debt-to-income"       threshold="< 30% DTI"              passed={claims.dti_ok} />
                <ClaimRow label="Employment tenure"    threshold="≥ 12 months"            passed={claims.employment_ok} />
                <ClaimRow label="Bill payments"        threshold="electricity · water · internet · phone"  passed={!!(claims as any).bills_ok} />
                {typeof (quote as any).total_criteria === "number" && (
                  <div className="mt-2 text-xs text-white/40 text-right">
                    {(quote as any).total_criteria}/6 criteria met
                  </div>
                )}
              </div>
            )}

            {/* Privacy callout — creditworthiness only, non-reject */}
            {isCreditworthiness && claims && !isReject && (
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="text-xs font-semibold text-white/60 mb-3">🔒 What the lender sees vs. what stayed private</div>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="text-white/30 mb-2 uppercase tracking-wide text-[10px]">Stayed on your device</div>
                    {["Monthly income", "Debt obligations", "Employment history", "Loan record", "Bill payment details"].map(item => (
                      <div key={item} className="text-white/40 flex items-center gap-1.5 mb-1">
                        <span className="text-bad/60 text-[10px]">✗</span>{item}
                      </div>
                    ))}
                    <div className="mt-2 text-white/20 text-[10px] italic">never transmitted or stored</div>
                  </div>
                  <div>
                    <div className="text-white/30 mb-2 uppercase tracking-wide text-[10px]">Recorded on-chain</div>
                    <div className={`flex items-center gap-1.5 mb-1 font-semibold ${
                      tierLabel === "PRIME" ? "text-good" :
                      tierLabel === "GREEN" ? "text-accent" :
                      tierLabel === "YELLOW" ? "text-warn" : "text-bad"
                    }`}>
                      <span className="text-[10px]">✓</span> Tier: {tierLabel}
                    </div>
                    <div className="text-white/40 flex items-center gap-1.5 mb-1">
                      <span className="text-white/25 text-[10px]">+</span> Rate (bps)
                    </div>
                    <div className="text-white/40 flex items-center gap-1.5 mb-1">
                      <span className="text-white/25 text-[10px]">+</span> Loan amount
                    </div>
                    <div className="mt-2 text-white/20 text-[10px] leading-relaxed">
                      Groth16 proof is one-way — input values cannot be recovered.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Badges */}
            <div className="flex flex-wrap gap-2">
              {quote.source === "oracle" && (
                <a href="http://localhost:3001/health" target="_blank" rel="noopener noreferrer"
                   className="pill border-accent/40 text-accent2 hover:border-accent/80 transition">
                  🔮 risk oracle {isCreditworthiness ? "(attestation)" : "(snarkjs)"}
                </a>
              )}
              <X402Badge paid={quote.x402_paid} mode={quote.x402_mode} tx={quote.settlement_tx} error={quote.x402_error} />
              {isCreditworthiness && (
                <span className="pill border-accent/40 text-accent"
                      title="creditworthiness.circom: 5 private attributes → tier output">
                  ✓ BLS12-381 Groth16
                </span>
              )}
              {!isCreditworthiness && quote.proof_valid && quote.verification_mode === "snarkjs" && (
                <a href="https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md"
                   target="_blank" rel="noopener noreferrer"
                   className="pill border-accent/40 text-accent hover:border-accent transition">
                  ✓ BLS12-381 Groth16 ↗
                </a>
              )}
              {tierLabel && (
                <span className={`pill ${tierPillColor(tierLabel)}`}
                      title="ZK proof: raw financial data is private, only tier appears on-chain">
                  🔒 {tierLabel} tier on-chain
                </span>
              )}
            </div>

            {/* Loan details */}
            <dl className="space-y-2 text-sm">
              <Row k="Loan type"   v={
                loanProduct === "daily" ? `Daily (${customDays} days)`
                : loanProduct === "installment_3m" ? "3-Month Installment"
                : "Monthly (30 days)"
              } />
              <Row k="Principal"     v={`${fmtU(quote.principal)} USDC`} />
              <Row k="Interest"        v={`${fmtU(quote.interest)} USDC`} />
              <Row k="Total due" v={`${fmtU(quote.total_due)} USDC`} strong />
              {(quote as any).installment_amount && (
                <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 space-y-1.5">
                  <div className="text-xs text-accent font-medium">Installment plan</div>
                  {[1, 2, 3].map(i => (
                    <div key={i} className="flex justify-between text-xs text-white/60">
                      <span>Installment {i} (day {i * 30})</span>
                      <span className="font-medium text-white/80">
                        {fmtU((quote as any).installment_amount)} USDC
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <Row k="Proof type" v="creditworthiness_proof (6 criteria)" />
              {quote.onchain_tx && (
                <Row k={quote.onchain_kind === "borrow_with_proof" ? "On-chain loan tx (full pipeline)" : "On-chain ZK proof tx"}
                     v={`${quote.onchain_tx.slice(0, 8)}…${quote.onchain_tx.slice(-6)}`}
                     href={`https://stellar.expert/explorer/testnet/tx/${quote.onchain_tx}`}
                     strong />
              )}
              {quote.settlement_tx && (
                <Row k="x402 settlement"
                     v={`${quote.settlement_tx.slice(0, 6)}…${quote.settlement_tx.slice(-4)}`}
                     href={`https://stellar.expert/explorer/testnet/tx/${quote.settlement_tx}`} />
              )}
              <Row k="On-chain verifier" v="CCGZ…GNZC"
                   href="https://stellar.expert/explorer/testnet/contract/CCGZ4HGNOZ4WKXSTGG6KS6XUAGQ3DEIHZRYWSJBWXVAN4TZG2MWQGNZC" />
              <Row k="Lending pool"
                   v={poolUsdc !== null ? `CAUBK…UKMU · ${fmtU(poolUsdc)} USDC` : "CAUBK…UKMU"}
                   href="https://stellar.expert/explorer/testnet/contract/CAUBK4VA6X3H2Y5I53736RPBREQYC42QIF4QPFZETS6ZHKXYOBCSUKMU" />
            </dl>

            {false && (
              <div className="rounded-xl border border-bad/30 bg-bad/5 p-4 text-sm">
                <div className="font-semibold text-bad">Loan Rejected</div>
                <p className="mt-1 text-xs text-white/55">Trust score below minimum threshold.</p>
              </div>
            )}

            {/* Step 2 — draw the loan */}
            {(quote.proof_valid || isCreditworthiness) && quote.has_proof && !isReject && (
              <div className="rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
                {!loan ? (
                  <>
                    <div className="label mb-1">Step 2 — draw the loan</div>
                    <p className="mb-3 text-xs leading-relaxed text-white/55">
                      {isCreditworthiness
                        ? <>The oracle will generate a fresh ZK proof embedding your private financial data, proving <b className={rateCol(quote.rate_bps)}>{tierLabel}</b> tier on-chain. Your salary, debt, and history are NEVER recorded — only the tier.</>
                        : <>You qualify for <b className={rateCol(quote.rate_bps)}>{quote.rate_pct}%</b>. Approve to originate via <code className="text-white/70">lending_pool.borrow_with_proof</code> — 1 USDC demo on testnet.</>
                      }
                      {address ? (
                        <> <b className="text-white/75">You</b> ({address.slice(0, 4)}…{address.slice(-4)}) are the on-chain borrower; oracle co-signs the tier.</>
                      ) : (
                        <> Connect a wallet to borrow as yourself — otherwise a demo borrower key signs.</>
                      )}
                    </p>
                    <button onClick={confirmBorrow} disabled={!!borrowPhase} className="btn-primary w-full">
                      {borrowPhase
                        ? loanProduct === "installment_3m" ? "Creating 3 installments… (3 ZK proofs)" : "Originating loan…"
                        : loanProduct === "installment_3m"
                        ? `3 Taksit — ${tierLabel} tier · ${quote.rate_pct}% (demo)`
                        : address
                        ? `Sign & borrow — ${tierLabel} tier at ${quote.rate_pct}%`
                        : `Approve & borrow at ${quote.rate_pct}% (demo)`}
                    </button>
                    {borrowPhase && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-white/60">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-accent" />
                        {borrowPhase}
                      </div>
                    )}
                    {borrowError && (
                      <div className="mt-3 break-words rounded-lg border border-bad/30 bg-bad/5 p-2 text-xs text-bad">
                        Borrow failed: {borrowError}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* ZK Verified header */}
                    <div className="rounded-xl border border-good/30 bg-good/[0.06] p-4 text-center mb-2">
                      <div className="text-good font-bold text-base">ZK Verified on Stellar Testnet</div>
                      <div className="mt-1 text-xs text-white/45">
                        creditworthiness_proof · Groth16 BLS12-381 · anti-replay nonce burned
                      </div>
                      <div className="mt-2 flex flex-wrap justify-center gap-2 text-[11px]">
                        <span className="pill border-good/30 text-good/70">✓ ZK proof verified</span>
                        <span className="pill border-good/30 text-good/70">✓ no financial data on-chain</span>
                        {loan.repaid_first && <span className="pill border-edge text-white/40">prior loan repaid first</span>}
                        {expiryLedger && (
                          <span className="pill border-accent/30 text-accent/70"
                                title={`Expires at ledger ${expiryLedger}`}>
                            ⏳ proof valid ~2h 45m (ledger {expiryLedger.toLocaleString()})
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Installment view */}
                    {loan.onchain_kind === "installment_3m" && loan.installments ? (
                      <>
                        <div className="space-y-2">
                          {loan.installments.map((inst) => (
                            <div key={inst.slot}
                                 className="rounded-lg border border-accent/20 bg-accent/[0.04] p-3 flex items-center justify-between text-sm">
                              <div>
                                <span className="font-semibold text-white/80">Installment {inst.slot + 1}</span>
                                <span className="ml-2 text-white/40 text-xs">Due on day {(inst.slot + 1) * 30}</span>
                              </div>
                              <div className="text-right">
                                <div className="text-accent font-mono text-xs">
                                  {fmtU(Number(inst.amount_stroops) / 1e7)} USDC
                                </div>
                                <a href={`https://stellar.expert/explorer/testnet/tx/${inst.tx_hash}`}
                                   target="_blank" rel="noopener noreferrer"
                                   className="text-[10px] text-white/35 hover:text-accent underline decoration-dotted transition">
                                  {inst.tx_hash.slice(0, 8)}…{inst.tx_hash.slice(-6)} ↗
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                        <dl className="mt-3 space-y-2 text-sm">
                          {loan.onchain_amount != null && (
                            <Row k="Total disbursed" v={`${fmtU(loan.onchain_amount / 1e7)} USDC · 3×30 days`} />
                          )}
                          {loan.borrower && (
                            <Row k="Borrower" v={short(loan.borrower)}
                                 href={`https://stellar.expert/explorer/testnet/account/${loan.borrower}`} />
                          )}
                          {loan.oracle && (
                            <Row k="Oracle" v={short(loan.oracle)}
                                 href={`https://stellar.expert/explorer/testnet/account/${loan.oracle}`} />
                          )}
                        </dl>
                      </>
                    ) : (
                      <dl className="space-y-2 text-sm">
                        {loan.onchain_tx && (
                          <Row k="On-chain loan tx (full pipeline)"
                               v={`${loan.onchain_tx.slice(0, 8)}…${loan.onchain_tx.slice(-6)}`}
                               href={`https://stellar.expert/explorer/testnet/tx/${loan.onchain_tx}`}
                               strong />
                        )}
                        {loan.onchain_amount != null && (
                          <Row k="Disbursed (testnet demo)"
                               v={`${fmtU(loan.onchain_amount / 1e7)} USDC · ${loan.onchain_term_days ?? term}d`} />
                        )}
                        {loan.borrower && (
                          <Row k="Borrower (receives loan)"
                               v={short(loan.borrower)}
                               href={`https://stellar.expert/explorer/testnet/account/${loan.borrower}`} />
                        )}
                        {loan.oracle && (
                          <Row k="Oracle (attests tier)"
                               v={short(loan.oracle)}
                               href={`https://stellar.expert/explorer/testnet/account/${loan.oracle}`} />
                        )}
                      </dl>
                    )}

                    <p className="mt-2 text-xs leading-relaxed text-white/40">
                      The ZK <code className="text-white/60">creditworthiness_proof</code> circuit proved 5 financial claims — only the tier appears on-chain. Income, debt, defaults, DTI and employment were never transmitted or stored.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* x402 live payment card */}
            {quote.x402_paid && quote.settlement_tx && (
              <div className="rounded-xl border border-accent/25 bg-accent/[0.05] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-accent">⚡ x402 machine-to-machine payment</span>
                  <a href={`https://stellar.expert/explorer/testnet/tx/${quote.settlement_tx}`}
                     target="_blank" rel="noopener noreferrer"
                     className="text-xs text-accent/70 hover:text-accent underline decoration-dotted transition">
                    settlement tx ↗
                  </a>
                </div>
                <p className="text-xs text-white/50 leading-relaxed">
                  The lending protocol paid the oracle{" "}
                  <span className="font-semibold text-white/75">$0.05 USDC</span> for this
                  creditworthiness attestation — settled on Stellar Testnet, no human involved.
                </p>
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="pill border-accent/20 text-accent/60">payer: lending protocol</span>
                  <span className="pill border-accent/20 text-accent/60">payee: risk oracle</span>
                  <span className="pill border-accent/20 text-accent/60">$0.05 USDC · OZ Channels</span>
                </div>
              </div>
            )}

            {/* x402 mock info */}
            {!quote.x402_paid && quote.has_proof && quote.x402_mode !== "live" && (
              <div className="rounded-xl border border-warn/20 bg-warn/5 p-3 text-xs text-white/60">
                <span className="text-warn font-medium">x402 mock mode</span> — to enable real USDC machine payments:
                set <code className="text-white/80">X402_MODE=live</code> and fund the protocol wallet with{" "}
                <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer"
                   className="text-accent hover:text-accent2 underline">testnet USDC ↗</a>.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
