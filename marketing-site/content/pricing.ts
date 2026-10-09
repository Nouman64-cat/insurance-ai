// Single source for the published prices, so the pricing page copy and the calculator
// can never disagree. AI cost per case and the scenario volumes come from the budgeting
// model (LLM Budget tab): annual case counts / 12.

export const RETAINER_MONTHLY = 11_500;
export const HYBRID_BASE_MONTHLY = 9_050;

export type CaseType = "individual" | "family" | "corporate";

export const CASE_TYPES: { key: CaseType; label: string; unit: string; aiCost: number; max: number; step: number }[] = [
  { key: "individual", label: "Individual cases", unit: "case", aiCost: 0.3, max: 20_000, step: 50 },
  { key: "family", label: "Family cases", unit: "case", aiCost: 0.6, max: 6_000, step: 25 },
  { key: "corporate", label: "Corporate schemes", unit: "scheme", aiCost: 1.0, max: 300, step: 1 },
];

export type CaseMix = Record<CaseType, number>;

export const SCENARIOS: { key: string; label: string; mix: CaseMix }[] = [
  { key: "low", label: "Lighter year", mix: { individual: 4_583, family: 833, corporate: 25 } },
  { key: "base", label: "Expected", mix: { individual: 5_000, family: 1_250, corporate: 33 } },
  { key: "high", label: "Busier year", mix: { individual: 5_542, family: 2_375, corporate: 58 } },
];

export const aiUsage = (mix: CaseMix) => CASE_TYPES.reduce((sum, t) => sum + mix[t.key] * t.aiCost, 0);
export const hybridMonthly = (mix: CaseMix) => HYBRID_BASE_MONTHLY + aiUsage(mix);

export const usd = (n: number, cents = false) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
