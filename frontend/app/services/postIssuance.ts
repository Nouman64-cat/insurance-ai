import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Stage B — Post-Issuance
// ─────────────────────────────────────────────────────────────────────────────

export interface FreeLookStatus {
  policy_id: string;
  status: string;
  delivery_date: string | null;
  free_look_end_date: string | null;
  is_open: boolean;
  days_remaining: number;
  premium_paid: number;
  refund_amount: number;
  cancelled: boolean;
  cancellation: {
    refund_amount: number | null;
    refund_reference: string | null;
    reason: string | null;
    at: string;
  } | null;
}

export interface FreeLookCancelResult {
  policy_id: string;
  status: string;
  refund_amount: number;
  refund: {
    reference: string;
    method: string;
    amount: number;
    status: string;
  };
}

// ── Deliver Policy & Free-Look Period ────────────────────────────────────────

export async function getFreeLookStatus(policyId: string): Promise<FreeLookStatus> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/free-look`);
  return res.data;
}

export async function cancelWithinFreeLook(
  policyId: string,
  body?: { reason?: string; requested_by?: string },
): Promise<FreeLookCancelResult> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/free-look/cancel`, body ?? {});
  return res.data;
}

// ── Step 2 — Customer Welcome & Onboarding ───────────────────────────────────

export interface OnboardingStatus {
  policy_id: string;
  status: "Pending" | "InProgress" | "Completed";
  policy_status: string;
  can_onboard: boolean;
  completed: boolean;
  progress: { done: number; total: number };
  contact: { email: string | null; phone: string | null };
  steps: {
    policyholder_id: { done: boolean; value: string | null };
    welcome_kit: { done: boolean; name: string | null; generated_at: string | null };
    portal: { done: boolean; username: string | null; status: string | null; must_reset: boolean | null };
    welcome_sent: { done: boolean; at: string | null; channel: string | null };
    acknowledged: { done: boolean; at: string | null; method: string | null };
  };
  warnings: string[];
  automatic_delivery?: Record<string, {
    status: "Pending" | "Retry" | "Completed" | "Skipped";
    attempts: number;
    error: string | null;
    completed_at: string | null;
  }>;
}

export interface PortalCredentials {
  reset: boolean;
  /** The customer already signed in and chose their own password: nothing was changed and there is no temporary password. */
  already_active?: boolean;
  suspended?: boolean;
  username: string;
  temp_password: string | null;   // shown ONCE
  portal_url: string;
  invite_expires_at: string;
}

export async function getOnboarding(policyId: string): Promise<OnboardingStatus> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/onboarding`);
  return res.data;
}

export async function resetOnboarding(policyId: string): Promise<OnboardingStatus> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/reset`);
  return res.data;
}

export async function assignPolicyholderId(policyId: string): Promise<{ policyholder_id: string; reused: boolean }> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/policyholder-id`);
  return res.data;
}

export async function generateWelcomeKit(policyId: string): Promise<{ document_name: string; generated_at: string }> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/welcome-kit`);
  return res.data;
}

export function welcomeKitDownloadUrl(policyId: string): string {
  const tid = tenantId();
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";
  return `${base}/tenants/${tid}/policies/${policyId}/onboarding/welcome-kit/download`;
}

/** `reset: true` is the deliberate staff reset of a customer's password; without it an already-active customer is left untouched. */
export async function provisionPortal(policyId: string, reset = false): Promise<PortalCredentials> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/portal`, reset ? { reset: true, reason: "Reset from post-issuance onboarding" } : undefined);
  return res.data;
}

export async function sendWelcome(
  policyId: string,
  body?: { channel?: string; sent_by?: string },
): Promise<{ channel: string; sent_at: string; onboarding: OnboardingStatus }> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/send-welcome`, body ?? {});
  return res.data;
}

export async function setOnboardingContact(
  policyId: string,
  body: { email?: string; phone?: string },
): Promise<OnboardingStatus> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/contact`, body);
  return res.data;
}

export async function acknowledgeOnboarding(
  policyId: string,
  body?: { method?: string; acknowledged_by?: string },
): Promise<OnboardingStatus> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/acknowledge`, body ?? {});
  return res.data;
}

// ── Step 3 — Recurring Premium Collection ────────────────────────────────────

export type InstallmentState =
  | "paid" | "partially_paid" | "waived" | "upcoming" | "due_soon" | "due_today" | "grace" | "past_grace";

export interface ReminderPlanItem {
  key: string; kind: string; label: string; date: string; due: boolean; sent: boolean;
}

export interface Installment {
  id: string;
  installment_no: number;
  billing_frequency: string;
  due_date: string;
  amount_due: number;
  amount_paid: number;
  outstanding: number;
  surcharge: number;
  payable: number;
  status: string;
  state: InstallmentState;
  days_until: number;
  reminder_count: number;
  last_reminder_at: string | null;
  reminder_plan: ReminderPlanItem[];
  paid_at: string | null;
  payment_reference: string | null;
  receipt: { id: string; receipt_no: string; total_amount: number; method?: string } | null;
}

export interface BillingLedger {
  policy_id: string;
  policy_status: string;
  can_collect: boolean;
  autopay_enabled: boolean;
  surcharge_pct: number;
  commission_pct: number;
  installments: Installment[];
  summary: {
    total: number;
    paid: number;
    outstanding_count: number;
    arrears_count: number;
    total_outstanding: number;
    next_due_date: string | null;
    next_due_amount: number | null;
    in_grace: boolean;
    grace_until: string | null;
    grace_days_left: number | null;
    lapse_due: boolean;
  };
  dashboard: {
    total_collected: number;
    collected_this_month: number;
    overdue_amount: number;
    collection_rate: number;
    commission_earned: number;
    receipts_count: number;
  };
}

