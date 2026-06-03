// Shared in-memory store for confirmed loan repayments.
// Imported by both server.mjs (writes) and financial_records.mjs (reads).
// Resets on process restart — production would persist to a database.
export const creditHistory = new Map(); // walletAddress → repaid_count
