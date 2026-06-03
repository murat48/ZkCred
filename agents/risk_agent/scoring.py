"""zkCredit Risk Agent — trust scoring model.

Consumes ZK-verified threshold flags (never raw financials) plus public
on-chain behavioural signals, and produces a normalized trust score (0-100)
mapped to an interest-rate tier.

The model is intentionally transparent and explainable: every point is
attributable to a named feature, so a lender can audit why a rate was offered.
Privacy invariant: this module must only ever see *booleans* derived from ZK
proofs (e.g. `income_ok`), never the underlying amounts.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict


# Interest-rate tiers (basis points) — mirrors the on-chain `risk_policy` defaults.
RATE_TIERS = [
    (90, 600),   # 90-100 -> 6%
    (80, 800),   # 80-89  -> 8%
    (60, 1000),  # 60-79  -> 10%
    (0, 1400),   # <60 / no proof -> 14%
]
ANONYMOUS_RATE_BPS = 1400


@dataclass
class BorrowerSignals:
    """Inputs to the model. ZK flags are booleans proven on-chain; the rest are
    public on-chain observations (wallet age, activity, loan record)."""
    # ZK-verified threshold flags (from solvency / repayment proofs)
    income_ok: bool = False        # monthly_income >= 3000 USDC
    solvency_ok: bool = False      # assets/liabilities >= 1.5
    repayment_ok: bool = False     # on-time >= 80% and zero defaults

    # Public on-chain behavioural signals
    wallet_age_days: int = 0
    tx_count: int = 0
    prior_loans_repaid: int = 0
    default_events: int = 0
    fraud_signals: int = 0


# Feature weights (max positive contribution per feature).
_W = {
    "base": 50,
    "income_ok": 12,
    "solvency_ok": 13,
    "repayment_ok": 15,
    "wallet_age": 10,   # full credit at >= 1 year
    "activity": 5,      # full credit at >= 100 txns
    "history": 10,      # full credit at >= 5 repaid loans
}
_DEFAULT_PENALTY = 20
_FRAUD_PENALTY = 25


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


@dataclass
class ScoreResult:
    trust_score: int
    rate_bps: int
    rate_pct: float
    breakdown: Dict[str, float] = field(default_factory=dict)
    has_proof: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def rate_bps_for_score(score: int) -> int:
    for min_score, bps in RATE_TIERS:
        if score >= min_score:
            return bps
    return ANONYMOUS_RATE_BPS


def score_borrower(s: BorrowerSignals) -> ScoreResult:
    has_proof = s.income_ok or s.solvency_ok or s.repayment_ok

    # A borrower with no ZK proof is not underwritten — they receive the
    # anonymous tier regardless of other signals (those can't be trusted alone).
    if not has_proof:
        return ScoreResult(
            trust_score=0,
            rate_bps=ANONYMOUS_RATE_BPS,
            rate_pct=ANONYMOUS_RATE_BPS / 100.0,
            breakdown={"reason": "no_zk_proof"},
            has_proof=False,
        )

    b: Dict[str, float] = {"base": _W["base"]}
    if s.income_ok:
        b["income_ok"] = _W["income_ok"]
    if s.solvency_ok:
        b["solvency_ok"] = _W["solvency_ok"]
    if s.repayment_ok:
        b["repayment_ok"] = _W["repayment_ok"]

    b["wallet_age"] = round(_clamp(s.wallet_age_days / 365.0, 0, 1) * _W["wallet_age"], 2)
    b["activity"] = round(_clamp(s.tx_count / 100.0, 0, 1) * _W["activity"], 2)
    b["history"] = round(_clamp(s.prior_loans_repaid / 5.0, 0, 1) * _W["history"], 2)

    if s.default_events:
        b["defaults_penalty"] = -float(s.default_events * _DEFAULT_PENALTY)
    if s.fraud_signals:
        b["fraud_penalty"] = -float(s.fraud_signals * _FRAUD_PENALTY)

    raw = sum(b.values())
    score = int(round(_clamp(raw, 0, 100)))
    bps = rate_bps_for_score(score)

    return ScoreResult(
        trust_score=score,
        rate_bps=bps,
        rate_pct=bps / 100.0,
        breakdown=b,
        has_proof=True,
    )