export interface ReminderLog {
  id: string; schedule_id: string | null; kind: string; channel: string; template: string;
  to_address: string | null; message: string | null; sent_by: string | null; created_at: string;
}

export interface ReceiptRow {
  id: string; receipt_no: string; schedule_id: string | null;
  base_amount: number; surcharge_amount: number; total_amount: number;
  method: string | null; payment_reference: string | null;
  commission_agent_id: string | null; commission_pct: number; commission_amount: number; created_at: string;
}

export const REMINDER_CHANNELS = ["Email", "SMS", "WhatsApp", "Letter"] as const;
export const REMINDER_TEMPLATES = ["Friendly", "Standard", "FinalNotice"] as const;
export const BILLING_FREQUENCIES = ["Annual", "SemiAnnual", "Quarterly", "Monthly"] as const;

export async function getBilling(policyId: string): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/premiums`);
  return res.data;
}

export async function collectInstallment(
  policyId: string, scheduleId: string,
  body?: { method?: string; manual?: boolean; realize?: boolean; collected_by?: string },
): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/${scheduleId}/collect`, body ?? {});
  return res.data;
}

export async function bulkCollectInstallments(
  policyId: string,
  body: { amount: number; method?: string; manual?: boolean; realize?: boolean; collected_by?: string },
): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/bulk-collect`, body);
  return res.data;
}

export async function remindInstallment(
  policyId: string, scheduleId: string,
  body?: { channel?: string; template?: string; kind?: string; sent_by?: string },
): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/${scheduleId}/remind`, body ?? {});
  return res.data;
}

export async function restructurePlan(policyId: string, frequency: string): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/restructure`, { frequency });
  return res.data;
}

export async function getReminderHistory(policyId: string): Promise<ReminderLog[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/premiums/reminders`);
  return res.data;
}

export async function getReceipts(policyId: string): Promise<ReceiptRow[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/premiums/receipts`);
  return res.data;
}

export async function downloadReceipt(policyId: string, receiptId: string): Promise<void> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/premiums/receipts/${receiptId}/download`, {
    responseType: "blob",
  });
  const name = res.headers["content-disposition"]?.split("filename=")[1]?.replace(/"/g, "") ?? "receipt.pdf";
  const url = window.URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.URL.revokeObjectURL(url);
}

export async function downloadLapseWarning(policyId: string): Promise<void> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/lapse-warning`, {}, { responseType: "blob" });
  const blob = new Blob([res.data], { type: "application/pdf" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "lapse_warning.pdf";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

export async function waiveInstallment(
  policyId: string, scheduleId: string,
  body?: { note?: string; actor?: string },
): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/${scheduleId}/waive`, body ?? {});
  return res.data;
}

export async function runBillingMonitor(policyId: string): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/monitor`);
  return res.data;
}

export async function setAutopay(policyId: string, enabled: boolean): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/autopay`, { enabled });
  return res.data;
}

export async function demoSeedPremiums(policyId: string, scenario: "healthy" | "grace" | "lapse"): Promise<BillingLedger> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/premiums/demo-seed`, { scenario });
  return res.data;
}

// ── Policy-issuance confirmation email ───────────────────────────────────────

export async function sendIssuanceEmail(policyId: string): Promise<{ sent_to: string; sent_at: string; delivered: boolean; subject: string }> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/issuance/send-email`);
  return res.data;
}

// ── Policy Servicing & Endorsements ──────────────────────────────────────────

export interface EndorsementRecord {
  id: string; endorsement_no: string; type: string; summary: string;
  effective_date: string; premium_delta: number; actor: string | null;
  has_document: boolean; created_at: string;
}

export interface RiderRow { id: string; name: string; sum_assured: number; annual_premium: number; }

export interface EndorsementsOverview {
  policy_id: string;
  policy_status: string;
  can_endorse: boolean;
  sum_assured: number;
  address: { address: string | null; city: string | null; province: string | null };
  contact: { email: string | null; phone: string | null };
  beneficiaries: { name: string; cnic: string | null; relationship: string; share_pct: number }[];
  riders: RiderRow[];
  history: EndorsementRecord[];
}

export interface EndorsementQuote { current_premium: number; new_premium: number; delta: number; }

export async function getEndorsements(policyId: string): Promise<EndorsementsOverview> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/endorsements`);
  return res.data;
}

export async function endorseNominees(
  policyId: string,
  beneficiaries: { name: string; cnic?: string; relationship: string; share_pct: number }[],
  note?: string,
): Promise<EndorsementsOverview> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/endorsements/nominees`, { beneficiaries, note });
  return res.data;
}

export async function endorseAddress(
  policyId: string, body: { address?: string; city?: string; province?: string; note?: string },
): Promise<EndorsementsOverview> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/endorsements/address`, body);
  return res.data;
}

export async function endorseSumAssured(
  policyId: string, newSumAssured: number, note?: string,
): Promise<EndorsementsOverview> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/endorsements/sum-assured`, { new_sum_assured: newSumAssured, note });
  return res.data;
}

export async function endorseRider(
  policyId: string,
  body: { action: "add" | "remove"; name?: string; sum_assured?: number; annual_premium?: number; rider_id?: string; note?: string },
): Promise<EndorsementsOverview> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/endorsements/riders`, body);
  return res.data;
}

export function endorsementDocUrl(policyId: string, endorsementId: string): string {
  const tid = tenantId();
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";
  return `${base}/tenants/${tid}/policies/${policyId}/endorsements/${endorsementId}/document/download`;
}

export async function getEndorsementQuote(
  policyId: string, params: { sum_assured?: number; rider_premium?: number },
): Promise<EndorsementQuote> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/endorsements/quote`, { params });
  return res.data;
}

