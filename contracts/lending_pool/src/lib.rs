#![no_std]
//! lending_pool — application layer (state transition after verifier + policy pass).
//!
//! Orchestrates the full zkCredit flow:
//!   1. `proof_verifier.verify_with_context` — cryptographic gate + anti-replay.
//!   2. trusted `oracle` attests the AI trust score (purchased off-chain via x402).
//!   3. `risk_policy.rate_bps(score)` — score -> interest tier.
//!   4. `rate_calculator.total_due(...)` — personalized repayment amount.
//!   5. disburse USDC and record the loan.
//!
//! Borrowers without a proof can still borrow via `borrow_anonymous` at the
//! worst (anonymous) tier — the README's "User A" path.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{G1Affine, G2Affine},
    symbol_short,
    token::TokenClient,
    Address, BytesN, Env, Vec,
};

/// Groth16 proof — layout identical to `proof_verifier::Proof` so cross-contract
/// serialization matches. lending_pool only forwards it; it never inspects it.
#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: G1Affine,
    pub b: G2Affine,
    pub c: G1Affine,
}

// Interfaces to the sibling contracts. Generated clients call by address; no
// implementation code from those crates is linked into this contract's wasm.
#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_with_context(
        env: Env,
        proof: Proof,
        public_inputs: Vec<u128>,
        nonce: BytesN<32>,
        expiry_ledger: u32,
    ) -> bool;
}

#[contractclient(name = "PolicyClient")]
pub trait PolicyInterface {
    fn rate_bps(env: Env, trust_score: u32) -> u32;
    fn anonymous_rate_bps(env: Env) -> u32;
}

#[contractclient(name = "CalcClient")]
pub trait CalcInterface {
    fn total_due(env: Env, principal: i128, rate_bps: u32, term_days: u32) -> i128;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub principal: i128,
    pub rate_bps: u32,
    pub term_days: u32,
    pub start_ledger: u32,
    pub total_due: i128,
    pub repaid: i128,
    pub trust_score: u32,
    pub anonymous: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Usdc,
    Verifier,
    Policy,
    Calculator,
    Oracle,
    TotalLiquidity,
    LpBalance(Address),
    Loan(Address),
    Defaults(Address),         // cumulative default count per borrower
    RepaidCount(Address),      // cumulative fully-repaid loan count per borrower
    InstallmentSlot(Address, u32), // installment loans: slot 0/1/2 per borrower
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    InvalidAmount = 2,
    InsufficientLiquidity = 3,
    ProofRejected = 4,
    LoanAlreadyActive = 5,
    NoActiveLoan = 6,
    InsufficientLpBalance = 7,
    Overflow = 8,
    LoanNotExpired = 9,
    Unauthorized = 10,
    ExceedsLimit = 11,    // amount > oracle-attested credit limit
    InvalidSlot = 12,     // installment slot must be 0, 1, or 2
}

/// ~5 seconds per ledger on Stellar mainnet/testnet.
const LEDGERS_PER_DAY: u32 = 17_280;

const INSTANCE_TTL_THRESHOLD: u32 = 100;
const INSTANCE_TTL_EXTEND: u32 = 518_400;

/// Domain-separation tag bound into every proof (big-endian "zkcredit_pool_v1").
/// The circuit commits to it as a public input and this contract reconstructs it,
/// so a proof minted for another protocol can never be replayed here.
const PROTOCOL_ID: u128 = 162_723_408_271_563_627_761_121_128_780_390_168_113;

#[contract]
pub struct LendingPool;

