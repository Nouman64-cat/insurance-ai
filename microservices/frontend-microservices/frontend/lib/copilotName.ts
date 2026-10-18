/**
 * The Copilot's name for the signed-in role — a label only. What the Copilot may do for a role is decided by
 * chat-agent from the user's verified role, never from this.
 */
const NAMES: Record<string, { name: string; tagline: string }> = {
  Finance: { name: "Finance Copilot", tagline: "Your payments and reconciliation assistant" },
  ClaimsManager: { name: "Claims Copilot", tagline: "Your claims assistant" },
  ClaimsAdjuster: { name: "Claims Copilot", tagline: "Your claims assistant" },
  MedicalUnderwriter: { name: "Medical Underwriting Copilot", tagline: "Your medical review assistant" },
  FinancialUnderwriter: { name: "Financial Underwriting Copilot", tagline: "Your financial review assistant" },
  Underwriter: { name: "Underwriting Copilot", tagline: "Your underwriting assistant" },
};
const DEFAULT = { name: "GetInsuredAI Copilot", tagline: "Your insurance assistant" };

/** "Medical Underwriter" and "MedicalUnderwriter" are the same role. */
export function copilotIdentity(role: string | null | undefined): { name: string; tagline: string } {
  return NAMES[(role ?? "").replace(/\s+/g, "")] ?? DEFAULT;
}

/** The current user's Copilot identity, from the role stored at sign-in (client only). */
export function currentCopilotIdentity(): { name: string; tagline: string } {
  if (typeof window === "undefined") return DEFAULT;
  try { return copilotIdentity(localStorage.getItem("user_role")); } catch { return DEFAULT; }
}