export async function endorseContact(
  policyId: string, body: { email?: string; phone?: string; note?: string },
): Promise<EndorsementsOverview> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/endorsements/contact`, body);
  return res.data;
}

export async function emailEndorsement(
  policyId: string, endorsementId: string,
): Promise<{ sent_to: string; sent_at: string; delivered: boolean }> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/endorsements/${endorsementId}/email`);
  return res.data;
}

// ── Reinstatement (revive a lapsed policy) ───────────────────────────────────

export interface ReinstatementCheck {
  key: string; label: string; passed: boolean; detail: string;
  severity: "ok" | "block" | "review" | "info";
}

export interface ReinstatementEligibility {
  policy_status: string;
  outcome: "eligible" | "resume" | "not_required" | "use_collection" | "blocked";
  eligible: boolean;
  message: string;
  lapse_date: string | null;
  days_lapsed: number | null;
  window_days: number;
  window_ends_on: string | null;
  window_days_left: number | null;
  checks: ReinstatementCheck[];
  blockers: ReinstatementCheck[];
}

export interface ArrearsLine {
  schedule_id: string; installment_no: number; due_date: string; days_overdue: number;
  premium: number; surcharge: number; interest: number; total: number;
}
export interface ReinstatementArrears {
  as_of: string; lines: ArrearsLine[]; premiums: number; surcharges: number;
  interest: number; fee: number; total: number;
}

export interface DeclarationQuestion { key: string; text: string; adverse_if: boolean; needs_details: boolean; }

export interface ReinstatementEvidence {
  key: string; label: string; reason: string | null; required: boolean; source: string;
  status: "Requested" | "Received"; requested_at: string; received_at: string | null;
  note: string | null; file_name: string | null; has_file: boolean;
}

export interface ReinstatementAssessment {
  recommendation: "StraightThrough" | "Review" | "EvidenceRequired" | "Refer";
  summary: string;
  flags: { code: string; severity: "high" | "medium" | "info"; message: string }[];
  metrics: { lapse_days: number | null; age: number | null; sum_assured: number; non_medical_limit: number;
    over_non_medical_limit: boolean; adverse_count: number };
  assessed_at: string;
}

export interface ReinstatementTerms {
  loading_pct: number; exclusions: string | null; additional_annual_premium: number;
  current_annual_premium: number | null; new_annual_premium: number; offered_by: string; offered_at: string;
}

export interface ReinstatementStep {
  n: number; key: string; title: string; blurb: string;
  state: "done" | "current" | "pending" | "closed"; detail: string;
}

export interface ReinstatementTimelineItem {
  id: string; event_type: string; actor: string | null; from_status: string | null;
  to_status: string | null; at: string; detail: Record<string, unknown>;
}

export interface ReinstatementCaseSummary {
  id: string; case_no: string; status: string; decision: string | null; applicant_name: string | null;
  total_payable: number; lapse_date: string | null; effective_date: string | null;
  created_at: string; closed_reason: string | null;
}

export interface ReinstatementCase extends ReinstatementCaseSummary {
  applicant_relationship: string | null; request_channel: string | null; reason: string | null;
  requested_by: string | null; window_ends_on: string | null;
  eligibility: { checks: ReinstatementCheck[]; days_lapsed: number | null; evaluated_at: string } | null;
  arrears: ReinstatementArrears | null; arrears_calculated_at: string | null;
  declaration: { answers: Record<string, boolean>; details: Record<string, string>;
    signature_method: string; signed_on: string } | null;
  declaration_signed_at: string | null; declaration_signed_by: string | null;
  evidence: ReinstatementEvidence[];
  assessment: ReinstatementAssessment | null; assessed_at: string | null;
  decision_notes: string | null; decided_by: string | null; decided_at: string | null;
  terms: ReinstatementTerms | null; terms_response: "Accepted" | "Rejected" | null;
  terms_responded_at: string | null; terms_responded_by: string | null;
  decision_history: { decision: string; notes: string | null; by: string; at: string;
    terms: ReinstatementTerms | null; evidence: string[] | null }[];
  payment: { amount: number; method: string | null; reference: string | null;
    realized_at: string | null; refund_reference: string | null };
  reinstated_at: string | null;
  receipts: { receipt_no: string; installment_no: number; total: number }[];
  confirmation: { generated_at: string | null; sent_at: string | null; sent_to: string | null };
  conditions: { declaration: boolean; evidence: boolean; decision: boolean; terms: boolean; payment: boolean };
  workflow: ReinstatementStep[];
  is_open: boolean;
  can_restore: boolean;
  restore_blockers: string[];
  timeline: ReinstatementTimelineItem[];
}

export interface ReinstatementOverview {
  policy: { id: string; policy_number: string | null; status: string; product_name: string;
    sum_assured: number; customer_name: string | null };
  eligibility: ReinstatementEligibility;
  case: ReinstatementCase | null;
  resumed: boolean;
  history: ReinstatementCaseSummary[];
  declaration_questions: DeclarationQuestion[];
  options: { channels: string[]; relationships: string[] };
}

export type ReinstatementDecisionKind = "Approve" | "ApproveWithTerms" | "RequestEvidence" | "Decline";

const reinstatementBase = (policyId: string, caseId?: string) =>
  `/tenants/${tenantId()}/policies/${policyId}/reinstatement${caseId ? `/${caseId}` : ""}`;

export async function getReinstatement(policyId: string): Promise<ReinstatementOverview> {
  return (await api.get(reinstatementBase(policyId))).data;
}

export async function openReinstatement(
  policyId: string,
  body: { applicant_name?: string; applicant_relationship: string; request_channel: string; reason?: string; requested_by?: string },
): Promise<ReinstatementOverview> {
  return (await api.post(reinstatementBase(policyId), body)).data;
}

