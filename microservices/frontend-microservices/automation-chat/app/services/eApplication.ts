import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EApplicationStatus = "NotSent" | "Sent" | "InProgress" | "Submitted" | "Verified" | "Expired";

export interface CustomQuestion {
  id: string;
  question: string;
  type: "yes_no" | "text" | "number";
  section?: string;
}

export interface EApplication {
  status: EApplicationStatus;
  sent_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  verified_at?: string | null;
  medical_questionnaire: Record<string, any> | null;
  family_history: { entries?: FamilyHistoryEntry[] } | null;
  lifestyle_habits: Record<string, any> | null;
  existing_insurance: Record<string, any> | null;
  declaration: Record<string, any> | null;
}

export interface FamilyHistoryEntry {
  relation: string;
  name?: string;
  age?: number | string;
  is_alive?: boolean;
  condition?: string;
  age_at_onset?: number | string;
}

export interface EApplicationInvite {
  token: string;
  link_path: string;
  expires_at: string;
  status: EApplicationStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff-facing API (tenant-authenticated — used from /case/[id] and /underwriting)
// ─────────────────────────────────────────────────────────────────────────────

export async function inviteEApplication(caseId: string): Promise<EApplicationInvite> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/e-application/invite`);
  return res.data;
}

export async function getEApplication(caseId: string): Promise<EApplication> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/cases/${caseId}/e-application`);
  return res.data;
}

export async function saveCustomQuestions(caseId: string, customQuestions: CustomQuestion[]): Promise<any> {
  const tid = tenantId();
  const res = await api.put(`/tenants/${tid}/cases/${caseId}/e-application/custom-questions`, {
    custom_questions: customQuestions,
  });
  return res.data;
}

export async function verifyEApplication(caseId: string, action: "approve" | "reject", notes?: string): Promise<any> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/e-application/verify`, {
    action,
    notes,
  });
  return res.data;
}
