import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ACRStatus = "NotStarted" | "Draft" | "Submitted";
export type ACRRecommendation = "Recommend" | "RecommendWithCaution" | "DoNotRecommend";

export interface AgentConfidentialReport {
  status: ACRStatus;
  agent_id: string | null;
  submitted_at: string | null;

  known_proposer_since: string | null;
  relationship_to_proposer: string | null;
  purpose_of_insurance: string | null;
  financial_interest_explained: boolean | null;
  adverse_info_known: boolean | null;
  adverse_info_details: string | null;

  occupation_verified: boolean | null;
  income_source_verified: boolean | null;
  estimated_income_opinion: number | null;
  income_consistency_note: string | null;

  health_appearance_note: string | null;
  habits_observed: Record<string, any> | null;
  hazardous_activity_known: boolean | null;

  terms_explained_to_proposer: boolean | null;
  identity_verified_kyc: boolean | null;
  signature_obtained_in_presence: boolean | null;

  recommendation: ACRRecommendation | null;
  remarks: string | null;
}

export type ACRUpsert = Partial<
  Omit<AgentConfidentialReport, "status" | "agent_id" | "submitted_at">
>;

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

export async function getACR(caseId: string): Promise<AgentConfidentialReport> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/cases/${caseId}/acr`);
  return res.data;
}

export async function saveACR(caseId: string, body: ACRUpsert): Promise<AgentConfidentialReport> {
  const tid = tenantId();
  const res = await api.put(`/tenants/${tid}/cases/${caseId}/acr`, body);
  return res.data;
}

export async function submitACR(caseId: string): Promise<AgentConfidentialReport> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/acr/submit`);
  return res.data;
}
