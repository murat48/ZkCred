# ZkCred — Privacy-Preserving Credit Intelligence Layer for DeFi

> **Zero-Knowledge creditworthiness proofs on Stellar Testnet.**  
> Borrowers prove financial reputation without revealing any sensitive data on-chain. Lenders receive verifiable trust scores and offer personalized interest rates. Oracle access is gated by x402 machine-to-machine USDC micropayments.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Live Deployments (Testnet)](#live-deployments-testnet)
- [Zero-Knowledge Circuits](#zero-knowledge-circuits)
- [Smart Contracts](#smart-contracts)
- [Agents](#agents)
  - [Risk Oracle Provider](#1-risk-oracle-provider--port-3001)
  - [Mock Bank Data Provider](#2-mock-bank-data-provider--port-3002)
  - [AI Risk Scoring Agent](#3-ai-risk-scoring-agent--port-8000)
- [x402 Machine Payments](#x402-machine-payments)
- [Frontend](#frontend)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Privacy Guarantees](#privacy-guarantees)
- [Tech Stack](#tech-stack)

---

## Overview

Traditional DeFi lending requires 150–300% overcollateralization, charges flat rates regardless of reputation, and has no mechanism to prove financial identity confidentially.

**ZkCred** solves this with a four-layer system:

1. **ZK Layer** — Circom circuits (Groth16 / BLS12-381) prove financial thresholds without revealing raw values.
2. **Oracle Layer** — A Node.js oracle attests to wallet creditworthiness, receives x402 USDC payments per request, generates and verifies ZK proofs.
3. **Contract Layer** — Four Soroban contracts handle on-chain proof verification, tier-based rate lookup, interest calculation, and full loan lifecycle.
4. **Application Layer** — A Next.js frontend connects Freighter wallet, generates proofs client-side, and manages the entire borrow/repay flow.

**Key properties:**

- Raw financial figures (income, debt, assets) **never appear on-chain** — only the tier and interest rate.
- Anti-replay protection: every proof is bound to a unique nonce + expiry ledger + borrower address, burned on use.
- Domain separation: `PROTOCOL_ID` is constrained inside each circuit, preventing cross-protocol proof reuse.
- Oracle API is metered at **$0.05 USDC per call** via the x402 HTTP 402 payment protocol.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│  • Freighter wallet — signs XDR transactions only                    │
│  • Displays results; no direct oracle or RPC contact                 │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTP  /api/*
┌──────────────────────────▼───────────────────────────────────────────┐
│  Next.js Server-Side API Routes (:3000/api)                          │
│  • /api/wallet-signals  → Horizon REST (balances, tx history)        │
│  • /api/quote           → Oracle /evaluate  (+x402 $0.05 if live)   │
│  • /api/borrow          → Oracle /borrow                             │
│  • /api/borrow/prepare  → Oracle /borrow/prepare                     │
│  • /api/borrow/submit   → Oracle /borrow/submit                      │
│  • /api/loan/status     → Oracle /loan/status                        │
│  @x402/fetch + STELLAR_SECRET_KEY run here (server-side only)        │
└──────────┬───────────────────────────┬───────────────────────────────┘
           │ HTTP                      │ HTTPS
           │                  ┌────────▼───────────────────────────────┐
           │                  │  Horizon REST API                      │
           │                  │  horizon-testnet.stellar.org           │
           │                  │  (wallet signals, balances, tx count)  │
           │                  └────────────────────────────────────────┘
┌──────────▼──────────────────────────────────────────────────────┐
│  Risk Oracle Provider (:3001)                                   │
│  • x402 payment gate (mock | live via OZ Channels facilitator) │
│  • Attestation: fetches & verifies Ed25519-signed bank data     │
│  • snarkjs: generates fresh Groth16 proofs per borrow request   │
│  • snarkjs: verifies proofs (BLS12-381)                         │
│  • Co-signs Soroban borrow transactions as oracle               │
│  • After confirmed borrow: notifies bank (async, fire-forget)   │
└───┬────────────┬──────────────────────────┬─────────────────────┘
    │ HTTP GET   │ HTTP POST (async notify)  │ Stellar RPC (HTTPS)
    │ /financial-│ /internal/credit-event    │ soroban-testnet.stellar.org
    │ data       │                           │
┌───▼────────────▼───┐              ┌────────▼──────────────────────────┐
│ Mock Bank (:3002)  │              │  Stellar Testnet (Soroban)        │
│ • Ed25519 signed   │              │                                   │
│   financial data   │              │  proof_verifier  Groth16/BLS381   │
│ • Demo profiles    │              │  risk_policy     tier → rate bps  │
│   (PRIME/GREEN/    │              │  rate_calculator simple interest   │
│    YELLOW/REJECT)  │              │  lending_pool    full lifecycle    │
└────────────────────┘              └───────────────────────────────────┘
    │ HTTP POST /score
┌───▼───────────────────┐
│  Risk Agent (:8000)   │
│  Python / FastAPI     │
│  AI trust scoring     │
│  (ZK booleans only,   │
│   never raw amounts)  │
└───────────────────────┘
```

---

## Live Deployments (Testnet)

| Contract            | Address                                                    |
| ------------------- | ---------------------------------------------------------- |
| **lending_pool**    | `CAUBK4VA6X3H2Y5I53736RPBREQYC42QIF4QPFZETS6ZHKXYOBCSUKMU` |
| **proof_verifier**  | `CCGZ4HGNOZ4WKXSTGG6KS6XUAGQ3DEIHZRYWSJBWXVAN4TZG2MWQGNZC` |
| **risk_policy**     | `CBSQ4WCUJXT3QT3U7MVTMOY3IAWQYGNCFQSLQKDR6Q4LCRAUVWR36FGL` |
| **rate_calculator** | `CDFPXWVLZPTQ4EIOWQHG6DOA5VG3O32OHLFRQYUWIYBMP4FS7YTH77KB` |
| **USDC SAC**        | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| **Admin**           | `GDARDKFBSPKPSL66BR2HJFXBHQJ3XO4WZRN64AC4QTDCAPBM3IMGHPF5` |

Explorer: [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet)

---

## Zero-Knowledge Circuits

All circuits are written in **Circom 2.1.6**, compiled to Groth16 proofs over **BLS12-381** (CAP-0059 Stellar host function). Proof size is ~288 bytes; on-chain verification takes < 1 ms.

### 1. `creditworthiness_proof` — Core underwriting circuit

The primary circuit used for borrowing. Proves 6 financial criteria simultaneously.

**Private inputs** (never leave the browser):

| Input                | Meaning                                    |
| -------------------- | ------------------------------------------ |
| `monthly_income`     | Gross monthly income (USD)                 |
| `repaid_loans_count` | Number of previously repaid loans          |
| `default_count`      | Number of past defaults                    |
| `monthly_debt`       | Total monthly debt obligations (USD)       |
| `employment_months`  | Months of continuous employment            |
| `bills_ok`           | 1 = regular utility/bill payments detected |

**Public outputs** (recorded on Stellar):

| Output     | Meaning                                           |
| ---------- | ------------------------------------------------- |
| `tier`     | 1 = YELLOW, 2 = GREEN, 3 = PRIME                  |
| `max_loan` | Credit limit (stroops), cryptographically derived |

**6 Criteria logic:**

| Criterion       | Threshold              | Required for     |
| --------------- | ---------------------- | ---------------- |
| `income_ok`     | income ≥ $2,000 / mo   | All tiers (hard) |
| `default_ok`    | default_count = 0      | All tiers (hard) |
| `dti_ok`        | debt/income < 30%      | GREEN / PRIME    |
| `loans_ok`      | repaid_loans ≥ 3       | GREEN / PRIME    |
| `employment_ok` | employment ≥ 12 months | PRIME            |
| `bills_ok`      | = 1                    | PRIME            |

**Tier outcomes:**

| Tier           | Requirements                      | Rate   |
| -------------- | --------------------------------- | ------ |
| **PRIME (3)**  | All 6 criteria                    | ~5%    |
| **GREEN (2)**  | 5 criteria + `loans_ok`           | ~10%   |
| **YELLOW (1)** | 2–4 criteria                      | ~20%   |
| **REJECT (0)** | `income_ok` OR `default_ok` fails | Denied |

Credit limit formula (circuit-enforced, cannot be spoofed):

```
max_loan = monthly_income × tier_ratio × 2000  (in stroops)
```

**Anti-replay binding** — these are also public circuit inputs:

```
protocol_id, nonce_hi, nonce_lo, expiry_ledger, borrower_hi, borrower_lo
```

---

### 2. `solvency_proof` — Asset/liability assessment

Proves solvency without revealing the actual amounts.

| Private Input       | Threshold |
| ------------------- | --------- |
| `monthly_income`    | ≥ $3,000  |
| `total_assets`      | —         |
| `total_liabilities` | —         |

**Public outputs:** `income_ok`, `solvency_ok`  
Solvency check: `2 × assets ≥ 3 × liabilities` (ratio ≥ 1.5, avoids floating point)

---

### 3. `repayment_proof` — Repayment history

| Private Input        | Threshold      |
| -------------------- | -------------- |
| `total_loans`        | —              |
| `on_time_repayments` | ≥ 80% of total |
| `default_events`     | = 0            |

**Public output:** `repayment_ok` (1 iff both conditions hold)

---

### 4. `tier_proof` — AI score → tier mapping

Maps an AI trust score (0–100) to a tier integer.

| Score  | Tier       |
| ------ | ---------- |
| 80–100 | 3 (PRIME)  |
| 60–79  | 2 (GREEN)  |
| 40–59  | 1 (YELLOW) |
| 0–39   | 0 (REJECT) |

---

## Smart Contracts

All contracts are written in **Rust** with the Soroban SDK v25 and deployed to Stellar Testnet.

### `proof_verifier`

Pure cryptographic verification over BLS12-381 (Stellar CAP-0059 host function).

| Function                                                          | Description                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `verify_proof(proof, public_inputs)`                              | Stateless Groth16 check                                              |
| `verify_with_context(proof, public_inputs, nonce, expiry_ledger)` | Anti-replay gate: burns nonce, checks expiry, emits `proof_ok` event |
| `set_vk(vk)`                                                      | Rotate verifying key (admin only)                                    |

Nonces are stored with a 30-day TTL (`NONCE_TTL = 518,400 ledgers`).

---

### `risk_policy`

Stateful tier-to-rate mapping (basis points). No cryptography — pure business logic.

| Function                | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `set_tiers(tiers)`      | Replace rate schedule (admin only)              |
| `get_tiers()`           | Retrieve current schedule                       |
| `rate_bps(trust_score)` | Score → rate in bps                             |
| `anonymous_rate_bps()`  | Rate for borrowers without a proof (worst tier) |

Default schedule (mirrors circuit thresholds):

| Tier      | Score | Rate           |
| --------- | ----- | -------------- |
| PRIME     | 80+   | 500 bps (5%)   |
| GREEN     | 60–79 | 1000 bps (10%) |
| YELLOW    | 40–59 | 2000 bps (20%) |
| Anonymous | —     | 3000 bps (30%) |

---

### `rate_calculator`

Stateless, pure-function interest math (simple, non-compounding).

```
interest   = principal × rate_bps × term_days / (10,000 × 365)
total_due  = principal + interest
```

Example: 1,000 USDC at 1,000 bps (10%) for 365 days → interest = 100 USDC, total due = 1,100 USDC.

---

### `lending_pool`

Orchestration layer: ZK-gated loan lifecycle, LP liquidity management, repayment tracking.

**Liquidity:**

| Function                | Description                          |
| ----------------------- | ------------------------------------ |
| `deposit(from, amount)` | LP deposits USDC into the pool       |
| `withdraw(to, amount)`  | LP withdraws available (unlent) USDC |

**Borrowing:**

| Function                                                                                                  | Description                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `borrow_with_proof(borrower, amount, term_days, proof, public_inputs, trust_score, nonce, expiry_ledger)` | Full ZK-verified borrow — verifies proof on-chain, reads `max_loan` from circuit outputs, applies personalized rate |
| `borrow_anonymous(borrower, amount, term_days)`                                                           | Skips proof, worst-tier rate (30%)                                                                                  |

`borrow_with_proof` execution sequence:

1. Verify borrower + oracle authorization
2. Read `max_loan` from `public_inputs[1]` (circuit-enforced credit limit)
3. Append trusted context (protocol_id, nonce, expiry, borrower SHA-256 hash)
4. Call `proof_verifier.verify_with_context()` → burn nonce
5. Call `risk_policy.rate_bps(trust_score)` → get rate tier
6. Call `rate_calculator.total_due(...)` → compute repayment
7. Transfer USDC from pool to borrower
8. Record `Loan` state, emit `loan_new` event

**Repayment:**

| Function                    | Description               |
| --------------------------- | ------------------------- |
| `repay(borrower, amount)`   | Partial or full repayment |
| `repay_and_close(borrower)` | Settle loan completely    |

**Queries:**

| Function                | Description                |
| ----------------------- | -------------------------- |
| `active_loan(borrower)` | Returns current loan state |
| `lp_balance(address)`   | LP's deposited balance     |

---

## Agents

### 1. Risk Oracle Provider — port 3001

Node.js server. Acts as both the x402-gated API and the co-signer for on-chain borrow transactions.

**REST API:**

| Endpoint                      | Method | Auth       | Description                                        |
| ----------------------------- | ------ | ---------- | -------------------------------------------------- |
| `/health`                     | GET    | —          | Liveness check                                     |
| `/evaluate`                   | POST   | x402 $0.05 | Legacy proof verification + AI trust score         |
| `/attest`                     | POST   | x402 $0.05 | Creditworthiness attestation for a wallet address  |
| `/demo/fund`                  | POST   | —          | Send 2 testnet USDC to borrower from oracle wallet |
| `/borrow`                     | POST   | —          | Demo borrow (oracle holds borrower key)            |
| `/borrow/prepare`             | POST   | —          | Build XDR for real-wallet signing (Freighter)      |
| `/borrow/submit`              | POST   | —          | Submit user-signed borrow XDR                      |
| `/borrow/prepare/installment` | POST   | —          | Build installment slot XDR for user signing        |
| `/loan/status`                | GET    | —          | Query active loan by `?account=...`                |
| `/loan/repay/prepare`         | POST   | —          | Build repay XDR for user signing                   |
| `/loan/repay/submit`          | POST   | —          | Submit user-signed repay XDR                       |

**x402 modes:**

| Mode             | Behavior                                                        |
| ---------------- | --------------------------------------------------------------- |
| `X402_MODE=mock` | No payment required — plain HTTP (dev/demo)                     |
| `X402_MODE=live` | Full x402 flow via OZ Channels facilitator, $0.05 USDC per call |

---

### 2. Mock Bank Data Provider — port 3002

Simulates a bank API that signs financial records with Ed25519. The oracle verifies the signature before using any data.

**REST API:**

| Endpoint          | Method | Description                                                                    |
| ----------------- | ------ | ------------------------------------------------------------------------------ |
| `/health`         | GET    | Liveness check                                                                 |
| `/pubkey`         | GET    | Ed25519 public key                                                             |
| `/financial-data` | POST   | `{wallet}` → signed attestation `{wallet, data, issued_at, issuer, signature}` |

**Demo profiles (hardcoded for reliability):**

| Profile | Income | Repaid | Defaults | Debt | Employment | Bills | Tier   |
| ------- | ------ | ------ | -------- | ---- | ---------- | ----- | ------ |
| PRIME   | $6,500 | 8      | 0        | $900 | 36 mo      | ✓     | PRIME  |
| GREEN   | $3,200 | 5      | 0        | $700 | 18 mo      | ✗     | GREEN  |
| YELLOW  | $2,200 | 3      | 0        | $550 | 6 mo       | ✗     | YELLOW |
| REJECT  | $3,200 | 5      | 1        | $700 | 18 mo      | ✗     | REJECT |

For non-demo wallets, data is derived from Horizon: account age, USDC balance, Soroban call count, lending pool default history.

---

### 3. AI Risk Scoring Agent — port 8000

Python / FastAPI service. Receives only boolean thresholds from ZK proofs — never raw financial figures.

**POST `/score` — Request:**

```json
{
  "income_ok": true,
  "solvency_ok": true,
  "repayment_ok": true,
  "wallet_age_days": 365,
  "tx_count": 120,
  "prior_loans_repaid": 5,
  "default_events": 0,
  "fraud_signals": 0
}
```

**Scoring model:**

| Signal              | Source      | Max Points      |
| ------------------- | ----------- | --------------- |
| Base score          | —           | 50              |
| `income_ok`         | ZK-verified | +12             |
| `solvency_ok`       | ZK-verified | +13             |
| `repayment_ok`      | ZK-verified | +15             |
| Wallet age          | On-chain    | +10             |
| Activity (tx count) | On-chain    | +5              |
| Repayment history   | On-chain    | +10             |
| Defaults            | On-chain    | −20 per default |
| Fraud signals       | On-chain    | −25 per signal  |

Final score is clamped 0–100. Without a ZK proof, score = 0.

---

## x402 Machine Payments

The oracle's `/evaluate` and `/attest` endpoints are gated by the [x402 HTTP 402 Payment Required](https://x402.org) protocol, enabling autonomous machine-to-machine USDC payments.

**Payment flow (live mode):**

```
Frontend (buyer)
  │
  ├─ POST /attest
  │    ← 402 Payment Required  {amount: "$0.05", network: "stellar:testnet"}
  │
  ├─ @x402/fetch signs Soroban auth entries with Ed25519 key
  │
  ├─ Sends payment to OZ Channels facilitator (Cloudflare)
  │    facilitator settles ~$0.05 USDC on Stellar
  │
  └─ POST /attest  (now authorized)
       → 200 {tier, rate_bps, claims, ...}
```

**Configuration:**

```env
X402_MODE=live
STELLAR_SECRET_KEY=S...          # buyer signing key
STELLAR_RECIPIENT=G...           # oracle USDC destination
OZ_API_KEY=...                   # optional Cloudflare auth
ORACLE_PRICE=0.05                # price per request (USD)
```

Set `X402_MODE=mock` to run without any payment (default for local development).

---

## Frontend

**Stack:** Next.js 14, React, TypeScript, Tailwind CSS, Freighter Wallet

**Key components:**

| Component       | Description                                                                         |
| --------------- | ----------------------------------------------------------------------------------- |
| `BorrowPanel`   | Main UI — wallet connect, attest creditworthiness, generate ZK proof, borrow, repay |
| `WalletConnect` | Freighter integration — address display, USDC trustline check                       |
| `FlowSteps`     | Visual step-by-step guide                                                           |
| `TechLinks`     | Links to live contracts, CAP-0059, x402 protocol                                    |

**Borrow flow in the UI:**

1. **Connect** — Freighter wallet (Stellar Testnet required)
2. **Check creditworthiness** — Frontend requests `/attest`, x402 payment handled automatically, oracle returns signed claims
3. **Generate ZK proof** — snarkjs runs locally with private financial data; raw values never sent over the network
4. **Borrow** — Oracle co-signs Soroban XDR; user signs in Freighter; transaction submitted to `lending_pool`
5. **Active loan** — Repayment due timer, outstanding balance, one-click repay

**Loan types:**

| Type                | Term        | Description                                             |
| ------------------- | ----------- | ------------------------------------------------------- |
| Daily               | 1–27 days   | Custom duration, slider selection                       |
| Monthly             | 30 days     | Standard monthly loan                                   |
| 3-Month Installment | 3 × 30 days | Three sequential ZK proofs + on-chain installment slots |

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- Python ≥ 3.10
- Rust + Cargo + `wasm32-unknown-unknown` target (for contract compilation)
- [Circom](https://docs.circom.io/getting-started/installation/) (for circuit rebuilds)
- [Freighter](https://freighter.app) browser extension set to Testnet

### 1. Install dependencies

```bash
# Frontend
cd frontend && npm install

# Oracle + Bank agents
cd agents/oracle_provider && npm install
cd agents/bank_agent && npm install

# Risk agent
cd agents/risk_agent && pip install -r requirements.txt

# Circuits (only needed if rebuilding)
cd circuits && npm install
```

### 2. Configure environment

Copy and fill in the required values:

```bash
cp .env.example .env   # if available, or create .env manually
```

Minimum for mock mode (no payments):

```env
X402_MODE=mock
STELLAR_SECRET_KEY=S...          # oracle signing key (testnet)
LENDING_POOL=CAUBK...            # from deployments.testnet.env
PROOF_VERIFIER=CCGZ...
RISK_POLICY=CBSQ...
RATE_CALCULATOR=CDFP...
USDC_SAC=CBIE...
```

### 3. Start all services

```bash
bash scripts/dev.sh
```

This launches all four services concurrently:

| Service             | Port  | Command             |
| ------------------- | ----- | ------------------- |
| Risk Agent (Python) | :8000 | `python3 server.py` |
| Mock Bank           | :3002 | `node server.mjs`   |
| Risk Oracle         | :3001 | `node server.mjs`   |
| Frontend            | :3000 | `next dev`          |

Open [http://localhost:3000](http://localhost:3000).

### 4. Live x402 mode (optional)

To enable real USDC payments on Stellar Testnet:

```env
X402_MODE=live
STELLAR_SECRET_KEY=S...          # funded testnet account
STELLAR_RECIPIENT=G...           # oracle's USDC recipient address
```

Fund the buyer account with testnet USDC at [laboratory.stellar.org](https://laboratory.stellar.org) or the [Stellar friendbot](https://friendbot.stellar.org).

### 5. Rebuild ZK circuits (optional)

```bash
cd circuits && bash build.sh
```

This compiles Circom → R1CS → Groth16 proving/verifying keys and exports the verifying key for Soroban.

---

## Environment Variables

| Variable             | Required   | Description                                       |
| -------------------- | ---------- | ------------------------------------------------- |
| `X402_MODE`          | Yes        | `mock` or `live`                                  |
| `STELLAR_SECRET_KEY` | Yes (live) | Oracle co-signer key                              |
| `STELLAR_RECIPIENT`  | Yes (live) | USDC payment destination                          |
| `OZ_API_KEY`         | No         | OZ Channels Cloudflare API key                    |
| `ORACLE_PRICE`       | No         | Price per API call (default: `0.05`)              |
| `STELLAR_NETWORK`    | No         | `testnet` or `mainnet` (default: `testnet`)       |
| `LENDING_POOL`       | Yes        | lending_pool contract address                     |
| `PROOF_VERIFIER`     | Yes        | proof_verifier contract address                   |
| `RISK_POLICY`        | Yes        | risk_policy contract address                      |
| `RATE_CALCULATOR`    | Yes        | rate_calculator contract address                  |
| `USDC_SAC`           | Yes        | USDC Stellar Asset Contract address               |
| `BANK_URL`           | No         | Mock bank URL (default: `http://localhost:3002`)  |
| `RISK_AGENT_URL`     | No         | Risk agent URL (default: `http://localhost:8000`) |

---

## Privacy Guarantees

```
┌─────────────────────────────────┐
│  Your Device (private)          │
│  monthly_income: $4,200         │
│  monthly_debt:   $800           │  ──► never leaves device
│  repaid_loans:   6              │
│  default_count:  0              │
└────────────────┬────────────────┘
                 │ ZK witness only
┌────────────────▼────────────────┐
│  ZK Circuit (Groth16)           │
│  BLS12-381 elliptic curve       │  ──► ~288-byte proof
│  6 threshold checks             │
└────────────────┬────────────────┘
                 │ proof + public signals only
┌────────────────▼────────────────┐
│  Stellar Testnet (public)       │
│  tier: PRIME                    │  ──► only outcome is public
│  rate: 5%                       │
│  proof: ✓ verified              │
└─────────────────────────────────┘
```

- **Raw financial figures are never transmitted** to any server, never stored, and never appear on-chain.
- The oracle receives **only signed boolean thresholds** from the bank — not the original amounts.
- The AI risk scorer sees **only boolean outputs** from the ZK proofs.
- On-chain, only `tier`, `rate_bps`, and a Groth16 proof commitment are recorded.

---

## Tech Stack

| Layer            | Technology                                      |
| ---------------- | ----------------------------------------------- |
| Smart contracts  | Rust, Soroban SDK v25, `wasm32-unknown-unknown` |
| ZK circuits      | Circom 2.1.6, snarkjs, Groth16                  |
| ZK curve         | BLS12-381 (Stellar CAP-0059 host function)      |
| Blockchain       | Stellar Testnet, Stellar RPC, Soroban           |
| Stablecoin       | USDC (Stellar Asset Contract / SEP-41)          |
| Machine payments | x402 HTTP 402, OZ Channels facilitator          |
| Oracle / bank    | Node.js, Express, Ed25519 (noble-curves)        |
| Risk scoring     | Python, FastAPI, scikit-learn inspired scoring  |
| Frontend         | Next.js 14, React, TypeScript, Tailwind CSS     |
| Wallet           | Freighter, Stellar Wallets Kit                  |
| Proof client     | snarkjs (browser), @x402/fetch, @x402/stellar   |

---

## License

MIT
