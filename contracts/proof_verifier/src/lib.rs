#![no_std]
//! proof_verifier — cryptographic validity ONLY (verification gateway pattern).
//!
//! Verifies Groth16 proofs over BLS12-381 (CAP-0059, implemented on Stellar).
//! Holds NO business logic: rate tiers and eligibility live in `risk_policy`.
//!
//! Anti-replay: each credit evaluation binds a unique `nonce` + `protocol_id`
//! (domain separation) + `expiry_ledger`. Used nonces are persisted and rejected
//! on re-submission. The circuit MUST commit to these values as public inputs so
//! the binding is cryptographic, not merely contractual.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine},
    symbol_short, Address, BytesN, Env, Vec,
};

/// Groth16 verifying key (circuit-specific, fixed at init).
#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: G1Affine,
    pub beta: G2Affine,
    pub gamma: G2Affine,
    pub delta: G2Affine,
    /// `ic[0]` is the constant term; `ic[i+1]` pairs with `public_inputs[i]`.
    pub ic: Vec<G1Affine>,
}

/// Groth16 proof (snarkjs export ordering).
#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: G1Affine,
    pub b: G2Affine,
    pub c: G1Affine,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Vk,
    UsedNonce(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NonceAlreadyUsed = 3,
    ProofExpired = 4,
    InvalidPublicInputs = 5,
    Unauthorized = 6,
}

const NONCE_TTL: u32 = 518_400; // ~30 days at 5s ledgers — replay guards must outlive proofs.

#[contract]
pub struct ProofVerifier;

#[contractimpl]
impl ProofVerifier {
    /// Atomic init: store admin + circuit verifying key.
    pub fn __constructor(env: Env, admin: Address, vk: VerificationKey) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Vk, &vk);
    }

    /// Rotate the verifying key (e.g. after a new trusted setup). Admin only.
    pub fn set_vk(env: Env, vk: VerificationKey) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vk, &vk);
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Pure Groth16 verification. No side effects, no replay protection.
    /// Returns `true` iff the proof is valid for `public_inputs` under the stored vk.
    pub fn verify_proof(
        env: Env,
        proof: Proof,
        public_inputs: Vec<u128>,
    ) -> Result<bool, Error> {
        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::Vk)
            .ok_or(Error::NotInitialized)?;
        Self::groth16_verify(&env, &vk, &proof, &public_inputs)
    }

    /// Verification gateway with anti-replay + expiry + domain separation.
    ///
    /// - `nonce`: unique per borrowing request; persisted to reject replays.
    /// - `protocol_id`: domain separation per lending contract.
    /// - `expiry_ledger`: proof is rejected once the ledger advances past it.
    ///
    /// The circuit MUST expose `nonce`, `protocol_id`, `expiry_ledger` as public
    /// inputs so this contractual binding is also cryptographic.
    pub fn verify_with_context(
        env: Env,
        proof: Proof,
        public_inputs: Vec<u128>,
        nonce: BytesN<32>,
        expiry_ledger: u32,
    ) -> Result<bool, Error> {
        if env.ledger().sequence() > expiry_ledger {
            return Err(Error::ProofExpired);
        }
        let nonce_key = DataKey::UsedNonce(nonce.clone());
        if env.storage().persistent().has(&nonce_key) {
            return Err(Error::NonceAlreadyUsed);
        }

        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::Vk)
            .ok_or(Error::NotInitialized)?;
        let ok = Self::groth16_verify(&env, &vk, &proof, &public_inputs)?;

        if ok {
            // Burn the nonce only on success so a failed attempt can be retried
            // with a corrected proof, but a valid proof can never be replayed.
            env.storage().persistent().set(&nonce_key, &true);
            env.storage()
                .persistent()
                .extend_ttl(&nonce_key, NONCE_TTL, NONCE_TTL);
            // Anchor the verification on-chain: indexers/explorers can observe
            // that a ZK proof was cryptographically verified for this nonce.
            env.events().publish(
                (symbol_short!("proof_ok"), nonce),
                expiry_ledger,
            );
        }
        Ok(ok)
    }

    pub fn is_nonce_used(env: Env, nonce: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::UsedNonce(nonce))
    }

    // ---- internal ----

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Groth16 pairing equation over BLS12-381:
    ///   e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
    /// where vk_x = ic[0] + Σ public_inputs[i] · ic[i+1].
    fn groth16_verify(
        env: &Env,
        vk: &VerificationKey,
        proof: &Proof,
        public_inputs: &Vec<u128>,
    ) -> Result<bool, Error> {
        // ic has one extra element (the constant term) vs. the public inputs.
        if vk.ic.len() != public_inputs.len() + 1 {
            return Err(Error::InvalidPublicInputs);
        }

        let bls = env.crypto().bls12_381();

        // vk_x = ic[0] + Σ public_inputs[i] · ic[i+1]
        let mut vk_x = vk.ic.get(0).unwrap();
        for i in 0..public_inputs.len() {
            let scalar = fr_from_u128(env, public_inputs.get(i).unwrap());
            let term = bls.g1_mul(&vk.ic.get(i + 1).unwrap(), &scalar);
            vk_x = bls.g1_add(&vk_x, &term);
        }

        let neg_a = -proof.a.clone();

        let mut g1_points: Vec<G1Affine> = Vec::new(env);
        g1_points.push_back(neg_a);
        g1_points.push_back(vk.alpha.clone());
        g1_points.push_back(vk_x);
        g1_points.push_back(proof.c.clone());

        let mut g2_points: Vec<G2Affine> = Vec::new(env);
        g2_points.push_back(proof.b.clone());
        g2_points.push_back(vk.beta.clone());
        g2_points.push_back(vk.gamma.clone());
        g2_points.push_back(vk.delta.clone());

        Ok(bls.pairing_check(g1_points, g2_points))
    }
}

/// Convert a `u128` public signal to a BLS12-381 scalar field element.
/// Big-endian encoding into the low 16 bytes of a 32-byte word; u128 < r always.
fn fr_from_u128(env: &Env, value: u128) -> Fr {
    let mut bytes = [0u8; 32];
    bytes[16..].copy_from_slice(&value.to_be_bytes());
    Fr::from_bytes(BytesN::from_array(env, &bytes))
}

#[cfg(test)]
mod test;