export async function recalculateReinstatementArrears(policyId: string, caseId: string): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/arrears/recalculate`)).data;
}

export async function submitReinstatementDeclaration(
  policyId: string, caseId: string,
  body: { answers: Record<string, boolean>; details: Record<string, string>; signed_by: string;
    signature_method: string; confirm_signed: boolean },
): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/declaration`, body)).data;
}

export async function rerunReinstatementAssessment(policyId: string, caseId: string): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/assessment`)).data;
}

export async function receiveReinstatementEvidence(
  policyId: string, caseId: string, key: string, body: { note?: string; file?: File | null },
): Promise<ReinstatementOverview> {
  const form = new FormData();
  if (body.note) form.append("note", body.note);
  if (body.file) form.append("file", body.file);
  return (await api.post(`${reinstatementBase(policyId, caseId)}/evidence/${key}`, form)).data;
}

export function reinstatementEvidenceUrl(policyId: string, caseId: string, key: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL ?? ""}${reinstatementBase(policyId, caseId)}/evidence/${key}/download`;
}

export async function decideReinstatement(
  policyId: string, caseId: string,
  body: { decision: ReinstatementDecisionKind; notes?: string; loading_pct?: number; exclusions?: string;
    evidence?: { label: string; reason?: string }[] },
): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/decision`, body)).data;
}

export async function respondReinstatementTerms(
  policyId: string, caseId: string, body: { accepted: boolean; responded_by?: string; note?: string },
): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/terms/respond`, body)).data;
}

export async function payReinstatement(
  policyId: string, caseId: string,
  body: { method?: string; reference?: string; manual?: boolean; collected_by?: string },
): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/payment`, body)).data;
}

export async function restoreReinstatement(policyId: string, caseId: string): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/restore`, {})).data;
}

export async function withdrawReinstatement(
  policyId: string, caseId: string, body: { reason?: string },
): Promise<ReinstatementOverview> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/withdraw`, body)).data;
}

export function reinstatementConfirmationUrl(policyId: string, caseId: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL ?? ""}${reinstatementBase(policyId, caseId)}/confirmation/download`;
}

export async function sendReinstatementConfirmation(
  policyId: string, caseId: string,
): Promise<{ sent_to: string; sent_at: string; delivered: boolean; subject: string }> {
  return (await api.post(`${reinstatementBase(policyId, caseId)}/confirmation/send`)).data;
}

// ── Policy Renewals (Stage B step 7) ─────────────────────────────────────────

export type RenewalType = "PremiumRenewal" | "ContractRenewal";

export interface RenewalStage {
  key: "eligibility" | "notice" | "risk" | "acceptance" | "collection" | "reconciliation" | "confirmation";
  title: string;
  state: "complete" | "pending" | "awaiting" | "action" | "exception" | "not_started" | "skipped";
  label: string;
  detail: string;
  covers: number[];
}

export interface RenewalNext {
  due_date: string; amount: number | null; surcharge: number; payable: number;
  renewal_type: RenewalType; renewal_type_label: string; frequency: string | null;
  in_ledger: boolean; installment_no: number | null; window_opens_on: string; days_until: number;
  state: "Upcoming" | "InWindow" | "Due" | "Overdue"; notice_days: number; period_end: string | null;
}

export interface RenewalEligibility {
  outcome: "eligible" | "resume" | "blocked" | "use_reinstatement" | "group_scheme" | "term_complete";
  eligible: boolean; message: string; checks: ReinstatementCheck[];
  blockers: ReinstatementCheck[]; reviews: ReinstatementCheck[];
}

export interface RenewalQuote {
  current_annual: number; renewal_annual: number; loading_pct: number; additional_annual: number;
  new_annual: number; change_pct: number | null; frequency: string; instalment: number;
  period_start: string | null; period_end: string | null; rating_basis: string;
}

export interface RenewalPayment {
  schedule_id: string; installment_no: number; due_date: string; status: string;
  amount_due: number; amount_paid: number; outstanding: number; surcharge: number; payable: number;
  paid_at: string | null; payment_reference: string | null;
  receipts: { id: string; receipt_no: string; total_amount: number; surcharge_amount: number; method: string | null }[];
}

export interface RenewalCase {
  id: string; renewal_no: string; renewal_type: RenewalType; renewal_type_label: string;
  status: "Open" | "Referred" | "Completed" | "Declined" | "Cancelled";
  cycle_label: string | null; renewal_year: number | null; due_date: string;
  period_start: string | null; period_end: string | null; source: string; opened_by: string | null;
  created_at: string; is_open: boolean; closed_reason: string | null;
  eligibility: { checks: ReinstatementCheck[]; evaluated_at: string } | null;
  quote: RenewalQuote | null; quoted_amount: number;
  notice: { sent_at: string | null; channel: string | null; count: number; delivered: boolean | null; has_document: boolean };
  risk: { required: boolean; outcome: "NotRequired" | "STP" | "Referred" | "Approved" | "Declined" | null;
    detail: { reasons: string[]; metrics: Record<string, number | null> } | null;
    evaluated_at: string | null; decided_by: string | null; decided_at: string | null; notes: string | null; loading_pct: number };
  acceptance: { required: boolean; accepted_at: string | null; accepted_by: string | null; method: string | null; methods: string[] };
  payment: RenewalPayment | null;
  reconciliation: { result: { status: "Matched" | "Exception"; expected: number; received: number; surcharge: number;
    variance: number; checks: ReinstatementCheck[] } | null; reconciled_at: string | null; reconciled_by: string | null; note: string | null };
  completion: { completed_at: string | null; completed_by: string | null; next_due_date: string | null; new_version_id: string | null };
  confirmation: { generated_at: string | null; sent_at: string | null; sent_to: string | null };
  stages: RenewalStage[];
  can: { notice: boolean; risk_decide: boolean; accept: boolean; pay: boolean; reconcile: boolean; complete: boolean; cancel: boolean };
  timeline: ReinstatementTimelineItem[];
}

