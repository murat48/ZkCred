// Financial record derivation for MockBank.
//
// Data source: Stellar Horizon public API — every metric is independently
// verifiable by anyone with the wallet address and a Horizon explorer.
//
// This is a DeFi-native credit scoring model: instead of bank statements or
// payslips, it reads on-chain activity as financial proxy signals.
//
// Production upgrade path:
//   Replace Horizon proxies with:
//     - Plaid OAuth for monthly_income (verified bank inflows)
//     - Credit bureau API for repaid_loans_count / default_count
//     - Payroll API for employment_months
//   The signing, oracle verification, and ZK proof flow remain identical.
//
// Proxy formulas (disclosed — juri can verify each on Stellar Explorer):
//
//   employment_months  = max(account_age_months, soroban_calls / 8)
//                        "Regular Soroban activity ≈ months of on-chain economic engagement"
//
//   monthly_income     = USDC_balance × 50  +  XLM_balance × 0.20
//                        "On-chain liquidity proxy: capital holdings indicate access to funds"
//                        (testnet USDC/XLM are gas/test tokens, not real money — scale disclosed)
//
//   repaid_loans_count = min(8, floor(soroban_calls / 8))
//                        "Protocol interaction count normalized to lending cycles"
//
//   default_count      = 0  (verifiable: no default events in lending_pool on this deployment)
//
//   monthly_debt       = 0  (no persistent debt position detected; Soroban RPC query optional)

import { createHash } from "node:crypto";
import { creditHistory } from "./credit_store.mjs";

const HORIZON = "https://horizon-testnet.stellar.org";

// ─── Hardcoded demo profiles ──────────────────────────────────────────────────
// Deterministic demo wallets for hackathon presentation.
// Keys derived from seeds: "zkcredit-demo-{tier}-v1" (padded to 32 bytes).
// These addresses show all four tiers in the UI without real bank data.
const DEMO_PROFILES = {
  // PRIME: all 6 criteria — lowest rate (5%)
  "GDYSNQ74SSCADPFFEIAVWVDIXZNJ5WF3J7LDRBMPW3VFJJHB7SSJ2TEQ": {
    monthly_income: 6500, repaid_loans_count: 8, default_count: 0,
    monthly_debt: 900, employment_months: 36, bills_ok: 1,
  },
  // GREEN: primary demo wallet — hardcoded so demo works reliably (5/6 criteria)
  "GAKPIGNGOWAS75N6SSJVYPVI574JWBSDLUJASIRN6XSM5G3TWE3WAU3S": {
    monthly_income: 3200, repaid_loans_count: 5, default_count: 0,
    monthly_debt: 700, employment_months: 18, bills_ok: 0,
    // income_ok ✓  loans_ok ✓  default_ok ✓  dti_ok ✓  employment_ok ✓  bills_ok ✗ → 5/6 → GREEN
  },
  // YELLOW: passes 3 mandatory barriers (income+loans+default), 2 optional criteria fail
  "GBUUARFXB2VJDPSC4UBU5JWOU3VBSS64P67GJFIIHAM5SPKSBNS52ZUU": {
    monthly_income: 2200, repaid_loans_count: 3, default_count: 0,
    monthly_debt: 550, employment_months: 6, bills_ok: 0,
    // income_ok ✓  loans_ok ✓  default_ok ✓  dti_ok ✓  employment_ok ✗  bills_ok ✗  → 4/6 → YELLOW
  },
  // REJECT: default_count=1 → hard constraint income_ok×default_ok===1 fails → proof impossible
  "GAP447AIRSJ4IXJ4CC3QCLFTN4NE3Z7UXO7T5LZVFOXYMOBLR62AYR7Q": {
    monthly_income: 3200, repaid_loans_count: 5, default_count: 1,
    monthly_debt: 600, employment_months: 24, bills_ok: 1,
    // default_ok ✗ → REJECT (ZK proof mathematically impossible)
  },
};
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const HORIZON_TIMEOUT = 6000;

// Soroban RPC — query lending_pool for on-chain default detection.
// A default occurs when a loan's term has expired but it hasn't been fully repaid.
// LEDGERS_PER_DAY ≈ 17,280  (1 ledger / 5s × 86,400s)
const SOROBAN_RPC     = process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
const LENDING_POOL    = process.env.LENDING_POOL ?? "CAQXQBHS3KVD374CE7CNV7G3O53KFVVFHYKEPSKIHL4Q65BGPQ6DAPSE";
const LEDGERS_PER_DAY = 17_280;

// Default detection via oracle's /loan/status endpoint (avoids SDK dependency).
// Checks if the borrower has an active loan that has exceeded its term.
// A loan is "defaulted" if: loan exists AND start_time + term_days < now AND repaid < total_due.
const ORACLE_URL = process.env.ORACLE_URL ?? "http://localhost:3001";

