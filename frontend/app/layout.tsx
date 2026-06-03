import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/contexts/WalletContext";
import WalletConnect from "@/components/WalletConnect";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "zkCredit — Privacy-Preserving Credit for DeFi",
  description:
    "Prove creditworthiness with Zero-Knowledge proofs. Get a personalized interest rate without revealing any financial data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        <WalletProvider>
          <div className="mx-auto max-w-5xl px-4 py-8">
            <header className="mb-12 flex items-center justify-between gap-4 border-b border-white/[0.06] pb-6">
              <div className="flex items-center gap-3 shrink-0">
                <a
                  href="https://stellar.expert/explorer/testnet/contract/CAW6WH7PY6VOAFDQ622WUGL4Q4AOMIYMZTKIG4RQFGXC4UBTKM7Z2Z2W"
                  target="_blank" rel="noopener noreferrer"
                  className="grid h-9 w-9 place-items-center rounded-xl bg-accent font-mono font-bold text-white hover:brightness-110 transition"
                >
                  zk
                </a>
                <div>
                  <div className="text-lg font-semibold leading-tight">zkCredit</div>
                  <div className="text-xs text-white/40">Privacy-Preserving Credit Intelligence</div>
                </div>
              </div>

              <div className="hidden md:flex items-center gap-2 text-xs">
                <a
                  href="https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md"
                  target="_blank" rel="noopener noreferrer"
                  className="pill border-accent/40 text-accent hover:border-accent/80 transition"
                >
                  Groth16 · BLS12-381 ↗
                </a>
                <a
                  href="https://x402.org"
                  target="_blank" rel="noopener noreferrer"
                  className="pill border-accent2/40 text-accent2 hover:border-accent2/80 transition"
                >
                  x402 ↗
                </a>
                <a
                  href="https://stellar.expert/explorer/testnet"
                  target="_blank" rel="noopener noreferrer"
                  className="pill border-edge text-white/50 hover:text-white/80 transition"
                >
                  Testnet ↗
                </a>
              </div>

              <WalletConnect />
            </header>

            {children}

            <footer className="mt-16 border-t border-edge pt-6 text-center text-xs text-white/30">
              zkCredit · Stellar Testnet ·{" "}
              <a href="https://x402.org" target="_blank" rel="noopener noreferrer" className="hover:text-white/60">x402</a>
              {" · "}
              <a href="https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md" target="_blank" rel="noopener noreferrer" className="hover:text-white/60">CAP-0059</a>
              {" · "}
              <a href="https://stellar.expert/explorer/testnet" target="_blank" rel="noopener noreferrer" className="hover:text-white/60">explorer</a>
            </footer>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