export interface RenewalOverview {
  policy: { id: string; policy_number: string | null; status: string; product_name: string; sum_assured: number;
    customer_name: string | null; maturity_date: string | null; expiry_date: string | null };
  annual_premium: number;
  contract_renewable: boolean;
  next: RenewalNext | null;
  eligibility: RenewalEligibility;
  stages: RenewalStage[];
  case: RenewalCase | null;
  resumed: boolean;
  history: { id: string; renewal_no: string; renewal_type: RenewalType; status: string; due_date: string;
    quoted_amount: number; completed_at: string | null; closed_reason: string | null }[];
  group_scheme: { master_policy_id: string; organization_id: string | null; master_policy_number: string | null;
    expiry_date: string | null; latest_renewal_status: string | null; latest_renewal_period_end: string | null } | null;
  options: { channels: string[]; acceptance_methods: string[] };
}

const renewalsBase = (policyId: string, caseId?: string) =>
  `/tenants/${tenantId()}/policies/${policyId}/renewals${caseId ? `/${caseId}` : ""}`;

export async function getRenewals(policyId: string): Promise<RenewalOverview> {
  return (await api.get(renewalsBase(policyId))).data;
}
export async function openRenewal(policyId: string, body?: { actor?: string }): Promise<RenewalOverview> {
  return (await api.post(renewalsBase(policyId), body ?? {})).data;
}
export async function sendRenewalNotice(policyId: string, caseId: string, body: { channel?: string }): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/notice`, body)).data;
}
export function renewalNoticeUrl(policyId: string, caseId: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL ?? ""}${renewalsBase(policyId, caseId)}/notice/download`;
}
export async function reevaluateRenewalRisk(policyId: string, caseId: string): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/risk/evaluate`)).data;
}
export async function decideRenewalRisk(
  policyId: string, caseId: string,
  body: { decision: "Approve" | "ApproveWithLoading" | "Decline"; loading_pct?: number; notes?: string },
): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/risk/decision`, body)).data;
}
export async function captureRenewalAcceptance(
  policyId: string, caseId: string, body: { accepted: boolean; accepted_by?: string; method: string; note?: string },
): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/acceptance`, body)).data;
}
export async function payRenewal(
  policyId: string, caseId: string, body: { method?: string; reference?: string; manual?: boolean },
): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/payment`, body)).data;
}
export async function reconcileRenewal(policyId: string, caseId: string, body: { note?: string }): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/reconcile`, body)).data;
}
export async function completeRenewal(policyId: string, caseId: string): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/complete`, {})).data;
}
export async function cancelRenewal(policyId: string, caseId: string, body: { reason?: string }): Promise<RenewalOverview> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/cancel`, body)).data;
}
export function renewalConfirmationUrl(policyId: string, caseId: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL ?? ""}${renewalsBase(policyId, caseId)}/confirmation/download`;
}
export async function sendRenewalConfirmation(
  policyId: string, caseId: string,
): Promise<{ sent_to: string; sent_at: string; delivered: boolean; subject: string }> {
  return (await api.post(`${renewalsBase(policyId, caseId)}/confirmation/send`)).data;
}

// ── Claims Management (Stage B step 8) ───────────────────────────────────────

export type ClaimCategory = "Death" | "AccidentalDeath" | "Disability" | "Hospitalization";

export interface ClaimStage {
  n: number; key: "intimation" | "eligibility" | "documents" | "assessment" | "decision" | "settlement" | "closure";
  title: string; state: "complete" | "pending" | "action" | "exception" | "skipped" | "not_started"; label: string; detail: string;
}

export interface ClaimBenefitOption {
  category: ClaimCategory; label: string; applies: string; available: boolean; source: string | null;
  sum_assured: number; detail: string;
}

export interface ClaimListRow {
  id: string; claim_number: string; claim_type: string; status: string; claimed_amount: number; approved_amount: number;
  reported_date: string | null; event_date: string | null; has_workflow: boolean; category: ClaimCategory | null;
  stage: string | null; progress: { done: number; total: number } | null; sla_state: string | null; sla_due: string | null;
}

export interface ClaimsOverview {
  policy: { id: string; policy_number: string | null; status: string; product_name: string; insurance_type: string;
    sum_assured: number; segment: string; customer_name: string | null; customer_cnic: string | null;
    effective_date: string | null; maturity_date: string | null; nominee_name: string | null; nominee_relationship: string | null };
  coverage: { periods: { from: string; to: string | null; started_by: string; ended_by: string | null }[]; in_force_today: boolean; note: string | null };
  benefits: ClaimBenefitOption[];
  claims: ClaimListRow[];
  options: { categories: { key: ClaimCategory; label: string; applies: string }[]; causes: string[]; channels: string[];
    claimant_relationships: string[]; covered_relationships: string[]; payout_methods: string[] };
  rules: { sla_working_days: number; manager_limit: number; contestable_days: number };
}

export interface ClaimDocument {
  key: string; label: string; required: boolean; when: string; reason: string | null;
  status: "Requested" | "Received" | "Waived" | "Rejected"; requested_at: string; received_at: string | null;
  artifact_id: string | null; file_name: string | null; note: string | null;
}

export interface ClaimPayee {
  id: string; name: string; beneficiary_name: string; cnic: string | null; relationship: string; share_pct: number; amount: number;
  is_minor: boolean; guardian_name: string | null; source: string; verified: boolean; verified_by: string | null; verified_at: string | null;
  method: string | null; bank_name: string | null; account_title: string | null; iban: string | null; note: string | null;
  checks: ReinstatementCheck[];
}

