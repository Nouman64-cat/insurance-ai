import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Pre-Underwriting gate 5 — Insurance History (anti-selection / over-insurance)
// ─────────────────────────────────────────────────────────────────────────────

export type InsuranceHistoryStatus = "NotStarted" | "Clear" | "Flagged" | "Failed";

export interface HistoryPolicyRow {
  source: "internal" | "external_declared";
  policy_id?: string;
  policy_number?: string | null;
  insurer: string;
  product?: string | null;
  sum_assured: number;
  term_years?: number | null;
  status: string;
  bucket: "InForce" | "Pipeline" | "Declined" | "Terminated" | "Other";
  effective_date?: string | null;
  created_at?: string | null;
}

export interface HistoryFinding {
  severity: "critical" | "warning" | "info";
  code: string;
  message: string;
  points: number;
}

export interface InsuranceHistory {
  id?: string;
  status: InsuranceHistoryStatus;
  score: number | null;
  checked_at: string | null;
  proposed_sum_assured: number;
  internal_inforce_sum_assured: number;
  external_declared_sum_assured: number;
  aggregate_sum_assured: number;
  hlv_limit: number | null;
  hlv_ratio: number | null;
  hlv_multiple?: number;
  has_prior_decline: boolean;
  has_prior_lapse: boolean;
  replacement_suspected: boolean;
  non_disclosure_suspected: boolean;
  internal_policies: HistoryPolicyRow[];
  external_policies: HistoryPolicyRow[];
  findings: HistoryFinding[];
  cleared_by: string | null;
  cleared_at: string | null;
  clearance_note: string | null;
  e_application_available?: boolean;
}

export async function getInsuranceHistory(caseId: string): Promise<InsuranceHistory> {
  const res = await api.get(`/tenants/${tenantId()}/cases/${caseId}/insurance-history`);
  return res.data;
}

export async function runInsuranceHistory(caseId: string): Promise<InsuranceHistory> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/insurance-history/run`);
  return res.data;
}

export async function clearInsuranceHistory(caseId: string, note?: string): Promise<InsuranceHistory> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/insurance-history/clear`, { note });
  return res.data;
}

export async function failInsuranceHistory(caseId: string, note?: string): Promise<InsuranceHistory> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/insurance-history/fail`, { note });
  return res.data;
}
