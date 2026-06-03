"use client";

import { useWallet } from "@/contexts/WalletContext";

function short(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function WalletConnect() {
  const { address, meta, signalsLoading, connect, disconnect } = useWallet();

  if (address) {
    return (
      <div className="flex items-center gap-3">
        {signalsLoading && (
          <span className="text-xs text-white/40 animate-pulse">scanning…</span>
        )}
        {meta && !signalsLoading && (
          <div className="hidden sm:flex items-center gap-2 text-xs text-white/50">
            <span>{meta.wallet_age_days}d old</span>
            <span>·</span>
            <span>{meta.tx_count} txns</span>
            {parseFloat(meta.usdc_balance) > 0 && (
              <>
                <span>·</span>
                <span className="text-good">{parseFloat(meta.usdc_balance).toFixed(2)} USDC</span>
              </>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.05] px-3 py-1.5">
          <div className="h-2 w-2 rounded-full bg-good" />
          <a
            href={`https://stellar.expert/explorer/testnet/account/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-white/80 hover:text-white"
          >
            {short(address)}
          </a>
          <button
            onClick={disconnect}
            className="ml-1 text-xs text-white/30 hover:text-bad transition"
            title="Disconnect"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={connect}
      className="btn-primary flex items-center gap-2 text-sm"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      </svg>
      Connect Wallet
    </button>
  );
}