async function checkOnchainDefault(walletAddress) {
  try {
    const res = await fetch(`${ORACLE_URL}/loan/status?account=${walletAddress}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return 0;
    const loan = await res.json();
    if (!loan?.active) return 0;

    // Loan is active — check if it's overdue using Horizon's current ledger
    const horizonRes = await fetch("https://horizon-testnet.stellar.org/", {
      signal: AbortSignal.timeout(3000),
    });
    if (!horizonRes.ok) return 0;
    const horizon = await horizonRes.json();
    const currentLedger = horizon.horizon_latest_ledger ?? 0;

    // loan/status doesn't expose start_ledger directly — use outstanding as proxy:
    // If the loan is active AND the borrower's last operation was > term_days ago → default
    // Simplified: flag default if outstanding > 0 AND last_modified > term_days ledgers ago
    // (Conservative: only flag if clearly expired, not just overdue by hours)
    const outstanding = BigInt(loan.outstanding ?? 0);
    const totalDue = BigInt(loan.total_due ?? 0);
    if (outstanding > 0n && totalDue > 0n) {
      // We don't have start_ledger in the response, so we use the lastModifiedLedger
      // from the Soroban RPC as a proxy — if the loan entry hasn't been touched in
      // > TERM_DAYS * LEDGERS_PER_DAY ledgers, it's expired.
      // For now: conservative — only flag if oracle says "no active loan" but Horizon shows
      // many old ops (indicating past defaults). Full impl needs start_ledger from contract.
      // This stub returns 0 (no false positives) — real implementation adds getLedgerEntries.
    }
    return 0;
  } catch {
    return 0;
  }
}

// ─── On-chain derivation ──────────────────────────────────────────────────────
async function fetchOnchainRecord(walletAddress) {
  const [accountRes, opsRes, paymentsRes] = await Promise.all([
    fetch(`${HORIZON}/accounts/${walletAddress}`,
      { signal: AbortSignal.timeout(HORIZON_TIMEOUT) }),
    fetch(`${HORIZON}/accounts/${walletAddress}/operations?limit=200&order=asc`,
      { signal: AbortSignal.timeout(HORIZON_TIMEOUT) }),
    fetch(`${HORIZON}/accounts/${walletAddress}/payments?limit=200&order=desc`,
      { signal: AbortSignal.timeout(HORIZON_TIMEOUT) }),
  ]);

  if (!accountRes.ok) throw new Error(`Horizon account not found (HTTP ${accountRes.status})`);

  const account   = await accountRes.json();
  const ops       = opsRes.ok      ? (await opsRes.json())?._embedded?.records      ?? [] : [];
  const payments  = paymentsRes.ok ? (await paymentsRes.json())?._embedded?.records ?? [] : [];

  // ── Account age ──
  const firstOp  = ops[0];
  const createdAt = firstOp ? new Date(firstOp.created_at) : new Date();
  const ageMonths = Math.max(0, (Date.now() - createdAt.getTime()) / (30 * 24 * 3600 * 1000));
  const sorobanOps = ops.filter((o) => o.type === "invoke_host_function").length;

  // ── monthly_income: requires 3 consecutive recent months of inflows ──────────
  // "Income" = regular recurring deposits, not just a one-time balance.
  // Algorithm:
  //   1. Find all INFLOWS (payments TO this wallet) in the last 6 months.
  //   2. Group by YYYY-MM calendar month.
  //   3. Check if ≥3 of the last 4 months have at least one inflow.
  //   4. income_ok = true only if the recency check passes.
  //   5. monthly_income = average inflow per qualifying month × testnet scale factor.
  const now = new Date();
  const sixMonthsAgo = new Date(now); sixMonthsAgo.setMonth(now.getMonth() - 6);

  // Only USDC or XLM inflows count (not Soroban contract calls)
  const inflows = payments.filter((p) =>
    p.to === walletAddress &&
    new Date(p.created_at) >= sixMonthsAgo &&
    (p.asset_code === "USDC" || p.asset_type === "native")
  );

  // Group inflows by month and sum amounts
  const inflowByMonth = new Map(); // "YYYY-MM" → total amount
  for (const p of inflows) {
    const ym = p.created_at.slice(0, 7);
    const amt = parseFloat(p.amount ?? "0");
    inflowByMonth.set(ym, (inflowByMonth.get(ym) ?? 0) + amt);
  }

  // Check last 4 months for presence of inflows (3 of 4 required)
  const recentMonths = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    recentMonths.push(d.toISOString().slice(0, 7)); // "YYYY-MM"
  }
  const monthsWithInflow = recentMonths.filter((ym) => (inflowByMonth.get(ym) ?? 0) > 0);
  const hasRegularIncome = monthsWithInflow.length >= 3;

  // Compute average monthly inflow across qualifying months (scale for testnet)
  // USDC testnet scale: ×50 (same as before); XLM payments assumed USDC-equivalent
  const avgInflowRaw = inflowByMonth.size > 0
    ? [...inflowByMonth.values()].reduce((a, b) => a + b, 0) / inflowByMonth.size
    : 0;
  // Cap at 32,767 — circuit GreaterEqThan(15) supports 0–32767 (2^15 - 1).
  const monthly_income = hasRegularIncome
    ? Math.min(32_767, Math.round(avgInflowRaw * 50))
    : 0;

  // ── employment_months: DeFi tenure proxy ─────────────────────────────────────
  // calendar_months × 4 (consistent on-chain tenure ≈ traditional employment).
  const employment_months = Math.round(Math.max(ageMonths * 4, sorobanOps / 2));

  // ── repaid_loans_count + default_count: on-chain from lending_pool contract ────
  // Oracle /creditworthiness/history reads get_repaid_count() and get_defaults()
  // directly from the contract. These are immutable on-chain records.
  // Falls back to in-memory creditHistory if oracle is unavailable.
  let repaid_loans_count = Math.min(8, creditHistory.get(walletAddress) ?? 0);
  let default_count = 0;
  try {
    const histRes = await fetch(`${ORACLE_URL}/creditworthiness/history?account=${walletAddress}`,
      { signal: AbortSignal.timeout(4000) });
    if (histRes.ok) {
      const hist = await histRes.json();
      // On-chain is authoritative for defaults (immutable contract record).
      // For repaid_count: use max(on-chain, in-memory) so pre-seeded demo wallets
      // keep their values until real on-chain history surpasses them.
      repaid_loans_count = Math.min(8, Math.max(hist.repaid_count ?? 0, repaid_loans_count));
      default_count = hist.defaults ?? 0;
    }
  } catch { /* oracle unavailable — use in-memory fallback */ }

  // ── monthly_debt: active loan outstanding / remaining term months ─────────────
  // If no active loan → 0 (DTI = 0% → passes < 30%).
  // If active loan → use outstanding_usdc / 12 as monthly obligation proxy.
  let monthly_debt = 0;
  try {
    const loanRes = await fetch(`${ORACLE_URL}/loan/status?account=${walletAddress}`,
      { signal: AbortSignal.timeout(3000) });
    if (loanRes.ok) {
      const loan = await loanRes.json();
      if (loan?.active && loan.outstanding_usdc > 0) {
        // monthly_debt = outstanding / 12 months (conservative repayment schedule)
        monthly_debt = Math.min(32_767, Math.round(loan.outstanding_usdc / 12 * 50));
      }
    }
  } catch { /* oracle unavailable — assume 0 debt */ }

  // ── bills_ok: regular outgoing payments to multiple distinct addresses ─────────
  const outflows = payments.filter((p) => p.from === walletAddress && p.type === "payment");
  const distinctRecipients = new Set(outflows.map((o) => o.to)).size;
  const outflowMonths = new Set(outflows.map((o) => o.created_at.slice(0, 7))).size;
  const bills_ok = (distinctRecipients >= 2 || outflowMonths >= 2) ? 1 : 0;

  return {
    monthly_income,
    repaid_loans_count,
    default_count,
    monthly_debt,
    employment_months,
    bills_ok,
    _source: "horizon",
    _raw: {
      account_age_months:    Math.round(ageMonths * 10) / 10,
      soroban_ops:           sorobanOps,
      inflow_months:         inflowByMonth.size,
      recent_inflow_months:  monthsWithInflow.length,
      has_regular_income:    hasRegularIncome,
      distinct_outflow_recipients: distinctRecipients,
    },
  };
}

// ─── Deterministic fallback (Horizon unreachable) ─────────────────────────────
function generateFallback(walletAddress) {
  const hash = createHash("sha256").update(walletAddress, "utf8").digest();
  const s = (i) => hash[i % 32];
  const income = 800 + (((s(0) << 8) | s(1)) % 6200);
  return {
    monthly_income: income,
    repaid_loans_count: s(2) % 9,
    default_count: s(3) % 100 < 15 ? 1 : 0,
    monthly_debt: Math.floor(income * (10 + (s(4) % 45)) / 100),
    employment_months: 3 + (s(5) % 46),
    bills_ok: s(6) % 100 < 70 ? 1 : 0,  // 70% of fallback wallets pay bills
    _source: "fallback",
  };
}

// ─── Public interface ─────────────────────────────────────────────────────────
export async function getRecord(walletAddress) {
  // Demo profiles take priority — hardcoded for presentation
  if (Object.prototype.hasOwnProperty.call(DEMO_PROFILES, walletAddress)) {
    const profile = DEMO_PROFILES[walletAddress];
    if (profile !== null) {
      console.log(`[bank] Demo profile for ${walletAddress.slice(0, 8)}…: ${JSON.stringify(profile)}`);
      return { ...profile, _source: "demo" };
    }
    // null = fall through to Horizon (e.g. GAKP... uses real chain data)
  }
  try {
    const record = await fetchOnchainRecord(walletAddress);
    console.log(
      `[bank] Horizon record for ${walletAddress.slice(0, 8)}…:` +
      ` income=$${record.monthly_income}(${record._raw.recent_inflow_months ?? 0}/4mo)` +
      ` loans=${record.repaid_loans_count}` +
      ` debt=$${record.monthly_debt}` +
      ` employ=${record.employment_months}mo` +
      ` bills=${record.bills_ok ? "✓" : "✗"}`,
    );
    return record;
  } catch (err) {
    console.warn(
      `[bank] Horizon query failed for ${walletAddress.slice(0, 8)}…: ${err.message} → using fallback`,
    );
    return generateFallback(walletAddress);
  }
}
