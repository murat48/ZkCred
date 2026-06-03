#![no_std]
//! rate_calculator — stateless personalized interest math.
//!
//! Pure functions: principal + annual rate (bps) + term → interest / total due.
//! Simple (non-compounding) interest, integer arithmetic, checked everywhere.

use soroban_sdk::{contract, contracterror, contractimpl, Env};

const BPS_DENOM: i128 = 10_000;
const DAYS_PER_YEAR: i128 = 365;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidPrincipal = 1,
    Overflow = 2,
}

#[contract]
pub struct RateCalculator;

#[contractimpl]
impl RateCalculator {
    /// Simple interest accrued: principal · rate_bps · term_days / (10000 · 365).
    pub fn interest(env: Env, principal: i128, rate_bps: u32, term_days: u32) -> Result<i128, Error> {
        let _ = &env;
        if principal <= 0 {
            return Err(Error::InvalidPrincipal);
        }
        let numerator = principal
            .checked_mul(rate_bps as i128)
            .and_then(|v| v.checked_mul(term_days as i128))
            .ok_or(Error::Overflow)?;
        let denom = BPS_DENOM.checked_mul(DAYS_PER_YEAR).ok_or(Error::Overflow)?;
        Ok(numerator / denom)
    }

    /// Principal + accrued interest.
    pub fn total_due(env: Env, principal: i128, rate_bps: u32, term_days: u32) -> Result<i128, Error> {
        let interest = Self::interest(env, principal, rate_bps, term_days)?;
        principal.checked_add(interest).ok_or(Error::Overflow)
    }
}

#[cfg(test)]
mod test;
