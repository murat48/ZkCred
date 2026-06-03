"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import type { BorrowerSignals } from "@/lib/types";

export interface WalletMeta {
  xlm_balance: string;
  usdc_balance: string;
  wallet_age_days: number;
  tx_count: number;
  subentries: number;
}

interface WalletState {
  address: string | null;
  signals: BorrowerSignals;
  meta: WalletMeta | null;
  signalsLoading: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  // Sign a transaction XDR with the connected wallet (Freighter/etc). Returns the
  // signed XDR. Used to let the user authorise borrow_with_proof as the borrower.
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletState>({
  address: null,
  signals: {},
  meta: null,
  signalsLoading: false,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => { throw new Error("wallet not connected"); },
});

// SWK singleton — browser only
let kitInstance: any = null;

async function getKit() {
  if (typeof window === "undefined") return null;
  if (kitInstance) return kitInstance;

  // Import SWK + all wallet modules
  const [swkMain, swkUtils] = await Promise.all([
    import("@creit.tech/stellar-wallets-kit"),
    import("@creit.tech/stellar-wallets-kit/modules/utils" as any).catch(() => null),
  ]);

  const { StellarWalletsKit, Networks } = swkMain;

  let modules: any[] = [];

  if (swkUtils && typeof swkUtils.defaultModules === "function") {
    try {
      modules = swkUtils.defaultModules();
    } catch {}
  }

  // If no modules load, try them one by one
  if (modules.length === 0) {
    const modPaths = [
      "@creit.tech/stellar-wallets-kit/modules/freighter",
      "@creit.tech/stellar-wallets-kit/modules/lobstr",
      "@creit.tech/stellar-wallets-kit/modules/xbull",
    ];
    for (const p of modPaths) {
      try {
        const mod = await import(p as any);
        const Cls = Object.values(mod).find((v: any) => typeof v === "function");
        if (Cls) modules.push(new (Cls as any)());
      } catch {}
    }
  }

  StellarWalletsKit.init({ modules });
  StellarWalletsKit.setNetwork(Networks.TESTNET);

  kitInstance = StellarWalletsKit;
  return kitInstance;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [signals, setSignals] = useState<BorrowerSignals>({});
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const [signalsLoading, setSignalsLoading] = useState(false);

  // Restore from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("zkc_wallet");
    if (saved) setAddress(saved);
  }, []);

  // Fetch Horizon signals when address changes
  useEffect(() => {
    if (!address) { setSignals({}); setMeta(null); return; }
    setSignalsLoading(true);
    fetch(`/api/wallet-signals?address=${address}`)
      .then((r) => r.json())
      .then((d) => { setSignals(d.signals ?? {}); setMeta(d.meta ?? null); })
      .catch(() => { setSignals({}); setMeta(null); })
      .finally(() => setSignalsLoading(false));
  }, [address]);

  const connect = useCallback(async () => {
    try {
      const kit = await getKit();
      if (!kit) return;
      const { address: addr } = await kit.authModal();
      setAddress(addr);
      localStorage.setItem("zkc_wallet", addr);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("User") && !msg.includes("cancel") && !msg.includes("reject")) {
        console.error("Wallet connect error:", e);
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      const kit = await getKit();
      if (kit) await kit.disconnect();
    } catch {}
    kitInstance = null;
    setAddress(null);
    setSignals({});
    setMeta(null);
    localStorage.removeItem("zkc_wallet");
  }, []);

  const signTransaction = useCallback(async (xdr: string): Promise<string> => {
    const kit = await getKit();
    if (!kit) throw new Error("wallet not available");

    // Freighter network check — returns txBadAuth on non-testnet.
    try {
      const netInfo = await kit.getNetwork?.();
      const phrase = netInfo?.networkPassphrase ?? netInfo?.passphrase ?? "";
      if (phrase && phrase !== "Test SDF Network ; September 2015") {
        throw new Error(
          `Change Freighter's network setting to Testnet (currently: ${netInfo?.network ?? phrase}). ` +
          `Freighter → Settings → Network → Testnet.`
        );
      }
    } catch (e: any) {
      // If network info is unavailable, propagate passphrase error; ignore other errors.
      if (e.message?.includes("Freighter")) throw e;
    }

    // SWK returns { signedTxXdr, signerAddress } across wallet modules.
    const result = await kit.signTransaction(xdr, {
      address: address ?? undefined,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    const { signedTxXdr, signerAddress } = result as any;

    // Catch if unsigned XDR is returned.
    if (!signedTxXdr) {
      throw new Error("Wallet did not sign the transaction — check the Freighter popup.");
    }

    // Freighter sometimes signs with the active account, not the connected one.
    if (signerAddress && address && signerAddress !== address) {
      throw new Error(
        `Freighter signed with the wrong account.\n` +
        `Connected account: ${address.slice(0, 6)}…${address.slice(-4)}\n` +
        `Signer:            ${signerAddress.slice(0, 6)}…${signerAddress.slice(-4)}\n\n` +
        `Switch to account "${address.slice(0, 6)}…${address.slice(-4)}" in Freighter, then try again.`
      );
    }

    return signedTxXdr;
  }, [address]);

  return (
    <WalletContext.Provider value={{ address, signals, meta, signalsLoading, connect, disconnect, signTransaction }}>
      {children}
    </WalletContext.Provider>
  );
}

export const useWallet = () => useContext(WalletContext);