export interface ClaimAssessment {
  basis: string; components: { label: string; amount: number }[]; deductions: { label: string; amount: number }[];
  gross: number; total_deductions: number; payable: number; capped_by: string | null; claimed_amount: number; notes: string | null;
  inputs: { disability_pct: number | null; copay_pct: number | null; remaining_limit: number | null; arrears_at_event: number };
}

export interface ClaimWorkspace {
  claim: {
    id: string; claim_number: string; claim_type: string; status: string; claimed_amount: number; approved_amount: number;
    settlement_amount: number | null; reported_date: string | null; fraud_probability: number; duplicate_flag: boolean;
    created_at: string; closed_at: string | null;
    claimant: { name: string | null; cnic: string | null; relationship: string | null; phone: string | null; email: string | null };
  };
  process: {
    category: ClaimCategory; category_label: string; segment: string; channel: string | null; intimated_by: string | null;
    covered_person: { name: string | null; cnic: string | null; relationship: string | null };
    event: { date: string; end_date: string | null; place: string | null; cause: string | null; description: string | null; details: Record<string, string> };
  };
  eligibility: {
    status: "Eligible" | "Referred" | "Ineligible" | null; verified_at: string | null; verified_by: string | null;
    override_by: string | null; override_note: string | null;
    result: { status: string; message: string; checks: ReinstatementCheck[]; contestable: boolean; cover_start: string | null;
      cover_periods: { from: string; to: string | null }[]; claimant_is_nominee: boolean;
      benefit: { available: boolean; label: string; source: string | null; sum_assured: number; detail: string } } | null;
  };
  documents: { items: ClaimDocument[]; progress: { required: number; received: number; outstanding: number; total: number; complete: boolean };
    generated_at: string | null; complete_at: string | null };
  investigation: { flags?: { code: string; severity: "high" | "medium" | "info"; message: string }[]; requires_investigation?: boolean;
    findings?: { kind: string; source: string | null; note: string; by: string; at: string }[]; outcome?: string | null;
    notes?: string | null; completed_at: string | null };
  assessment: { result: ClaimAssessment | null; assessed_at: string | null; assessed_by: string | null };
  decision: { decision: string | null; amount: number; reason: string | null; by: string | null; at: string | null;
    history: { decision: string; amount: number; reason: string | null; by: string; at: string }[]; requires_manager: boolean; manager_limit: number };
  sla: { state: "not_started" | "on_track" | "at_risk" | "breached" | "met"; due_date: string | null; working_days_left: number | null; sla_days: number; message: string };
  settlement: {
    payees: ClaimPayee[]; payees_verified_at: string | null; authorized_by: string | null; authorized_at: string | null; authorized_amount: number;
    disbursed_at: string | null; paid_total: number; reconciled_at: string | null; reconciled_by: string | null; methods: string[];
    payouts: { id: string; amount: number; method: string; status: string; reference_number: string | null; payee_name: string | null; completed_at: string | null }[];
    reconciliation: { status: "Matched" | "Exception"; approved: number; disbursed: number; variance: number; checks: ReinstatementCheck[] } | null;
  };
  closure: { outcome: string | null; closed_by: string | null; closed_at: string | null; coverage_update: Record<string, unknown> | null;
    confirmation: { generated_at: string | null; sent_at: string | null; sent_to: string | null } };
  stages: ClaimStage[];
  can: { verify: boolean; assess: boolean; decide: boolean; investigate: boolean; edit_documents: boolean; verify_payees: boolean;
    authorize: boolean; disburse: boolean; reconcile: boolean; close: boolean };
  timeline: ReinstatementTimelineItem[];
}

export interface RegisterClaimBody {
  category: ClaimCategory; event_date: string; event_end_date?: string; cause?: string; event_place?: string;
  event_description?: string; event_details?: Record<string, string>; claimed_amount: number;
  claimant_name: string; claimant_cnic?: string; claimant_relationship: string; claimant_phone?: string; claimant_email?: string;
  covered_person_name?: string; covered_person_cnic?: string; covered_person_relationship: string; channel: string; notes?: string;
}

const claimsBase = (policyId: string, claimId?: string) =>
  `/tenants/${tenantId()}/policies/${policyId}/claims-management${claimId ? `/${claimId}` : ""}`;
const claimsUrl = (path: string) => `${process.env.NEXT_PUBLIC_API_URL ?? ""}${path}`;

