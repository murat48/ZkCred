#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    vec, Bytes, Env,
};

const DST: &[u8] = b"zkcredit-groth16-bls12381-test";

/// Build a Groth16 instance that satisfies the verifier's pairing equation
/// without an external trusted setup, by exploiting bilinearity:
/// fix B = beta = gamma = delta = Q, then the check collapses to
/// e(-A + alpha + vk_x + C, Q) == 1, which holds iff A = alpha + vk_x + C.
fn satisfying_instance(env: &Env, inputs: &Vec<u128>) -> (VerificationKey, Proof) {
    let bls = env.crypto().bls12_381();
    let dst = Bytes::from_slice(env, DST);

    let q = bls.hash_to_g2(&Bytes::from_slice(env, b"Q"), &dst);
    let alpha = bls.hash_to_g1(&Bytes::from_slice(env, b"alpha"), &dst);
    let c = bls.hash_to_g1(&Bytes::from_slice(env, b"c"), &dst);

    // One ic point per public input, plus the constant term ic[0].
    let mut ic: Vec<G1Affine> = Vec::new(env);
    ic.push_back(bls.hash_to_g1(&Bytes::from_slice(env, b"ic0"), &dst));
    for i in 0..inputs.len() {
        let mut tag = [0u8; 4];
        tag[0] = b'i';
        tag[3] = i as u8;
        ic.push_back(bls.hash_to_g1(&Bytes::from_slice(env, &tag), &dst));
    }

    // vk_x = ic[0] + Σ inputs[i] · ic[i+1]
    let mut vk_x = ic.get(0).unwrap();
    for i in 0..inputs.len() {
        let term = bls.g1_mul(&ic.get(i + 1).unwrap(), &fr_from_u128(env, inputs.get(i).unwrap()));
        vk_x = bls.g1_add(&vk_x, &term);
    }

    // A = alpha + vk_x + C  =>  -A + alpha + vk_x + C = O
    let a = bls.g1_add(&bls.g1_add(&alpha, &vk_x), &c);

    let vk = VerificationKey {
        alpha,
        beta: q.clone(),
        gamma: q.clone(),
        delta: q.clone(),
        ic,
    };
    let proof = Proof { a, b: q, c };
    (vk, proof)
}

fn setup(env: &Env, inputs: &Vec<u128>) -> (ProofVerifierClient<'static>, Proof) {
    let admin = Address::generate(env);
    let (vk, proof) = satisfying_instance(env, inputs);
    let id = env.register(ProofVerifier, (admin, vk));
    (ProofVerifierClient::new(env, &id), proof)
}

#[test]
fn valid_proof_verifies() {
    let env = Env::default();
    let inputs = vec![&env, 1u128, 80u128];
    let (client, proof) = setup(&env, &inputs);
    assert!(client.verify_proof(&proof, &inputs));
}

#[test]
fn tampered_public_inputs_rejected() {
    let env = Env::default();
    let inputs = vec![&env, 1u128, 80u128];
    let (client, proof) = setup(&env, &inputs);

    // Proof was bound to score 80; claiming 95 must fail.
    let forged = vec![&env, 1u128, 95u128];
    assert!(!client.verify_proof(&proof, &forged));
}

#[test]
fn wrong_input_arity_errors() {
    let env = Env::default();
    let inputs = vec![&env, 1u128, 80u128];
    let (client, proof) = setup(&env, &inputs);

    let too_many = vec![&env, 1u128, 80u128, 0u128];
    assert_eq!(
        client.try_verify_proof(&proof, &too_many),
        Err(Ok(Error::InvalidPublicInputs))
    );
}

#[test]
fn nonce_replay_is_rejected() {
    let env = Env::default();
    env.ledger().set_sequence_number(100);
    let inputs = vec![&env, 1u128, 80u128];
    let (client, proof) = setup(&env, &inputs);

    let nonce = BytesN::from_array(&env, &[7u8; 32]);
    let expiry = 200u32;

    assert!(client.verify_with_context(&proof, &inputs, &nonce, &expiry));
    assert!(client.is_nonce_used(&nonce));

    // Same nonce again — replay blocked.
    assert_eq!(
        client.try_verify_with_context(&proof, &inputs, &nonce, &expiry),
        Err(Ok(Error::NonceAlreadyUsed))
    );
}

#[test]
fn expired_proof_is_rejected() {
    let env = Env::default();
    env.ledger().set_sequence_number(500);
    let inputs = vec![&env, 1u128, 80u128];
    let (client, proof) = setup(&env, &inputs);

    let nonce = BytesN::from_array(&env, &[9u8; 32]);
    let expiry = 400u32; // already in the past

    assert_eq!(
        client.try_verify_with_context(&proof, &inputs, &nonce, &expiry),
        Err(Ok(Error::ProofExpired))
    );
}

#[test]
fn failed_proof_does_not_burn_nonce() {
    let env = Env::default();
    env.ledger().set_sequence_number(10);
    let inputs = vec![&env, 1u128, 80u128];
    let (client, proof) = setup(&env, &inputs);

    let nonce = BytesN::from_array(&env, &[3u8; 32]);
    let forged = vec![&env, 1u128, 95u128];

    // Invalid proof returns false but must NOT consume the nonce.
    assert!(!client.verify_with_context(&proof, &forged, &nonce, &1000u32));
    assert!(!client.is_nonce_used(&nonce));

    // The honest proof can still use that nonce.
    assert!(client.verify_with_context(&proof, &inputs, &nonce, &1000u32));
    assert!(client.is_nonce_used(&nonce));
}
