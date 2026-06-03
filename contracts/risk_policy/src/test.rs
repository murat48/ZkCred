#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, vec, Env};

fn client(env: &Env) -> RiskPolicyClient<'static> {
    let admin = Address::generate(env);
    let id = env.register(RiskPolicy, (admin,));
    RiskPolicyClient::new(env, &id)
}

#[test]
fn default_tiers_match_readme() {
    let env = Env::default();
    let c = client(&env);

    assert_eq!(c.rate_bps(&0), 1400); // anonymous / sub-60
    assert_eq!(c.rate_bps(&59), 1400);
    assert_eq!(c.rate_bps(&60), 1000);
    assert_eq!(c.rate_bps(&79), 1000);
    assert_eq!(c.rate_bps(&80), 800);
    assert_eq!(c.rate_bps(&89), 800);
    assert_eq!(c.rate_bps(&90), 600);
    assert_eq!(c.rate_bps(&100), 600);
    assert_eq!(c.anonymous_rate_bps(), 1400);
}

#[test]
fn score_out_of_range_errors() {
    let env = Env::default();
    let c = client(&env);
    assert_eq!(c.try_rate_bps(&101), Err(Ok(Error::ScoreOutOfRange)));
}

#[test]
fn admin_can_update_tiers() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(RiskPolicy, (admin,));
    let c = RiskPolicyClient::new(&env, &id);

    let tiers = vec![
        &env,
        RateTier { min_score: 0, rate_bps: 2000 },
        RateTier { min_score: 50, rate_bps: 500 },
    ];
    c.set_tiers(&tiers);

    assert_eq!(c.rate_bps(&10), 2000);
    assert_eq!(c.rate_bps(&50), 500);
    assert_eq!(c.rate_bps(&99), 500);
}
