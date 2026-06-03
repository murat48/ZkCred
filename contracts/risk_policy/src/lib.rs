#![no_std]
//! risk_policy — business/risk logic ONLY (policy-and-proof split).
//!
//! Maps a verified trust score (0–100) to an interest-rate tier. Holds NO
//! cryptography: proof validity is established upstream by `proof_verifier`.
//!
//! Default tiers (README):
//!   no proof / <60 → 14%,  60–79 → 10%,  80–89 → 8%,  90–100 → 6%.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateTier {
    /// Inclusive minimum trust score for this tier.
    pub min_score: u32,
    /// Annual interest rate in basis points (100 bps = 1%).
    pub rate_bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Tiers,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    EmptyTiers = 3,
    ScoreOutOfRange = 4,
}

const MAX_SCORE: u32 = 100;

#[contract]
pub struct RiskPolicy;

#[contractimpl]
impl RiskPolicy {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Tiers, &default_tiers(&env));
    }

    /// Replace the rate schedule. Admin only. Tiers may be supplied in any order.
    pub fn set_tiers(env: Env, tiers: Vec<RateTier>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if tiers.is_empty() {
            return Err(Error::EmptyTiers);
        }
        env.storage().instance().set(&DataKey::Tiers, &tiers);
        Ok(())
    }

    pub fn get_tiers(env: Env) -> Vec<RateTier> {
        env.storage()
            .instance()
            .get(&DataKey::Tiers)
            .unwrap_or_else(|| default_tiers(&env))
    }

    /// Interest rate (bps) for a verified trust score. Picks the highest tier
    /// whose `min_score` the score reaches.
    pub fn rate_bps(env: Env, trust_score: u32) -> Result<u32, Error> {
        if trust_score > MAX_SCORE {
            return Err(Error::ScoreOutOfRange);
        }
        let tiers = Self::get_tiers(env);
        let mut best_rate: u32 = 0;
        let mut best_min: i64 = -1;
        for t in tiers.iter() {
            if trust_score >= t.min_score && (t.min_score as i64) > best_min {
                best_min = t.min_score as i64;
                best_rate = t.rate_bps;
            }
        }
        Ok(best_rate)
    }

    /// Rate applied to borrowers with no ZK proof (the worst, score-0 tier).
    pub fn anonymous_rate_bps(env: Env) -> Result<u32, Error> {
        Self::rate_bps(env, 0)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }
}

fn default_tiers(env: &Env) -> Vec<RateTier> {
    let mut t: Vec<RateTier> = Vec::new(env);
    t.push_back(RateTier { min_score: 90, rate_bps: 600 });
    t.push_back(RateTier { min_score: 80, rate_bps: 800 });
    t.push_back(RateTier { min_score: 60, rate_bps: 1000 });
    t.push_back(RateTier { min_score: 0, rate_bps: 1400 });
    t
}

#[cfg(test)]
mod test;
