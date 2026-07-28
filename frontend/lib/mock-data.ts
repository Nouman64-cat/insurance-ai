// ─────────────────────────────────────────────────────────────────────────────
// Shared presentation helpers + the AIDecision union.
//
// This module used to hold hard-coded demo cases (QUEUE_CASES / CASE_DETAILS /
// METRICS / DECISION_DISTRIBUTION). Those were removed once every screen moved to
// real API data seeded by services/tenant-service/seeds/stage_a_seed.py — only the
// pure formatters and the AIDecision type remain, still imported across the app.
// ─────────────────────────────────────────────────────────────────────────────

export type AIDecision =
  | "Auto Approve"
  | "Approve with Loading"
  | "Human Review"
  | "Decline";

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

export function fmtCoverage(n: number): string {
  if (n >= 10_000_000) return `PKR ${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000_000)  return `PKR ${(n / 1_000_000).toFixed(1)}M`;
  return `PKR ${(n / 1_000).toFixed(0)}K`;
}

export function fmtIncome(n: number): string {
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(0)}M / year`;
  return `PKR ${(n / 1_000).toFixed(0)}K / year`;
}

export function fmtDob(dob: string): string {
  return new Date(dob).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
