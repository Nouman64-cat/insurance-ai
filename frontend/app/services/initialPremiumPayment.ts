import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type IPPStatus = "NotStarted" | "Initiated" | "Realized" | "Failed";

export interface IPP {
  status: IPPStatus;
  amount: number | null;
  method: string | null;
  reference: string | null;
  initiated_at: string | null;
  realized_at: string | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// API — pre-underwriting IPP (distinct from policies.ts's post-decision
// /payments/initiate|confirm, which binds cover after underwriting).
// ─────────────────────────────────────────────────────────────────────────────

export async function getIPP(caseId: string): Promise<IPP> {
  const tid = tenantId();
  const res = await api.get(`/tenants/${tid}/cases/${caseId}/ipp`);
  return res.data;
}

export async function initiateIPP(
  caseId: string,
  method?: string
): Promise<{ amount: number; payment: PaymentIntent; available_payment_methods: PaymentMethod[] }> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/ipp/initiate`, { method });
  return res.data;
}

export async function confirmIPP(
  caseId: string,
  opts: { method?: string; reference?: string; realize?: boolean } = {}
): Promise<IPP> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/ipp/confirm`, { realize: true, ...opts });
  return res.data;
}
