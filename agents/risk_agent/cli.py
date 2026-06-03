"""CLI for the Risk Agent — score a borrower from a JSON file or stdin.

Examples:
    python cli.py --income-ok --solvency-ok --wallet-age-days 540 --tx-count 320 --prior-loans 8
    echo '{"income_ok": true, "solvency_ok": true}' | python cli.py -
"""
from __future__ import annotations

import argparse
import json
import sys

from scoring import BorrowerSignals, score_borrower


def main() -> None:
    p = argparse.ArgumentParser(description="zkCredit risk scoring")
    p.add_argument("json", nargs="?", help="path to signals JSON, or '-' for stdin")
    p.add_argument("--income-ok", action="store_true")
    p.add_argument("--solvency-ok", action="store_true")
    p.add_argument("--repayment-ok", action="store_true")
    p.add_argument("--wallet-age-days", type=int, default=0)
    p.add_argument("--tx-count", type=int, default=0)
    p.add_argument("--prior-loans", type=int, default=0, dest="prior_loans_repaid")
    p.add_argument("--defaults", type=int, default=0, dest="default_events")
    p.add_argument("--fraud", type=int, default=0, dest="fraud_signals")
    args = p.parse_args()

    if args.json:
        raw = sys.stdin.read() if args.json == "-" else open(args.json).read()
        signals = BorrowerSignals(**json.loads(raw))
    else:
        signals = BorrowerSignals(
            income_ok=args.income_ok,
            solvency_ok=args.solvency_ok,
            repayment_ok=args.repayment_ok,
            wallet_age_days=args.wallet_age_days,
            tx_count=args.tx_count,
            prior_loans_repaid=args.prior_loans_repaid,
            default_events=args.default_events,
            fraud_signals=args.fraud_signals,
        )

    print(json.dumps(score_borrower(signals).to_dict(), indent=2))


if __name__ == "__main__":
    main()
