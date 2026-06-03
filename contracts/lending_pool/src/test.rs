#![cfg(test)]
use super::*;
use proof_verifier::{ProofVerifier, VerificationKey};
use rate_calculator::RateCalculator;
use risk_policy::RiskPolicy;
use soroban_sdk::{
    crypto::bls12_381::{Fr, G1Affine},
    testutils::Address as _,
    token::StellarAssetClient,
    vec, Bytes, Env,
};

const DST: &[u8] = b"zkcredit-lending-test";

fn fr_u128(env: &Env, v: u128) -> Fr {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&v.to_be_bytes());
    Fr::from_bytes(BytesN::from_array(env, &b))
}

// Build a Groth16 instance satisfying the verifier for `inputs` (see proof_verifier
// tests for the bilinearity trick: B=beta=gamma=delta=Q, A=alpha+vk_x+C).
fn satisfying_instance(env: &Env, inputs: &Vec<u128>) -> (VerificationKey, Proof) {
    let bls = env.crypto().bls12_381();
    let dst = Bytes::from_slice(env, DST);
    let q = bls.hash_to_g2(&Bytes::from_slice(env, b"Q"), &dst);
    let alpha = bls.hash_to_g1(&Bytes::from_slice(env, b"alpha"), &dst);
    let c = bls.hash_to_g1(&Bytes::from_slice(env, b"c"), &dst);

    let mut ic: Vec<G1Affine> = Vec::new(env);
    ic.push_back(bls.hash_to_g1(&Bytes::from_slice(env, b"ic0"), &dst));
    for i in 0..inputs.len() {
        let tag = [b'i', 0, 0, i as u8];
        ic.push_back(bls.hash_to_g1(&Bytes::from_slice(env, &tag), &dst));
    }
    let mut vk_x = ic.get(0).unwrap();
    for i in 0..inputs.len() {
        let term = bls.g1_mul(&ic.get(i + 1).unwrap(), &fr_u128(env, inputs.get(i).unwrap()));
        vk_x = bls.g1_add(&vk_x, &term);
    }
    let a = bls.g1_add(&bls.g1_add(&alpha, &vk_x), &c);
    (
        VerificationKey { alpha, beta: q.clone(), gamma: q.clone(), delta: q.clone(), ic },
        Proof { a, b: q, c },
    )
}

struct World {
    env: Env,
    pool: LendingPoolClient<'static>,
    usdc: Address,
    usdc_admin: StellarAssetClient<'static>,
    token: TokenClient<'static>,
    proof: Proof,
    inputs: Vec<u128>,
}

fn setup() -> World {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    // Proof commits to [income_ok, solvency_ok, protocol_id].
    let inputs = vec![&env, 1u128, 1u128, 1u128];
    let (vk, proof) = satisfying_instance(&env, &inputs);

    let verifier = env.register(ProofVerifier, (admin.clone(), vk));
    let policy = env.register(RiskPolicy, (admin.clone(),));
    let calculator = env.register(RateCalculator, ());

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc = sac.address();
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    let token = TokenClient::new(&env, &usdc);

    let pool_id = env.register(
        LendingPool,
        (admin, usdc.clone(), verifier, policy, calculator, oracle),
    );
    let pool = LendingPoolClient::new(&env, &pool_id);

    World { env, pool, usdc, usdc_admin, token, proof, inputs }
}

fn fund_pool(w: &World, amount: i128) -> Address {
    let lp = Address::generate(&w.env);
    w.usdc_admin.mint(&lp, &amount);
    w.pool.deposit(&lp, &amount);
    lp
}

const USDC: i128 = 10_000_000; // 1 USDC at 7 decimals

#[test]
fn deposit_and_withdraw() {
    let w = setup();
    let lp = fund_pool(&w, 1000 * USDC);
    assert_eq!(w.pool.liquidity(), 1000 * USDC);
    assert_eq!(w.pool.lp_balance(&lp), 1000 * USDC);

    w.pool.withdraw(&lp, &(400 * USDC));
    assert_eq!(w.pool.liquidity(), 600 * USDC);
    assert_eq!(w.token.balance(&lp), 400 * USDC);
}

