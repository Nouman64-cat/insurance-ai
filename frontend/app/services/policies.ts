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
  case_number?: string | null;
  case_status?: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  created_at: string;
}

export interface PolicyStats {
  total: number;
  pending_issuance: number;
  active: number;
  grace_period: number;
  lapsed: number;
  expiring_30d: number;
}

export interface PremiumBreakdown {
  base_premium: number;
  loading_amount: number;
  policy_fee: number;
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
  grace_period_end_date: string;
  premium_breakdown: PremiumBreakdown;
  version: string;
  documents_generated: number;
  amount_due?: number;
  payment?: PaymentIntent;
  available_payment_methods?: PaymentMethod[];
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
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface PolicyDetail extends PolicyListItem {
  nominee_name: string | null;
  grace_period_end_date: string | null;
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

export async function issuePolicy(policyId: string): Promise<IssuanceResult> {
  const tid = tenantId();
  const res = await api.post(
    `/tenants/${tid}/policies/${policyId}/issue`,
    {},
    { headers: { "X-Tenant-Id": tid } }
  );
  return res.data;
}

export async function initiatePayment(
  policyId: string,
  method?: string
): Promise<{ policy_id: string; amount_due: number; payment: PaymentIntent; available_payment_methods: PaymentMethod[] }> {
  const tid = tenantId();
  const res = await api.post(
    `/tenants/${tid}/policies/${policyId}/payments/initiate`,
    { method },
    { headers: { "X-Tenant-Id": tid } }
  );
  return res.data;
}

export async function confirmPayment(
  policyId: string,
  opts: { method?: string; reference?: string; amount?: number; realize?: boolean } = {}
): Promise<PaymentConfirmResult> {
  const tid = tenantId();
  const res = await api.post(
    `/tenants/${tid}/policies/${policyId}/payments/confirm`,
    { realize: true, ...opts },
    { headers: { "X-Tenant-Id": tid } }
  );
  return res.data;
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

export async function downloadDocument(policyId: string, docId: string): Promise<void> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/policies/${policyId}/documents/${docId}/download`, {
    headers: { "X-Tenant-Id": tid },
    responseType: "blob",
  });
  
  const blob = new Blob([res.data], { type: res.headers['content-type'] || 'application/pdf' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  
  // Extract filename from content-disposition header if present
  let filename = "document.pdf";
  const disposition = res.headers["content-disposition"];
  if (disposition && disposition.includes("filename=")) {
    filename = disposition.split("filename=")[1].replace(/['"]/g, "");
  }
  
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
