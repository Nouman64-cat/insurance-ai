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
  /** When the agent was last asked to file it (null if never asked). */
  requested_at?: string | null;
  /** Set when an underwriter bypassed Gate 2 without a submitted report. */
  waived_by?: string | null;
  waived_at?: string | null;
  waiver_reason?: string | null;

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
  Omit<
    AgentConfidentialReport,
    "status" | "agent_id" | "submitted_at" | "waived_by" | "waived_at" | "waiver_reason"
  >
>;

/** Gate 2 is cleared by a submitted report, or by an underwriter's waiver. */
export const isACRCleared = (acr?: Pick<AgentConfidentialReport, "status" | "waived_at"> | null): boolean =>
  acr?.status === "Submitted" || !!acr?.waived_at;

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

export interface ACRRequestResult {
  case_id: string;
  status: ACRStatus;
  requested_at: string | null;
  recipient: { user_id: string; name: string; source_name?: string | null } | null;
  already_requested: boolean;
  /** The signed-in user is the one who would file it — they are not asked, they file it from the app. */
  self_request: boolean;
}

/** Ask the case's agent (or its acquisition source's login) to file the ACR from the agent app. Idempotent. */
export async function requestACR(caseId: string): Promise<ACRRequestResult> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/acr/request`);
  return res.data;
}

/** Underwriter / Admin: bypass Gate 2 when the agent's report never arrives. A reason is required. */
export async function waiveACR(caseId: string, reason: string): Promise<AgentConfidentialReport> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/acr/waive`, { reason });
  return res.data;
}

/** Undo a waiver, so Gate 2 needs the submitted report again. */
export async function reinstateACR(caseId: string): Promise<AgentConfidentialReport> {
  const tid = tenantId();
  const res = await api.delete(`/tenants/${tid}/cases/${caseId}/acr/waive`);
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests addressed to the signed-in user (agent / broker / bank desk login)
// ─────────────────────────────────────────────────────────────────────────────

export interface ACRRequest {
  case_id: string;
  case_number: string | null;
  applicant_name: string | null;
  segment: "individual" | "family" | "organization";
  group_name: string | null;
  status: "Requested" | "Draft" | "Submitted";
  requested_at: string | null;
  requested_by_name: string | null;
  submitted_at: string | null;
}

/** ACRs the signed-in user has been asked to file and hasn't submitted yet, newest first. */
export async function listMyACRRequests(): Promise<ACRRequest[]> {
  const tid = tenantId();
  const res = await api.get<ACRRequest[]>(`/tenants/${tid}/acr-requests`);
  return res.data;
}