export async function getClaimsOverview(policyId: string): Promise<ClaimsOverview> {
  return (await api.get(claimsBase(policyId))).data;
}
export async function getClaimWorkspace(policyId: string, claimId: string): Promise<ClaimWorkspace> {
  return (await api.get(claimsBase(policyId, claimId))).data;
}
export async function registerClaim(policyId: string, body: RegisterClaimBody): Promise<ClaimWorkspace> {
  return (await api.post(claimsBase(policyId), body)).data;
}
export async function adoptClaim(policyId: string, claimId: string, body: { category: ClaimCategory; cause?: string; covered_person_relationship?: string }): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/adopt`, body)).data;
}
export async function reverifyClaimEligibility(policyId: string, claimId: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/eligibility/verify`)).data;
}
export async function overrideClaimEligibility(policyId: string, claimId: string, note: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/eligibility/override`, { note })).data;
}
export async function uploadClaimDocument(policyId: string, claimId: string, key: string, file: File, note?: string): Promise<ClaimWorkspace> {
  const form = new FormData();
  form.append("file", file);
  if (note) form.append("note", note);
  return (await api.post(`${claimsBase(policyId, claimId)}/documents/${key}`, form)).data;
}
export async function waiveClaimDocument(policyId: string, claimId: string, key: string, reason: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/documents/${key}/waive`, { reason })).data;
}
export async function returnClaimDocument(policyId: string, claimId: string, key: string, reason: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/documents/${key}/reject`, { reason })).data;
}
export async function requestClaimDocument(policyId: string, claimId: string, body: { label: string; required: boolean; reason?: string }): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/documents`, body)).data;
}
export const claimDocumentUrl = (policyId: string, claimId: string, key: string) => claimsUrl(`${claimsBase(policyId, claimId)}/documents/${key}/download`);
export const claimChecklistUrl = (policyId: string, claimId: string) => claimsUrl(`${claimsBase(policyId, claimId)}/checklist/download`);
export const claimLetterUrl = (policyId: string, claimId: string) => claimsUrl(`${claimsBase(policyId, claimId)}/confirmation/download`);
export async function addClaimFinding(policyId: string, claimId: string, body: { kind: string; source?: string; note: string }): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/investigation/finding`, body)).data;
}
export async function completeClaimInvestigation(policyId: string, claimId: string, body: { outcome: string; notes?: string }): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/investigation/complete`, body)).data;
}
export async function assessClaim(policyId: string, claimId: string, body: { disability_pct?: number; deductions: { label: string; amount: number }[]; copay_pct?: number; notes?: string }): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/assessment`, body)).data;
}
export async function decideClaim(policyId: string, claimId: string, body: { decision: "Approve" | "PartialApprove" | "Reject" | "RequestInfo" | "Refer"; amount?: number; reason?: string; info_requests?: { label: string }[] }): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/decision`, body)).data;
}
export async function verifyClaimPayees(policyId: string, claimId: string, payees: { id: string; cnic?: string; bank_name?: string; account_title?: string; iban?: string; method?: string; note?: string; verify: boolean }[]): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/settlement/payees`, { payees })).data;
}
export async function authorizeClaimDisbursement(policyId: string, claimId: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/settlement/authorize`)).data;
}
export async function disburseClaim(policyId: string, claimId: string, method: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/settlement/disburse`, { method })).data;
}
export async function reconcileClaim(policyId: string, claimId: string, note?: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/settlement/reconcile`, { note })).data;
}
export async function closeClaim(policyId: string, claimId: string): Promise<ClaimWorkspace> {
  return (await api.post(`${claimsBase(policyId, claimId)}/close`)).data;
}
export async function sendClaimLetter(policyId: string, claimId: string): Promise<{ sent_to: string; sent_at: string; delivered: boolean; subject: string }> {
  return (await api.post(`${claimsBase(policyId, claimId)}/confirmation/send`)).data;
}

// ── Policy Maturity & Exit (Stage B step 9) ──────────────────────────────────

export type ExitType = "Maturity" | "Expiry" | "Surrender" | "CorporateExpiry" | "DeathClaimClosure";

export interface ExitStage {
  n: number; key: "identify" | "extension" | "eligibility" | "documents" | "settlement" | "disbursement" | "closure";
  title: string; state: "complete" | "pending" | "action" | "exception" | "skipped" | "not_started"; label: string; detail: string;
}

export interface ExitSettlement {
  exit_type: string; basis: string; valuation_date: string; completed_years: number;
  fund: { premiums_paid: number; invested: number; value: number; growth: number; valuation_date: string };
  surrender_factor: number | null; lines: { label: string; amount: number }[]; gross: number;
  deductions: { label: string; amount: number; kind: string; loan_id?: string; note?: string }[];
  total_deductions: number; tax_pct: number; tax: number; net: number; shortfall: number; payable: boolean; notes?: string | null;
}

export interface ExitLoan { id: string; reference: string | null; principal: number; annual_interest_pct: number; disbursed_on: string; repaid: number; interest: number; balance: number }

export interface ExitCaseView {
  case: { id: string; exit_no: string; exit_type: ExitType; exit_type_label: string; profile: string | null; status: "Open" | "Completed" | "Declined" | "Cancelled";
    source: string; created_at: string; closed_reason: string | null; requested_by: string | null; requested_relationship: string | null;
    channel: string | null; reason: string | null; maturity_date: string | null; effective_date: string | null; is_open: boolean };
  extension: { decision: string | null; decided_by: string | null; decided_at: string | null; allowed?: boolean; open_renewal_no?: string | null; open_renewal_type?: string | null; note?: string | null };
  eligibility: { status: "Eligible" | "Referred" | "Ineligible" | null; verified_at: string | null; verified_by: string | null;
    result: { status: string; message: string; checks: ReinstatementCheck[]; financials?: ExitSettlement | null; financials_error?: string } | null };
  documents: { items: ClaimDocument[]; progress: { required: number; received: number; outstanding: number; total: number; complete: boolean }; complete_at: string | null };
  consent: { declarations: { key: string; text: string }[]; state: { declarations: { key: string; accepted: boolean }[]; by: string; method: string; at: string } | null;
    complete: boolean; at: string | null; methods: string[] };
  settlement: { result: ExitSettlement | null; net: number; calculated_at: string | null; calculated_by: string | null; valid_until: string | null;
    quote_valid: boolean; accepted_at: string | null; accepted_by: string | null; acceptance_method: string | null };
  disbursement: {
    payee: (ClaimPayee & { checks: ReinstatementCheck[] }) | null; payee_verified_at: string | null; authorized_by: string | null; authorized_at: string | null;
    payouts: { amount: number; method: string; payee_name: string | null; reference: string; status: string; at: string; account?: string }[];
    disbursed_at: string | null; reconciliation: { status: "Matched" | "Exception"; net: number; paid: number; variance: number; checks: ReinstatementCheck[] } | null;
    reconciled_at: string | null; reconciled_by: string | null; methods: string[]; dual_control_limit: number;
  };
  closure: { closed_at: string | null; closed_by: string | null; coverage_update: Record<string, any> | null;
    confirmation: { generated_at: string | null; sent_at: string | null; sent_to: string | null } };
  timing: { term_ends: string | null; term_reached: boolean };
  stages: ExitStage[];
  can: { verify: boolean; extension: boolean; documents: boolean; consent: boolean; calculate: boolean; accept: boolean; verify_payee: boolean;
    authorize: boolean; disburse: boolean; reconcile: boolean; close: boolean; cancel: boolean };
  timeline: ReinstatementTimelineItem[];
}

