import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Pre-Underwriting gate 6 — Medical Examination (Non-Medical Limit → panel labs)
// ─────────────────────────────────────────────────────────────────────────────

export type MedicalExamStatus =
  | "NotAssessed" | "NotRequired" | "Required" | "Invited"
  | "Scheduled" | "Completed" | "Waived" | "Expired";

export type MedicalExamOutcome = "Normal" | "MinorFindings" | "Adverse";

export interface MedicalTest {
  code: string;
  name: string;
  category: string;
  fasting: boolean;
  cost: number;
  description: string;
}

export interface PanelClinic {
  id: string;
  code: string;
  name: string;
  network: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  home_sampling: boolean;
  turnaround_hours: number;
  supported_tests: string[] | null;
  is_active: boolean;
}

export interface AbnormalFinding {
  test: string;
  label: string;
  value: string | number;
  unit?: string;
  reference_range?: string;
  severity: "abnormal" | "uninsurable";
  loading_pct: number;
  finding: string;
}

/** A report file the customer uploaded through their examination link. */
export interface MedicalReportFile {
  id: string;
  test_code: string;
  file_name: string;
  status: string;
  created_at: string;
}

/** Reports staff can rely on — the OCR pass read them and nobody asked for a re-upload. */
export const usableReport = (report: MedicalReportFile) =>
  !["Rejected", "Re-submission Requested"].includes(report.status);

export interface MedicalExamOrder {
  id?: string;
  status: MedicalExamStatus;
  applicant_age?: number | null;
  sum_assured_at_risk: number;
  non_medical_limit: number | null;
  trigger_reasons: string[];
  required_tests: MedicalTest[];
  estimated_cost: number;
  fasting_required?: boolean;
  clinic: PanelClinic | null;
  clinic_id?: string | null;
  appointment_at: string | null;
  home_sampling?: boolean;
  appointment_note?: string | null;
  invited_at?: string | null;
  invite_expires_at?: string | null;
  results: Record<string, any> | null;
  outcome: MedicalExamOutcome | null;
  abnormal_findings: AbnormalFinding[];
  suggested_loading_pct: number | null;
  completed_at?: string | null;
  reported_by?: string | null;
  result_artifact_id?: string | null;
  waived_by?: string | null;
  waived_at?: string | null;
  waiver_reason?: string | null;
  valid_until?: string | null;
  unrated_tests?: string[];
  uninsurable?: boolean;
  reports?: MedicalReportFile[];
  reports_submitted?: boolean;
}

export interface MedicalExamInvite {
  token: string;
  link_path: string;
  expires_at: string;
  status: MedicalExamStatus;
  /** The link is also emailed to the customer. */
  emailed_to?: string | null;
  email_status?: "sent" | "failed" | "no_email";
}

/** Statuses that satisfy the pre-underwriting gate — nothing is outstanding. */
export const MEDICAL_CLEARED: ReadonlySet<MedicalExamStatus> = new Set<MedicalExamStatus>([
  "NotRequired", "Completed", "Waived",
]);

export async function getMedicalExam(caseId: string): Promise<MedicalExamOrder> {
  const res = await api.get(`/tenants/${tenantId()}/cases/${caseId}/medical-exam`);
  return res.data;
}

/** Apply the NML grid — decides whether an examination is required at all. */
export async function assessMedicalExam(caseId: string): Promise<MedicalExamOrder> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/assess`);
  return res.data;
}

export async function inviteMedicalExam(caseId: string): Promise<MedicalExamInvite> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/invite`);
  return res.data;
}

export async function getMedicalSlots(
  caseId: string,
): Promise<{ fasting_required: boolean; slots: string[] }> {
  const res = await api.get(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/slots`);
  return res.data;
}

export async function scheduleMedicalExam(
  caseId: string,
  body: { clinic_id: string; appointment_at: string; home_sampling?: boolean; note?: string },
): Promise<MedicalExamOrder> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/schedule`, body);
  return res.data;
}

export async function recordMedicalResult(
  caseId: string,
  body: { results: Record<string, any>; artifact_id?: string; reported_by?: string },
): Promise<MedicalExamOrder> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/result`, body);
  return res.data;
}

/** What the AI read for one test from the customer's reports — a pre-fill, not a result. */
export interface AiReadTest {
  value: string | null;
  abnormal: boolean | null;
  evidence: string | null;
  readable: boolean;
  report_ids: string[];
}

export interface AiReview {
  tests: Record<string, AiReadTest>;
}

/** Have the configured LLM read required tests out of the uploaded reports —
 *  one test when `testCode` is given (cached server-side per test). */
export async function aiReviewMedicalReports(
  caseId: string,
  opts: { testCode?: string; refresh?: boolean } = {},
): Promise<AiReview> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/ai-review`, null, {
    params: { ...(opts.testCode ? { test_code: opts.testCode } : {}), ...(opts.refresh ? { refresh: true } : {}) },
  });
  return res.data;
}

export async function waiveMedicalExam(caseId: string, reason: string): Promise<MedicalExamOrder> {
  const res = await api.post(`/tenants/${tenantId()}/cases/${caseId}/medical-exam/waive`, { reason });
  return res.data;
}

export async function listPanelClinics(city?: string): Promise<PanelClinic[]> {
  const res = await api.get(`/tenants/${tenantId()}/panel-clinics`, {
    params: city ? { city } : undefined,
  });
  return res.data;
}
