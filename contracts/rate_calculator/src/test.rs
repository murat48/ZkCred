#![cfg(test)]
use super::*;
use soroban_sdk::Env;

fn client(env: &Env) -> RateCalculatorClient<'static> {
    let id = env.register(RateCalculator, ());
    RateCalculatorClient::new(env, &id)
}

#[test]
fn full_year_simple_interest() {
    let env = Env::default();
    let c = client(&env);
    // 1000 USDC (7dp) at 6% for 365 days = 60 USDC.
    let principal = 1_000_0000000i128;
    assert_eq!(c.interest(&principal, &600, &365), 60_0000000i128);
    assert_eq!(c.total_due(&principal, &600, &365), 1_060_0000000i128);
}

#[test]
fn anonymous_vs_proven_rate_gap() {
    let env = Env::default();
    let c = client(&env);
    let principal = 1_000_0000000i128;
    // Same principal/term, different rate tiers (README demo: 14% vs 6%).
    let anon = c.interest(&principal, &1400, &365);
    let proven = c.interest(&principal, &600, &365);
    assert_eq!(anon, 140_0000000i128);
    assert_eq!(proven, 60_0000000i128);
    assert!(anon > proven);
}

#[test]
fn zero_principal_errors() {
    let env = Env::default();
    let c = client(&env);
    assert_eq!(c.try_interest(&0, &600, &365), Err(Ok(Error::InvalidPrincipal)));
}
