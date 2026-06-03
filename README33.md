# zkCredit

> Privacy-Preserving Credit Intelligence Layer for DeFi

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar%20Soroban-blue)](https://soroban.stellar.org)
[![ZK Proofs](https://img.shields.io/badge/ZK-Groth16%20%2F%20BLS12--381-purple)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md)
[![x402 Protocol](https://img.shields.io/badge/Payments-x402-green)](https://x402.org)

---

## Overview

zkCredit enables **privacy-preserving creditworthiness verification** for DeFi lending. Users prove their financial reputation — repayment history, solvency, income — using Zero-Knowledge proofs, without revealing any sensitive on-chain data.

Lenders receive a verifiable trust score. Borrowers receive personalized interest rates. No data is exposed.

---

## Problem

Current DeFi lending protocols:

- Require excessive overcollateralization (150–300%)
- Ignore user behavior and repayment history
- Apply identical interest rates to all users
- Offer no privacy mechanism for financial identity

**Result:** Capital inefficiency and exclusion of creditworthy users.

---

## Solution

zkCredit introduces a **ZK-powered reputation layer** between borrowers and lending protocols:

1. Users generate a ZK proof of their financial standing
2. A Risk Oracle verifies the proof and computes a trust score
3. The lending protocol purchases this score via **x402 machine-to-machine payment**
4. A Soroban smart contract applies a personalized interest rate

No transaction history is revealed. No wallet address is linked. No employer or income amount is disclosed.

---

## How It Works

```
User Wallet
    │
    │  Borrowing Request (e.g., 1000 USDC)
    ▼
ZK Proof Generator (Groth16 / snarkjs)
    │
    │  Proves: repayment_score > 80 OR monthly_income > 3000 USDC
    │  Hides:  exact amounts, transaction history, identity
    │  Circuit: BLS12-381 (CAP-0059, Implemented on Stellar)
    ▼
Risk Oracle (AI Agent)
    │
    │  Verifies proof → runs AI risk model → produces trust score
    ▼
x402 Payment Layer
    │
    │  Lending protocol pays oracle for risk intelligence
    │  Machine-to-machine, autonomous, programmable
    ▼
Soroban Lending Contract
    │
    │  Receives trust score → calculates interest rate → opens loan
    ▼
Borrower receives loan at personalized rate
```

---

## Demo Scenario

| User | ZK Proof | Interest Rate |
|------|----------|---------------|
| User A | None (anonymous) | 14% |
| User B | ZK Solvency Proof | 6% |

Same protocol. Same collateral. Different risk profile. Different rate.

---

## Architecture

### Frontend
- **Next.js** — Borrowing interface
- **Tailwind CSS** — UI styling

### Smart Contracts (Soroban)
| Contract | Responsibility |
|----------|----------------|
| `lending_pool` | Manages deposits and loan issuance |
| `risk_policy` | Defines rate tiers based on trust score |
| `proof_verifier` | Verifies ZK proofs on-chain |
| `rate_calculator` | Computes personalized interest rates |

### Backend Agents
| Agent | Responsibility |
|-------|----------------|
| Risk Agent | Borrower scoring, repayment analysis, fraud detection |
| Oracle Provider | ZK proof verification, reputation delivery via x402 |

### Privacy Layer

| Tool | Role | Status |
|------|------|--------|
| **Groth16** | Proving system (off-chain proof generation) | ✅ Production-ready |
| **snarkjs** | Off-chain proof generation + witness computation | ✅ Production-ready |
| **BLS12-381** | Elliptic curve for on-chain verification | ✅ CAP-0059 — Implemented on Stellar |
| **BN254 + Poseidon** | Alternative curve + hash | ⚠️ CAP-0074/0075 — Proposal stage, NOT production |

> **Important:** BN254 and Poseidon host functions (CAP-0074/0075) are **not yet implemented** on Stellar Mainnet or Testnet. zkCredit uses **BLS12-381 (CAP-0059)** which is fully implemented. Always verify CAP status and network protocol version before deployment.

#### Architecture Pattern (Policy-and-Proof Split)

zkCredit separates concerns following the skill-recommended pattern:

```
Verifier Contract   → cryptographic validity only (Groth16 + BLS12-381)
Policy Contract     → business/risk/rate logic
Lending Contract    → state transition after verifier + policy pass
```

### Payment Layer
- **x402 Protocol** — Machine-to-machine payment from lending protocol to risk oracle

---

## Project Structure

```
zkcredit/
├── contracts/               # Soroban smart contracts (Rust)
│   ├── lending_pool/
│   ├── risk_policy/
│   ├── proof_verifier/
│   └── rate_calculator/
├── circuits/                # ZK circuits (snarkjs / circom)
│   ├── solvency_proof/      # BLS12-381 Groth16 circuit
│   └── repayment_proof/     # BLS12-381 Groth16 circuit
├── agents/                  # Backend AI agents
│   ├── risk_agent/
│   └── oracle_provider/
├── frontend/                # Next.js application
│   ├── app/
│   ├── components/
│   └── lib/
├── x402/                    # x402 payment integration
└── tests/
```

---

## ZK Proof Specification

### Solvency Proof
```
Private inputs (never revealed):
  - monthly_income      (exact amount)
  - total_assets        (exact amount)
  - total_liabilities   (exact amount)

Public outputs:
  - income_ok    : monthly_income >= 3000 USDC          ✓ / ✗
  - solvency_ok  : total_assets / total_liabilities >= 1.5  ✓ / ✗

Public context inputs (anti-replay / domain separation):
  - protocol_id, nonce_hi, nonce_lo, expiry

Full public signal vector: [income_ok, solvency_ok, protocol_id, nonce_hi, nonce_lo, expiry]
Revealed: Nothing else. The figures stay private; only the boolean results leave the circuit.
```

### Repayment Proof
```
Private inputs (never revealed):
  - total_loans
  - on_time_repayments
  - default_events

Public outputs:
  - repayment_ok : on_time/total >= 80% AND default_events == 0  ✓ / ✗

Public context inputs:
  - protocol_id, nonce_hi, nonce_lo, expiry

Revealed: Nothing else.
```

---

## ZK Security Requirements

### Anti-Replay Protection
Every proof is **cryptographically bound** to its request context — not merely checked against
it. The circuit commits to these as public inputs, so a proof generated for one context can
never be verified under another:

```
Proof public inputs include:
  - protocol_id     (domain separation per lending contract — fixed "zkcredit_pool_v1")
  - nonce_hi/nonce_lo (the 32-byte per-request nonce, split into two field limbs)
  - expiry          (ledger after which the proof is rejected)
```

`lending_pool.borrow_with_proof` reconstructs this context from its own trusted arguments and
appends it to the proof's public inputs, so the proof only verifies when they match. The
`proof_verifier` contract additionally persists used nonces (`UsedNonce`) and rejects any
duplicate, and a fresh proof is generated per request (no canned, reusable artifact).

### Verifier Contract — Isolated Design
The `proof_verifier` contract handles **cryptographic validity only**. It does not contain business logic. This follows the verification gateway pattern:

```rust
// proof_verifier contract interface
pub fn verify_with_context(
    env: Env,
    proof: Proof,             // Groth16 proof (a, b, c) over BLS12-381
    public_inputs: Vec<u128>, // [flags…, protocol_id, nonce_hi, nonce_lo, expiry]
    nonce: BytesN<32>,        // persisted to reject replays
    expiry_ledger: u32,       // proof rejected once the ledger passes this
) -> bool
```

Business rules (rate tiers, eligibility) live exclusively in `risk_policy`; the score → rate
mapping in `rate_calculator`; and disbursement/state in `lending_pool`. The verifier does
cryptography only.

### Capability Check at Deployment

Before deploying to any network, verify:

```bash
# Check Stellar protocol version supports CAP-0059 (BLS12-381)
stellar network info --network testnet

# Simulate verifier contract before live submission
stellar contract invoke --simulate-only ...
```

> Never deploy without simulation. ZK verifier calls are resource-intensive — always check the cost envelope under realistic proof sizes.

The lending protocol autonomously pays the Risk Oracle for each credit evaluation:

```
Lending Protocol  →  [x402 HTTP 402 Request]  →  Risk Oracle
                  ←  [Trust Score Response]   ←
```

This makes **risk intelligence a purchasable, machine-payable service** — a natural use case for the x402 protocol.

---

## AI Risk Scoring

The Risk Agent computes a normalized trust score (0–100) from two kinds of input:

| Input | Source | Trust basis |
|-------|--------|-------------|
| `income_ok`, `solvency_ok`, `repayment_ok` | **ZK proof outputs** | Cryptographically verified on-chain |
| `wallet_age`, `activity`, `prior_loans_repaid` | **Public Horizon data** | Independently observable on-chain |

**The oracle never sees private financial data.** It does not learn `income = 7500` or
`assets = 12000` — only the boolean flags the ZK proof already verified (`income_ok = true`),
plus already-public on-chain behaviour. Its single job is to turn those into a score.

### Deterministic, reproducible scoring

The model is a transparent weighted sum — no opaque ML, no hidden state. Every point is
attributable to a named feature ([`agents/risk_agent/scoring.py`](agents/risk_agent/scoring.py)):

```
base                                      = 50
income_ok       (ZK)                      +12
solvency_ok     (ZK)                      +13
repayment_ok    (ZK)                      +15
wallet_age      (public)   up to          +10   # full credit at ≥ 1 year
activity        (public)   up to           +5   # full credit at ≥ 100 txns
prior_loans     (public)   up to          +10   # full credit at ≥ 5 repaid
default_events  (penalty)                 −20 each
fraud_signals   (penalty)                 −25 each
                                          ────
                          trust_score = clamp(Σ, 0, 100)
```

Given the **same inputs** (the ZK flags + a snapshot of the public Horizon signals), the score
is fully reproducible by anyone — the weights are fixed and open-source. A `borrow_with_proof`
loan event records the exact `trust_score` and the rate it produced, so any observer can
recompute and audit it.

---

## Trust Model

zkCredit is **not** "fully trustless" — and it doesn't need to be. It draws a precise line
between what is cryptographically guaranteed and what is delegated to a trusted oracle. Being
explicit about that boundary is the point.

| Layer | Guarantees | Trust assumption |
|-------|-----------|------------------|
| **ZK circuit** (Groth16/BLS12-381) | `income ≥ 3000` and `assets/liabilities ≥ 1.5` hold — **without revealing the figures** | None — verified on-chain by `proof_verifier` |
| **Context binding** | The proof is bound to `protocol_id + nonce + expiry`; it cannot be replayed, reused after expiry, or applied to another protocol | None — folded into the proof's public inputs |
| **Dual signature** | The borrower **cannot forge** their own `trust_score`: `borrow_with_proof` requires *both* the borrower's and the oracle's signature, and Soroban binds each signature to the exact call arguments (including `trust_score`) | None — enforced by `require_auth` |
| **Risk score** | Score is a deterministic, open-source function of ZK flags + public data | **The oracle is trusted to compute it correctly.** This is the one trusted component. |

### What the score's "core" already inherits from ZK

Because the ZK-derived flags carry fixed weights, a large part of every score is effectively
pinned by cryptography:

```
base 50 + income_ok 12 + solvency_ok 13  =  75   ← backed by the verified ZK proof
+ wallet_age / activity / prior_loans     ≤  25   ← oracle-attested (from public data)
```

So even the "trusted" surface is small: the oracle can only move a score within the
behavioural ±25 band, and only using **publicly observable** on-chain data that anyone can
re-derive. It can never fabricate the financial-threshold core, and it can never forge a loan
(the dual-signature requirement stops that).

> **One-line summary for reviewers:** *The ZK layer cryptographically proves the financial
> thresholds; the oracle computes a deterministic score from those flags plus public on-chain
> behaviour; and the borrower cannot forge the score because the oracle co-signs and Soroban
> binds the signature to the exact `trust_score`.*

---

## Interest Rate Tiers

| Trust Score | Interest Rate |
|-------------|---------------|
| No proof    | 14%           |
| 60–79       | 10%           |
| 80–89       | 8%            |
| 90–100      | 6%            |

---

## Portable Reputation

A user's trust score is not locked to a single protocol. ZK proofs are **portable** — the same proof can be verified by any participating lending protocol on Soroban, enabling a **private, cross-protocol financial identity layer**.

---

## MVP Scope (Hackathon)

### Must Have
- [ ] End-to-end borrowing flow
- [ ] ZK proof generation and verification
- [ ] Dynamic interest rate assignment
- [ ] x402 payment flow (protocol → oracle)
- [ ] AI risk scoring agent

### Nice to Have
- [ ] Reputation dashboard
- [ ] Reputation NFT (portable identity token)
- [ ] Analytics panel

### Out of Scope
- Token / DAO governance
- Mobile application
- Multi-chain support
- Decentralized oracle network
- Custom zkVM

---

## Why Stellar / Soroban?

- **Low fees** — viable for micro-payment risk intelligence via x402
- **Native asset operations** — clean multi-asset lending pool management
- **Soroban contract composability** — modular risk policy and proof verifier contracts
- **Fast finality** — near-instant loan execution after proof verification

---

## Getting Started

```bash
# Clone the repository
git clone https://github.com/your-org/zkcredit.git
cd zkcredit

# Install frontend dependencies
cd frontend && npm install

# Install Soroban CLI
cargo install --locked soroban-cli

# Install ZK tooling (snarkjs + circom)
npm install -g snarkjs
npm install -g circom

# Compile ZK circuits (Groth16 / BLS12-381)
cd circuits/solvency_proof
circom solvency.circom --r1cs --wasm --sym
snarkjs groth16 setup solvency.r1cs pot12_final.ptau solvency_0000.zkey

# Run local development
cd ../../frontend && npm run dev

# Deploy contracts to Stellar Testnet
cd ../contracts
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/proof_verifier.wasm --network testnet
```

---

## Tech Stack

| Layer | Technology | Status |
|-------|------------|--------|
| Smart Contracts | Soroban (Rust) | ✅ Production |
| ZK Proving System | Groth16 + snarkjs + circom | ✅ Production |
| ZK Curve (on-chain) | BLS12-381 — CAP-0059 | ✅ Implemented on Stellar |
| ZK Curve (future) | BN254 + Poseidon — CAP-0074/0075 | ⚠️ Proposal — not yet available |
| Frontend | Next.js + Tailwind | ✅ Production |
| AI Risk Agent | Python | ✅ Production |
| Payments | x402 Protocol | ✅ Production |
| Network | Stellar Testnet → Mainnet | ✅ Production |

---

## Pitch

> **"zkCredit enables privacy-preserving creditworthiness for DeFi using ZK proofs, AI underwriting, and machine-payable risk intelligence."**

---

## ZK References

| Resource | Link |
|----------|------|
| CAP-0059 (BLS12-381) — Implemented | [stellar-protocol/cap-0059](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md) |
| CAP-0074 (BN254) — Proposal | [stellar-protocol/cap-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md) |
| CAP-0075 (Poseidon) — Proposal | [stellar-protocol/cap-0075](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md) |
| Soroban Groth16 Verifier Example | [soroban-examples/groth16_verifier](https://github.com/stellar/soroban-examples/tree/main/groth16_verifier) |
| Stellar Protocol Versions | [developers.stellar.org](https://developers.stellar.org/docs/networks/software-versions) |

---



MIT
