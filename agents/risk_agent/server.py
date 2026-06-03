"""Risk Agent HTTP service.

Exposes the scoring model so the Oracle Provider (x402 seller) can request a
trust score after it has verified a borrower's ZK proof. This service is an
internal dependency of the oracle — it is NOT payment-gated itself and should
not be exposed publicly.
"""
from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from scoring import BorrowerSignals, score_borrower

app = FastAPI(title="zkCredit Risk Agent", version="0.1.0")


class ScoreRequest(BaseModel):
    income_ok: bool = False
    solvency_ok: bool = False
    repayment_ok: bool = False
    wallet_age_days: int = 0
    tx_count: int = 0
    prior_loans_repaid: int = 0
    default_events: int = 0
    fraud_signals: int = 0


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/score")
def score(req: ScoreRequest) -> dict:
    result = score_borrower(BorrowerSignals(**req.model_dump()))
    return result.to_dict()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
