from scoring import BorrowerSignals, score_borrower, rate_bps_for_score


def test_anonymous_gets_worst_rate():
    r = score_borrower(BorrowerSignals())
    assert r.has_proof is False
    assert r.trust_score == 0
    assert r.rate_bps == 1400
    assert r.rate_pct == 14.0


def test_strong_borrower_gets_best_tier():
    # README demo "User B": ZK solvency proof + healthy on-chain history.
    r = score_borrower(BorrowerSignals(
        income_ok=True,
        solvency_ok=True,
        repayment_ok=True,
        wallet_age_days=540,
        tx_count=320,
        prior_loans_repaid=8,
    ))
    assert r.has_proof is True
    assert r.trust_score >= 90
    assert r.rate_bps == 600  # 6%


def test_defaults_and_fraud_penalize():
    clean = score_borrower(BorrowerSignals(income_ok=True, solvency_ok=True, wallet_age_days=365))
    risky = score_borrower(BorrowerSignals(
        income_ok=True, solvency_ok=True, wallet_age_days=365,
        default_events=2, fraud_signals=1,
    ))
    assert risky.trust_score < clean.trust_score


def test_single_proof_is_mid_tier():
    r = score_borrower(BorrowerSignals(solvency_ok=True))
    assert r.has_proof is True
    assert 60 <= r.trust_score < 90


def test_rate_tier_boundaries():
    assert rate_bps_for_score(100) == 600
    assert rate_bps_for_score(90) == 600
    assert rate_bps_for_score(89) == 800
    assert rate_bps_for_score(80) == 800
    assert rate_bps_for_score(79) == 1000
    assert rate_bps_for_score(60) == 1000
    assert rate_bps_for_score(59) == 1400
    assert rate_bps_for_score(0) == 1400