export interface ExitOverview {
  policy: { id: string; policy_number: string | null; status: string; product_name: string; insurance_type: string; sum_assured: number;
    customer_name: string | null; customer_cnic: string | null; effective_date: string | null; maturity_date: string | null;
    completed_years: number; free_look_end_date: string | null; is_group_certificate: boolean };
  profile: "Savings" | "Protection" | "Group";
  closed: boolean;
  extension: { allowed: boolean; open_renewal_no: string | null };
  natural: { exit_type: ExitType; label: string; term_ends: string | null;
    timing: { state: "Upcoming" | "InWindow" | "Reached" | "Unknown"; days_until: number | null; window_opens_on: string | null };
    eligibility: { status: string; message: string; checks: ReinstatementCheck[]; blockers: ReinstatementCheck[] }; can_open: boolean } | null;
  indicative: { maturity: ExitSettlement | null; surrender: { available: boolean; reason: string | null; settlement?: ExitSettlement } } | null;
  loans: ExitLoan[];
  claim_closure: { claim_no: string | null; at: string | null; benefit_paid: number | null; category: string | null } | null;
  group_scheme: { master_id?: string; organization_id?: string | null; master_number?: string | null; master_expiry?: string | null; master_status?: string | null; renewal_status?: string | null } | null;
  case: ExitCaseView | null;
  history: { id: string; exit_no: string; exit_type: ExitType; status: string; created_at: string; net_payable: number; closed_at: string | null; closed_reason: string | null }[];
  options: { channels: string[]; relationships: string[]; payout_methods: string[]; consent_methods: string[] };
  rules: { maturity_window_days: number; surrender_min_years: number; dual_control_limit: number; quote_valid_days: number };
}

const exitBase = (policyId: string, caseId?: string) =>
  `/tenants/${tenantId()}/policies/${policyId}/exit${caseId ? `/${caseId}` : ""}`;
const exitUrl = (path: string) => `${process.env.NEXT_PUBLIC_API_URL ?? ""}${path}`;

export async function getExitOverview(policyId: string): Promise<ExitOverview> { return (await api.get(exitBase(policyId))).data; }
export async function openExit(policyId: string, body: { exit_type?: "Surrender"; reason?: string; requested_by?: string; relationship?: string; channel?: string }): Promise<ExitOverview> {
  return (await api.post(exitBase(policyId), body)).data;
}
export async function recordPolicyLoan(policyId: string, body: { principal: number; annual_interest_pct: number; disbursed_on: string; reference?: string; note?: string }): Promise<ExitLoan[]> {
  return (await api.post(`${exitBase(policyId)}/loans`, body)).data;
}
export async function reverifyExit(policyId: string, caseId: string): Promise<ExitOverview> { return (await api.post(`${exitBase(policyId, caseId)}/eligibility/verify`)).data; }
export async function decideExitExtension(policyId: string, caseId: string, body: { decision: "Declined" | "Redirect"; note?: string }): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/extension`, body)).data;
}
export async function uploadExitDocument(policyId: string, caseId: string, key: string, file: File): Promise<ExitOverview> {
  const form = new FormData(); form.append("file", file);
  return (await api.post(`${exitBase(policyId, caseId)}/documents/${key}`, form)).data;
}
export async function waiveExitDocument(policyId: string, caseId: string, key: string, note: string): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/documents/${key}/waive`, { note })).data;
}
export const exitDocumentUrl = (policyId: string, caseId: string, key: string) => exitUrl(`${exitBase(policyId, caseId)}/documents/${key}/download`);
export async function recordExitConsent(policyId: string, caseId: string, body: { accepted: string[]; by: string; method: string }): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/consent`, body)).data;
}
export async function calculateExitSettlement(policyId: string, caseId: string, body: { recoverables: { label: string; amount: number; note?: string }[]; notes?: string }): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/settlement/calculate`, body)).data;
}
export const exitStatementUrl = (policyId: string, caseId: string) => exitUrl(`${exitBase(policyId, caseId)}/settlement/statement`);
export async function acceptExitSettlement(policyId: string, caseId: string, body: { accepted: boolean; by?: string; method?: string; note?: string }): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/settlement/accept`, body)).data;
}
export async function verifyExitPayee(policyId: string, caseId: string, body: { cnic?: string; bank_name?: string; account_title?: string; iban?: string; method?: string; note?: string; verify: boolean }): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/settlement/payee`, body)).data;
}
export async function authorizeExitPayment(policyId: string, caseId: string): Promise<ExitOverview> { return (await api.post(`${exitBase(policyId, caseId)}/settlement/authorize`)).data; }
export async function disburseExitPayment(policyId: string, caseId: string, method: string): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/settlement/disburse`, { method })).data;
}
export async function reconcileExitPayment(policyId: string, caseId: string, note?: string): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/settlement/reconcile`, { note })).data;
}
export async function closeExit(policyId: string, caseId: string): Promise<ExitOverview> { return (await api.post(`${exitBase(policyId, caseId)}/close`)).data; }
export async function cancelExit(policyId: string, caseId: string, reason?: string): Promise<ExitOverview> {
  return (await api.post(`${exitBase(policyId, caseId)}/cancel`, { reason })).data;
}
export const exitLetterUrl = (policyId: string, caseId: string) => exitUrl(`${exitBase(policyId, caseId)}/confirmation/download`);
export async function sendExitLetter(policyId: string, caseId: string): Promise<{ sent_to: string; sent_at: string; delivered: boolean; subject: string }> {
  return (await api.post(`${exitBase(policyId, caseId)}/confirmation/send`)).data;
}
