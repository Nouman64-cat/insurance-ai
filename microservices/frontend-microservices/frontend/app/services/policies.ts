import { operation, runOperation, browserOperationScope, operationHeaders } from "@/lib/idempotency";
import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

export interface PolicyListItem {
  id: string;
  policy_number: string | null;
  customer_id: string;
  customer_name: string;
  product_name: string;
  insurance_type: string;
  coverage_amount: number;
  term_years: number;
  status: string;
  segment?: string;
  family_group_id?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  region?: string | null;
  case_number?: string | null;
  case_status?: string | null;
  /** What was collected at the proposal, if anything. */
  initial_premium_received?: number | null;
  initial_premium_balance?: number | null;   // still to pay at issuance when only part was paid at the proposal
  effective_date: string | null;
  expiry_date: string | null;
  created_at: string;
  /** When the policy last moved (e.g. approved out of underwriting, issued). */
  updated_at?: string;
}

export interface PolicyStats {
  total: number;
  pending_issuance: number;
  active: number;
  grace_period: number;
  lapsed: number;
  cancelled: number;
  expiring_30d: number;
}

export interface PremiumBreakdown {
  base_premium: number;
  loading_amount: number;
  policy_fee: number;
  /** Stamp duty; absent on quotes priced before stamp duty and tax were split. */
  stamp_duty_amount?: number;
  /** Sales tax. */
  tax_amount: number;
  total_premium: number;
}

export interface PaymentIntent {
  reference: string;
  method: string;
  amount: number;
  status: string;
  gateway: string;
  initiated_at: string;
  realized_at: string | null;
}

export interface PaymentMethod {
  code: string;
  label: string;
}

export interface IssuanceResult {
  policy_number: string;
  status: string;
  effective_date: string;
  expiry_date: string;
  maturity_date?: string | null;
  grace_period_end_date: string;
  premium_breakdown: PremiumBreakdown;
  version: string;
  documents_generated: number;
  amount_due?: number;
  payment?: PaymentIntent;
  available_payment_methods?: PaymentMethod[];
}

export interface IssuancePreview {
  policy_id: string;
  status: string;
  already_issued: boolean;
  insured: {
    name: string;
    cnic: string | null;
    dob: string | null;
    policyholder_id: string | null;
    is_smoker: boolean;
  };
  contract: {
    product_name: string;
    insurance_type: string;
    coverage_amount: number;
    term_years: number;
    effective_date: string;
    maturity_date: string;
    billing_frequency: string;
    loading_pct: number;
  };
  premium_breakdown: PremiumBreakdown;
  /** Set when part of the premium was paid at the proposal: the premium quoted then (fee, duty and tax included) and the loading added now. */
  split_pricing?: { quoted_total: number; loading: number } | null;
  beneficiaries: { name: string; relationship: string; share_pct: number }[];
  readiness: { ready_to_issue: boolean; blockers: string[]; warnings: string[] };
}

export interface PaymentConfirmResult {
  policy_id: string;
  policy_number: string;
  status: string;
  effective_date: string | null;
  expiry_date: string | null;
  grace_period_end_date: string | null;
  payment: PaymentIntent;
}

export interface UpcomingRenewal {
  policy_id: string;
  policy_number: string;
  customer_id: string;
  product_name: string;
  coverage_amount: number;
  expiry_date: string;
  grace_period_end_date: string | null;
  status: string;
  days_to_expiry: number;
  urgency: "15d" | "30d" | "60d" | "90d" | "grace";
}

export interface PolicyVersion {
  id: string;
  version_number: string;
  effective_from: string;
  total_premium: number;
  event_type: string;
  created_at: string;
}

export interface PremiumScheduleItem {
  id: string;
  due_date: string;
  amount_due: number;
  amount_paid: number;
  status: string;
}

export interface PolicyDocument {
  id: string;
  document_type: string;
  document_name: string;
  is_stub: boolean;
  stub_content: string | null;
  generated_at: string;
}

export interface PolicyEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor: string;
  /** Display name when `actor` is a user id; null for system actors. */
  actor_name?: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface PolicyDetail extends PolicyListItem {
  nominee_name: string | null;
  nominee_relationship: string | null;
  dependent_name: string | null;
  dependent_dob: string | null;
  grace_period_end_date: string | null;
  maturity_date?: string | null;
  issued_by?: string | null;
  issued_at?: string | null;
  delivery_date: string | null;
  free_look_end_date: string | null;
  demo_bypass_flags: string | null;
  current_version_id: string | null;
  versions: PolicyVersion[];
  premium_schedules: PremiumScheduleItem[];
  renewal_transactions: Array<{
    id: string;
    renewal_year: number;
    status: string;
    renewal_premium: number | null;
    is_stp: boolean;
    created_at: string;
  }>;
  documents: PolicyDocument[];
  customer?: {
    cnic: string | null;
    dob: string | null;
    gender: string | null;
    marital_status: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    province: string | null;
    occupation: string | null;
    declared_income: number | null;
    is_smoker: boolean | null;
    height_cm: number | null;
    weight_kg: number | null;
    policyholder_id: string | null;
    created_at: string | null;
  } | null;
}

