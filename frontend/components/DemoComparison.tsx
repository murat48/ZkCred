"use client";

import { useEffect, useState } from "react";
import { PROFILES } from "@/lib/profiles";
import type { Quote } from "@/lib/types";

const PRINCIPAL = 1000;
const TERM = 365;

export default function DemoComparison() {
  const [rows, setRows] = useState<(Quote & { name: string })[]>([]);

  useEffect(() => {
    Promise.all(
      PROFILES.map(async (p) => {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proofType: p.proofType,
            signals: p.signals,
            principal: PRINCIPAL,
            term_days: TERM,
          }),
        });
        return { ...(await res.json()), name: p.name } as Quote & { name: string };
      }),
    ).then(setRows);
  }, []);

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-white/40">
            <th className="pb-3 font-normal">Borrower</th>
            <th className="pb-3 font-normal">Trust score</th>
            <th className="pb-3 font-normal">Rate</th>
            <th className="pb-3 text-right font-normal">Interest on {PRINCIPAL} USDC / 1yr</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={4} className="py-4 text-center text-white/30">computing quotes…</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-edge/60">
              <td className="py-3">{r.name}</td>
              <td className="py-3">{r.has_proof ? r.trust_score : "—"}</td>
              <td className={`py-3 font-semibold ${r.rate_bps <= 600 ? "text-good" : r.rate_bps <= 1000 ? "text-accent2" : "text-bad"}`}>
                {r.rate_pct}%
              </td>
              <td className="py-3 text-right tabular-nums">{r.interest} USDC</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-xs text-white/40">
        Same protocol. Same collateral. The only difference is what each borrower could prove in zero knowledge.
      </p>
    </div>
  );
}