#[contractimpl]
impl LendingPool {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        usdc: Address,
        verifier: Address,
        policy: Address,
        calculator: Address,
        oracle: Address,
    ) {
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::Verifier, &verifier);
        s.set(&DataKey::Policy, &policy);
        s.set(&DataKey::Calculator, &calculator);
        s.set(&DataKey::Oracle, &oracle);
        s.set(&DataKey::TotalLiquidity, &0i128);
    }

    /// Liquidity provider deposits USDC into the pool.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::usdc(&env).transfer(&from, &env.current_contract_address(), &amount);

        let bal = Self::lp_balance(env.clone(), from.clone())
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        env.storage().persistent().set(&DataKey::LpBalance(from), &bal);
        Self::add_liquidity(&env, amount)?;
        Self::bump(&env);
        Ok(())
    }

    /// Liquidity provider withdraws available (un-lent) USDC.
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        to.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let bal = Self::lp_balance(env.clone(), to.clone());
        if bal < amount {
            return Err(Error::InsufficientLpBalance);
        }
        if Self::liquidity(env.clone()) < amount {
            return Err(Error::InsufficientLiquidity);
        }
        env.storage()
            .persistent()
            .set(&DataKey::LpBalance(to.clone()), &(bal - amount));
        Self::add_liquidity(&env, -amount)?;
        Self::usdc(&env).transfer(&env.current_contract_address(), &to, &amount);
        Self::bump(&env);
        Ok(())
    }

    /// Borrow against a ZK proof at a personalized, score-based rate.
    ///
    /// `trust_score` is attested by the registered `oracle` (require_auth), which
    /// computed it off-chain after the lender purchased it over x402. The proof
    /// itself is verified on-chain here, so the cryptographic claim is trustless;
    /// the score mapping is delegated to the trusted oracle by design.
    ///
    /// `public_inputs` carries ONLY the circuit's flag outputs (e.g. income_ok,
    /// solvency_ok). The request context — protocol_id, the 32-byte `nonce` split
    /// into two 128-bit limbs, and `expiry_ledger` — is appended HERE from the
    /// pool's own trusted args. Because the circuit commits to those same context
    /// values as public inputs, the proof only verifies when they match: a proof
    /// cannot be replayed under a fresh nonce, after expiry, or by another protocol.
    /// Credit limit is read from public_inputs[1] (max_loan), which is a public OUTPUT
    /// of the ZK circuit — computed deterministically from the borrower's private income
    /// and tier. The prover cannot inflate it: the circuit enforces
    ///   max_loan = monthly_income × tier_ratio × 2000
    /// This makes the limit cryptographically derived, not oracle-claimed.
    #[allow(clippy::too_many_arguments)]
    pub fn borrow_with_proof(
        env: Env,
        borrower: Address,
        amount: i128,
        term_days: u32,
        proof: Proof,
        public_inputs: Vec<u128>,
        trust_score: u32,
        nonce: BytesN<32>,
        expiry_ledger: u32,
    ) -> Result<Loan, Error> {
        borrower.require_auth();
        Self::oracle(&env).require_auth();

        // Credit limit enforcement: read max_loan from public_inputs[1].
        // public_inputs layout: [tier, max_loan, protocol_id, nonce_hi, nonce_lo, expiry, borrower_hi, borrower_lo]
        // max_loan is a ZK circuit output — derived from private income, not oracle-provided.
        let max_loan = public_inputs.get(1).ok_or(Error::InvalidAmount)? as i128;
        if amount > max_loan {
            return Err(Error::ExceedsLimit);
        }

        Self::ensure_borrowable(&env, &borrower, amount)?;

        // Append the trusted context so the proof is bound to THIS request.
        // Order MUST match the circuit's public-signal layout:
        //   [..flags.., protocol_id, nonce_hi, nonce_lo, expiry, borrower_hi, borrower_lo]
        // Each element added here is reconstructed from the pool's own trusted state
        // or args, so callers cannot tamper with them.
        let mut full_inputs = public_inputs.clone();
        full_inputs.push_back(PROTOCOL_ID);
        let nb = nonce.to_array();
        full_inputs.push_back(Self::u128_be(&nb, 0)); // nonce high 128 bits
        full_inputs.push_back(Self::u128_be(&nb, 16)); // nonce low 128 bits
        full_inputs.push_back(expiry_ledger as u128);
        // Bind proof to the borrower address: SHA-256(StrKey string) → two u128
        // limbs appended as trusted context. A proof minted for borrower A cannot
        // verify under borrower B because vk_x encodes the hash.
        let addr_hash = env.crypto().sha256(&borrower.to_string().to_bytes());
        let hb = addr_hash.to_array();
        full_inputs.push_back(Self::u128_be(&hb, 0));  // borrower_hi
        full_inputs.push_back(Self::u128_be(&hb, 16)); // borrower_lo

        let verifier = VerifierClient::new(&env, &Self::addr(&env, DataKey::Verifier));
        let ok = verifier.verify_with_context(&proof, &full_inputs, &nonce, &expiry_ledger);
        if !ok {
            return Err(Error::ProofRejected);
        }

        let rate_bps =
            PolicyClient::new(&env, &Self::addr(&env, DataKey::Policy)).rate_bps(&trust_score);

        Self::open_loan(&env, &borrower, amount, term_days, rate_bps, trust_score, false)
    }

    /// 3-month installment borrow: creates ONE of up to 3 independent loan slots
    /// (slot 0, 1, 2) for the same borrower. Each slot holds amount/3 with term=30d.
    /// Requires the same dual-auth (oracle + borrower) and a fresh ZK proof per slot.
    #[allow(clippy::too_many_arguments)]
    pub fn borrow_installment(
        env: Env,
        borrower: Address,
        slot: u32,
        amount: i128,
        term_days: u32,
        proof: Proof,
        public_inputs: Vec<u128>,
        trust_score: u32,
        nonce: BytesN<32>,
        expiry_ledger: u32,
    ) -> Result<Loan, Error> {
        borrower.require_auth();
        Self::oracle(&env).require_auth();

        if slot > 2 {
            return Err(Error::InvalidSlot);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if env.storage().persistent().has(&DataKey::InstallmentSlot(borrower.clone(), slot)) {
            return Err(Error::LoanAlreadyActive);
        }
        if Self::liquidity(env.clone()) < amount {
            return Err(Error::InsufficientLiquidity);
        }

        // Credit limit: max_loan is public_inputs[1] (ZK circuit output).
        let max_loan = public_inputs.get(1).ok_or(Error::InvalidAmount)? as i128;
        if amount > max_loan {
            return Err(Error::ExceedsLimit);
        }

        // Append trusted context and verify proof (same as borrow_with_proof).
        let mut full_inputs = public_inputs.clone();
        full_inputs.push_back(PROTOCOL_ID);
        let nb = nonce.to_array();
        full_inputs.push_back(Self::u128_be(&nb, 0));
        full_inputs.push_back(Self::u128_be(&nb, 16));
        full_inputs.push_back(expiry_ledger as u128);
        let addr_hash = env.crypto().sha256(&borrower.to_string().to_bytes());
        let hb = addr_hash.to_array();
        full_inputs.push_back(Self::u128_be(&hb, 0));
        full_inputs.push_back(Self::u128_be(&hb, 16));

        let verifier = VerifierClient::new(&env, &Self::addr(&env, DataKey::Verifier));
        let ok = verifier.verify_with_context(&proof, &full_inputs, &nonce, &expiry_ledger);
        if !ok {
            return Err(Error::ProofRejected);
        }

        let rate_bps =
            PolicyClient::new(&env, &Self::addr(&env, DataKey::Policy)).rate_bps(&trust_score);
        let total_due = CalcClient::new(&env, &Self::addr(&env, DataKey::Calculator))
            .total_due(&amount, &rate_bps, &term_days);

        Self::add_liquidity(&env, -amount)?;
        Self::usdc(&env).transfer(&env.current_contract_address(), &borrower, &amount);

        let loan = Loan {
            principal: amount,
            rate_bps,
            term_days,
            start_ledger: env.ledger().sequence(),
            total_due,
            repaid: 0,
            trust_score,
            anonymous: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::InstallmentSlot(borrower.clone(), slot), &loan);

        env.events().publish(
            (symbol_short!("loan_ins"), borrower.clone()),
            (slot, amount, rate_bps, total_due, trust_score),
        );

        Self::bump(&env);
        Ok(loan)
    }

    /// Repay one installment slot (partial or full).
    pub fn repay_installment(env: Env, borrower: Address, slot: u32, amount: i128) -> Result<i128, Error> {
        borrower.require_auth();
        if slot > 2 {
            return Err(Error::InvalidSlot);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&DataKey::InstallmentSlot(borrower.clone(), slot))
            .ok_or(Error::NoActiveLoan)?;

        let outstanding = loan.total_due - loan.repaid;
        let pay = if amount < outstanding { amount } else { outstanding };

        Self::usdc(&env).transfer(&borrower, &env.current_contract_address(), &pay);
        loan.repaid = loan.repaid.checked_add(pay).ok_or(Error::Overflow)?;
        Self::add_liquidity(&env, pay)?;

        let remaining = loan.total_due - loan.repaid;
        if loan.repaid >= loan.total_due {
            env.storage().persistent().remove(&DataKey::InstallmentSlot(borrower.clone(), slot));
            let rc: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::RepaidCount(borrower.clone()))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::RepaidCount(borrower.clone()), &(rc + 1));
            env.events().publish(
                (symbol_short!("ins_rep"), borrower),
                (slot, rc + 1u32),
            );
        } else {
            env.storage().persistent().set(&DataKey::InstallmentSlot(borrower, slot), &loan);
        }
        Self::bump(&env);
        Ok(if remaining > 0 { remaining } else { 0 })
    }

    /// Read all 3 installment slots for a borrower (None if slot not active).
    pub fn get_installment_loans(env: Env, borrower: Address) -> Vec<Option<Loan>> {
        let mut out = Vec::new(&env);
        for slot in 0u32..3u32 {
            out.push_back(
                env.storage()
                    .persistent()
                    .get(&DataKey::InstallmentSlot(borrower.clone(), slot)),
            );
        }
        out
    }

    /// Borrow with no proof — the anonymous (worst) tier. README "User A".
    pub fn borrow_anonymous(
        env: Env,
        borrower: Address,
        amount: i128,
        term_days: u32,
    ) -> Result<Loan, Error> {
        borrower.require_auth();
        Self::ensure_borrowable(&env, &borrower, amount)?;

        let rate_bps =
            PolicyClient::new(&env, &Self::addr(&env, DataKey::Policy)).anonymous_rate_bps();

        Self::open_loan(&env, &borrower, amount, term_days, rate_bps, 0, true)
    }

    /// Repay (partial or full). Returns remaining balance due.
    pub fn repay(env: Env, borrower: Address, amount: i128) -> Result<i128, Error> {
        borrower.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&DataKey::Loan(borrower.clone()))
            .ok_or(Error::NoActiveLoan)?;

        // Cap the charge at the outstanding balance: never pull more from the
        // borrower than they still owe. A caller may pass a large "pay it all"
        // amount; we only ever transfer `min(amount, outstanding)`.
        let outstanding = loan.total_due - loan.repaid;
        let pay = if amount < outstanding { amount } else { outstanding };

        Self::usdc(&env).transfer(&borrower, &env.current_contract_address(), &pay);
        loan.repaid = loan.repaid.checked_add(pay).ok_or(Error::Overflow)?;

        // Principal returns to the pool's lendable liquidity.
        Self::add_liquidity(&env, pay)?;

        let remaining = loan.total_due - loan.repaid;
        if loan.repaid >= loan.total_due {
            env.storage().persistent().remove(&DataKey::Loan(borrower.clone()));
            // Increment on-chain repaid-loan count — drives creditworthiness tier.
            let rc: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::RepaidCount(borrower.clone()))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::RepaidCount(borrower.clone()), &(rc + 1));
            env.events().publish(
                (symbol_short!("loan_rep"), borrower),
                (rc + 1u32,),
            );
        } else {
            env.storage().persistent().set(&DataKey::Loan(borrower), &loan);
        }
        Self::bump(&env);
        Ok(if remaining > 0 { remaining } else { 0 })
    }

    /// Read-only quote: rate + total due for a hypothetical loan.
    pub fn quote(
        env: Env,
        trust_score: u32,
        amount: i128,
        term_days: u32,
    ) -> Result<(u32, i128), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let rate_bps =
            PolicyClient::new(&env, &Self::addr(&env, DataKey::Policy)).rate_bps(&trust_score);
        let total = CalcClient::new(&env, &Self::addr(&env, DataKey::Calculator))
            .total_due(&amount, &rate_bps, &term_days);
        Ok((rate_bps, total))
    }

    pub fn get_loan(env: Env, borrower: Address) -> Option<Loan> {
        env.storage().persistent().get(&DataKey::Loan(borrower))
    }

    /// Return the number of times this borrower has fully repaid a loan.
    /// Used by the oracle as a ZK witness input for the creditworthiness circuit.
    pub fn get_repaid_count(env: Env, borrower: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::RepaidCount(borrower))
            .unwrap_or(0)
    }

    /// Return the number of defaults recorded against this borrower.
    /// A non-zero value blocks proof generation in the creditworthiness circuit.
    pub fn get_defaults(env: Env, borrower: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Defaults(borrower))
            .unwrap_or(0)
    }

    /// Mark an expired, unpaid loan as defaulted.
    /// Anyone can call this once the loan term has elapsed — no admin required.
    /// The bad debt is written off and the default count increments permanently.
    pub fn mark_default(env: Env, borrower: Address) -> Result<(), Error> {
        let loan: Loan = env
            .storage()
            .persistent()
            .get(&DataKey::Loan(borrower.clone()))
            .ok_or(Error::NoActiveLoan)?;

        let current = env.ledger().sequence();
        let ledgers = loan.term_days.saturating_mul(LEDGERS_PER_DAY);
        let expiry = loan.start_ledger.saturating_add(ledgers);
        if current <= expiry {
            return Err(Error::LoanNotExpired);
        }

        let outstanding = loan.total_due.saturating_sub(loan.repaid);
        if outstanding <= 0 {
            return Err(Error::NoActiveLoan);
        }

        Self::record_default(&env, &borrower, outstanding)
    }

    /// Admin override: mark a loan as defaulted without waiting for expiry.
    /// Intended for demo / test environments only.
    pub fn force_default(env: Env, borrower: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        let loan: Loan = env
            .storage()
            .persistent()
            .get(&DataKey::Loan(borrower.clone()))
            .ok_or(Error::NoActiveLoan)?;

        let outstanding = loan.total_due.saturating_sub(loan.repaid);
        Self::record_default(&env, &borrower, outstanding)
    }

    pub fn liquidity(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalLiquidity)
            .unwrap_or(0)
    }

    pub fn lp_balance(env: Env, lp: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LpBalance(lp))
            .unwrap_or(0)
    }

    // ---- internal ----

    fn open_loan(
        env: &Env,
        borrower: &Address,
        amount: i128,
        term_days: u32,
        rate_bps: u32,
        trust_score: u32,
        anonymous: bool,
    ) -> Result<Loan, Error> {
        let total_due = CalcClient::new(env, &Self::addr(env, DataKey::Calculator))
            .total_due(&amount, &rate_bps, &term_days);

        Self::add_liquidity(env, -amount)?;
        Self::usdc(env).transfer(&env.current_contract_address(), borrower, &amount);

        let loan = Loan {
            principal: amount,
            rate_bps,
            term_days,
            start_ledger: env.ledger().sequence(),
            total_due,
            repaid: 0,
            trust_score,
            anonymous,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Loan(borrower.clone()), &loan);

        // Emit the originated loan so the full pipeline is observable on-chain:
        // topic ("loan_new", borrower) + data (principal, rate_bps, total_due, score).
        env.events().publish(
            (symbol_short!("loan_new"), borrower.clone()),
            (amount, rate_bps, total_due, trust_score, anonymous),
        );

        Self::bump(env);
        Ok(loan)
    }

    fn record_default(env: &Env, borrower: &Address, outstanding: i128) -> Result<(), Error> {
        let n: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Defaults(borrower.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Defaults(borrower.clone()), &(n + 1));
        env.storage()
            .persistent()
            .remove(&DataKey::Loan(borrower.clone()));
        env.events().publish(
            (symbol_short!("default"), borrower.clone()),
            (n + 1u32, outstanding),
        );
        Self::bump(env);
        Ok(())
    }

    fn ensure_borrowable(env: &Env, borrower: &Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Loan(borrower.clone()))
        {
            return Err(Error::LoanAlreadyActive);
        }
        if Self::liquidity(env.clone()) < amount {
            return Err(Error::InsufficientLiquidity);
        }
        Ok(())
    }

    /// Read 16 big-endian bytes at `off` as a u128 (for splitting a 32-byte nonce
    /// into the two field-element limbs the circuit commits to).
    fn u128_be(bytes: &[u8; 32], off: usize) -> u128 {
        let mut b = [0u8; 16];
        b.copy_from_slice(&bytes[off..off + 16]);
        u128::from_be_bytes(b)
    }

    fn add_liquidity(env: &Env, delta: i128) -> Result<(), Error> {
        let new = Self::liquidity(env.clone())
            .checked_add(delta)
            .ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::TotalLiquidity, &new);
        Ok(())
    }

    fn usdc(env: &Env) -> TokenClient {
        TokenClient::new(env, &Self::addr(env, DataKey::Usdc))
    }

    fn oracle(env: &Env) -> Address {
        Self::addr(env, DataKey::Oracle)
    }

    fn addr(env: &Env, key: DataKey) -> Address {
        env.storage().instance().get(&key).unwrap()
    }

    fn bump(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}

#[cfg(test)]
mod test;