export async function getPolicyStats(): Promise<PolicyStats> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/stats`, {
    headers: { "X-Tenant-Id": tid },
  });
  return res.data;
}

export async function listPolicies(status?: string): Promise<PolicyListItem[]> {
  const tid = tenantId();
  const params = status ? { status } : {};
  const res = await api.get(`/tenants/${tid}/policies`, {
    params,
    headers: { "X-Tenant-Id": tid },
  });
  return res.data;
}

export async function getUpcomingRenewals(days = 90): Promise<UpcomingRenewal[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/renewals/upcoming`, {
    params: { days },
    headers: { "X-Tenant-Id": tid },
  });
  return res.data;
}

export async function getPolicyDetail(policyId: string): Promise<PolicyDetail> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}`, {
    headers: { "X-Tenant-Id": tid },
  });
  return res.data;
}

export async function getIssuancePreview(policyId: string): Promise<IssuancePreview> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/issuance-preview`);
  return res.data;
}

export async function issuePolicy(policyId: string): Promise<IssuanceResult> {
  const tid = tenantId();
  return operation(`policy-issue:${policyId}`, headers =>
    api.post(`/tenants/${tid}/policies/${policyId}/issue`, {}, { headers: { "X-Tenant-Id": tid, ...headers } }));
}

export async function initiatePayment(
  policyId: string,
  method?: string
): Promise<{ policy_id: string; amount_due: number; payment: PaymentIntent; available_payment_methods: PaymentMethod[] }> {
  const tid = tenantId();
  return runOperation(browserOperationScope(), `premium-initiate:${policyId}`, async key => {
  const res = await api.post(
    `/tenants/${tid}/policies/${policyId}/payments/initiate`,
    { method },
    { headers: { "X-Tenant-Id": tid, ...operationHeaders(key) } }
  );
  return res.data;
  });
}

export async function confirmPayment(
  policyId: string,
  opts: { method?: string; reference?: string; amount?: number; realize?: boolean } = {}
): Promise<PaymentConfirmResult> {
  const tid = tenantId();
  return operation(`premium-confirm:${policyId}`, headers =>
    api.post(`/tenants/${tid}/policies/${policyId}/payments/confirm`, { realize: true, ...opts }, { headers: { "X-Tenant-Id": tid, ...headers } }));
}

export async function renewPolicy(policyId: string): Promise<unknown> {
  const tid = tenantId();
  const res = await api.post(
    `/tenants/${tid}/policies/${policyId}/renew`,
    {},
    { headers: { "X-Tenant-Id": tid } }
  );
  return res.data;
}

export async function lapsePolicy(policyId: string): Promise<void> {
  const tid = tenantId();
  await api.post(
    `/tenants/${tid}/policies/${policyId}/lapse`,
    {},
    { headers: { "X-Tenant-Id": tid } }
  );
}

export async function getPolicyEvents(policyId: string): Promise<PolicyEvent[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/events`, {
    headers: { "X-Tenant-Id": tid },
  });
  return res.data;
}

export async function listPolicyDocuments(policyId: string): Promise<PolicyDocument[]> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/documents`, {
    headers: { "X-Tenant-Id": tid },
  });
  return res.data;
}

/** Downloads a policy document. `name` (the document's own name, e.g. "Initial Premium Receipt – POLICY-2026-0005")
 * becomes the file name; the browser cannot read the server's Content-Disposition across origins, so it is passed in. */
export async function downloadDocument(policyId: string, docId: string, name?: string): Promise<void> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/documents/${docId}/download`, {
    headers: { "X-Tenant-Id": tid },
    responseType: "blob",
  });
  
  const blob = new Blob([res.data], { type: String(res.headers['content-type'] || 'application/pdf') });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  
  // Extract filename from content-disposition header if present
  let filename = "document.pdf";
  const disposition = String(res.headers["content-disposition"] ?? "");
  const encoded = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  const plain = /filename="?([^";]+)"?/.exec(disposition);
  if (name) filename = `${name.replace(/[\\/:*?"<>|]/g, "-")}.pdf`;
  else if (encoded) filename = decodeURIComponent(encoded[1]);
  else if (plain) filename = plain[1];
  
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

export function fmtPKR(amount: number): string {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export interface PrepaidStatus {
  received: boolean; amount?: number; method?: string | null; reference?: string | null; received_at?: string | null;
  premium?: number | null; settled?: boolean; awaiting_activation?: boolean;
  /** RS-PAY-001: part of the premium was paid at the proposal; this is what remains to pay now, with the message to show. */
  remaining_due?: number | null; remaining_message?: string | null; split?: { upfront_pct: number; remaining_pct: number; upfront_amount: number; remaining_amount: number; total: number } | null;
}

/** The initial premium collected at the proposal, if any. */
export async function getPrepaid(policyId: string): Promise<PrepaidStatus> {
  const tid = tenantId();
  return (await api.get(`/tenants/${tid}/policies/${policyId}/payments/prepaid`, { headers: { "X-Tenant-Id": tid } })).data;
}

/** Settle the first premium with the initial premium already received, and bind cover. No second payment. */
export async function applyPrepaid(policyId: string): Promise<PaymentConfirmResult> {
  const tid = tenantId();
  return operation(`premium-apply-prepaid:${policyId}`, headers =>
    api.post(`/tenants/${tid}/policies/${policyId}/payments/apply-prepaid`, {}, { headers: { "X-Tenant-Id": tid, ...headers } }));
}