#[test]
fn proven_borrower_gets_personalized_rate() {
    let w = setup();
    fund_pool(&w, 10_000 * USDC);

    let borrower = Address::generate(&w.env);
    let nonce = BytesN::from_array(&w.env, &[1u8; 32]);

    // trust_score 92 -> 6% tier.
    let loan = w.pool.borrow_with_proof(
        &borrower,
        &(1000 * USDC),
        &365u32,
        &w.proof,
        &w.inputs,
        &92u32,
        &nonce,
        &1000u32,
    );

    assert_eq!(loan.rate_bps, 600);
    assert_eq!(loan.trust_score, 92);
    assert!(!loan.anonymous);
    assert_eq!(loan.total_due, 1060 * USDC); // 1000 + 6%
    assert_eq!(w.token.balance(&borrower), 1000 * USDC);
    assert_eq!(w.pool.liquidity(), 9000 * USDC);
}

#[test]
fn anonymous_borrower_pays_worst_rate() {
    let w = setup();
    fund_pool(&w, 10_000 * USDC);

    let borrower = Address::generate(&w.env);
    let loan = w.pool.borrow_anonymous(&borrower, &(1000 * USDC), &365u32);

    assert_eq!(loan.rate_bps, 1400); // 14%
    assert!(loan.anonymous);
    assert_eq!(loan.total_due, 1140 * USDC);
}

#[test]
fn demo_scenario_rate_gap() {
    // README demo: same protocol, same collateral, different proof -> different rate.
    let w = setup();
    fund_pool(&w, 10_000 * USDC);

    let user_a = Address::generate(&w.env);
    let user_b = Address::generate(&w.env);
    let nonce = BytesN::from_array(&w.env, &[2u8; 32]);

    let a = w.pool.borrow_anonymous(&user_a, &(1000 * USDC), &365u32);
    let b = w.pool.borrow_with_proof(
        &user_b, &(1000 * USDC), &365u32, &w.proof, &w.inputs, &95u32, &nonce, &1000u32,
    );

    assert_eq!(a.rate_bps, 1400);
    assert_eq!(b.rate_bps, 600);
    assert!(a.total_due > b.total_due);
}

#[test]
fn invalid_proof_is_rejected() {
    let w = setup();
    fund_pool(&w, 10_000 * USDC);

    let borrower = Address::generate(&w.env);
    let nonce = BytesN::from_array(&w.env, &[3u8; 32]);
    // Forge the public inputs so the proof no longer satisfies the equation.
    let forged = vec![&w.env, 1u128, 1u128, 9u128];

    let res = w.pool.try_borrow_with_proof(
        &borrower, &(1000 * USDC), &365u32, &w.proof, &forged, &95u32, &nonce, &1000u32,
    );
    assert_eq!(res, Err(Ok(Error::ProofRejected)));
}

#[test]
fn cannot_borrow_beyond_liquidity() {
    let w = setup();
    fund_pool(&w, 500 * USDC);
    let borrower = Address::generate(&w.env);
    let res = w.pool.try_borrow_anonymous(&borrower, &(1000 * USDC), &365u32);
    assert_eq!(res, Err(Ok(Error::InsufficientLiquidity)));
}

#[test]
fn repay_clears_loan_and_restores_liquidity() {
    let w = setup();
    fund_pool(&w, 10_000 * USDC);
    let borrower = Address::generate(&w.env);

    let loan = w.pool.borrow_anonymous(&borrower, &(1000 * USDC), &365u32);
    // Give the borrower enough to repay the interest portion.
    w.usdc_admin.mint(&borrower, &(loan.total_due - 1000 * USDC));

    let remaining = w.pool.repay(&borrower, &loan.total_due);
    assert_eq!(remaining, 0);
    assert!(w.pool.get_loan(&borrower).is_none());
    // Principal + interest now back in the pool.
    assert_eq!(w.pool.liquidity(), 9000 * USDC + loan.total_due);
}

#[test]
fn quote_matches_tiers() {
    let w = setup();
    let (rate, total) = w.pool.quote(&90u32, &(1000 * USDC), &365u32);
    assert_eq!(rate, 600);
    assert_eq!(total, 1060 * USDC);
}
