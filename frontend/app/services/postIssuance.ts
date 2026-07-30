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
}

export interface PortalCredentials {
  reset: boolean;
  username: string;
  temp_password: string;   // shown ONCE
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

export async function provisionPortal(policyId: string): Promise<PortalCredentials> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/policies/${policyId}/onboarding/portal`);
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
  | "paid" | "waived" | "upcoming" | "due_soon" | "due_today" | "grace" | "past_grace";

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
  receipt: { id: string; receipt_no: string; total_amount: number } | null;
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

export function receiptDownloadUrl(policyId: string, receiptId: string): string {
  const tid = tenantId();
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";
  return `${base}/tenants/${tid}/policies/${policyId}/premiums/receipts/${receiptId}/download`;
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
