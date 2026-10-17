import api from "@/app/services/api";

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
  /** The financial e-application's answers: {employment, income, commitments, assets, funding}. */
  financial_profile?: Record<string, any> | null;
  /** Each questionnaire's own progress; empty for an e-application sent as one combined form. */
  parts?: Partial<Record<EApplicationPart, EApplicationPartStatus>>;
}

export type EApplicationPart = "medical" | "financial";
export interface EApplicationPartStatus {
  status: EApplicationStatus;
  sent_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  signature_name: string | null;
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
  /** The link is also emailed to the customer. */
  emailed_to?: string | null;
  email_status?: "sent" | "failed" | "no_email";
  /** Which questionnaire this link opens. */
  part?: EApplicationPart;
  /** Sending both at once: one link per questionnaire actually sent (the top-level fields are the first). */
  parts?: EApplicationInvite[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff-facing API (tenant-authenticated — used from /case/[id] and /underwriting)
// ─────────────────────────────────────────────────────────────────────────────

export async function inviteEApplication(caseId: string): Promise<EApplicationInvite> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/e-application/invite`);
  return res.data;
}

/** Send one questionnaire — the medical or the financial e-application — to the customer. */
export async function inviteEApplicationPart(caseId: string, part: EApplicationPart): Promise<EApplicationInvite> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/e-application/${part}/invite`);
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
