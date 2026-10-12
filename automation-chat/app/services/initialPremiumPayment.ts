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

type IPPInitiation = { amount: number; payment: PaymentIntent; available_payment_methods: PaymentMethod[] };
const initiating = new Map<string, Promise<IPPInitiation>>();

/**
 * Starts (or restarts) the payment for a case. Asking again while a request for the same case and method is still on
 * its way shares that request: the payment window asks as it opens and can be mounted twice in development, and two
 * calls would otherwise hand back two different payment references for one payment.
 */
export function initiateIPP(caseId: string, method?: string): Promise<IPPInitiation> {
  const key = `${caseId}|${method ?? ""}`;
  const running = initiating.get(key);
  if (running) return running;
  const tid = tenantId();
  const request = api
    .post(`/tenants/${tid}/cases/${caseId}/ipp/initiate`, { method })
    .then((res) => res.data as IPPInitiation)
    .finally(() => initiating.delete(key));
  initiating.set(key, request);
  return request;
}

export async function confirmIPP(
  caseId: string,
  opts: { method?: string; reference?: string; realize?: boolean } = {}
): Promise<IPP> {
  const tid = tenantId();
  const res = await api.post(`/tenants/${tid}/cases/${caseId}/ipp/confirm`, { realize: true, ...opts });
  return res.data;
}
