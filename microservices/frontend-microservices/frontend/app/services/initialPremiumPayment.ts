import { keyedPost, runOperation, browserOperationScope, operationHeaders } from "@/lib/idempotency";
import api from "./api";

const tenantId = () => (typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "");

export type IPPStatus = "NotStarted" | "Initiated" | "Realized" | "Failed";

export interface IPP {
  status: IPPStatus;
  amount: number | null;
  method: string | null;
  reference: string | null;
  initiated_at: string | null;
  realized_at: string | null;
  // Customer-side payment: staff ask the customer to pay, the customer uploads a screenshot, staff review it.
  requested_at?: string | null;
  requested_by?: string | null;
  request_expires_at?: string | null;
  link?: string | null;
  proof_status?: "None" | "Submitted" | "Accepted" | "Rejected";
  proof_uploaded_at?: string | null;
  proof_note?: string | null;
  proof_artifact_id?: string | null;
  proof_review_note?: string | null;
  proof_method?: string | null;
  proof_reference?: string | null;
  proof_reviewed_by?: string | null;
  proof_reviewed_at?: string | null;
  reminder_count?: number;
  last_reminded_at?: string | null;
  link_expired?: boolean;
  amount_due?: number | null;
  breakdown?: PremiumBreakdown | null;
  breakdown_due?: PremiumBreakdown | null;
}

export interface PaymentRequestResult { ipp: IPP; link: string; emailed: boolean; customer_email: string | null }

export interface PaymentSplit { upfront_pct: number; upfront_amount: number; remaining_pct: number; remaining_amount: number; total: number; message_upfront?: string | null; message_remaining?: string | null }
export interface PremiumBreakdown { base_premium: number; loading_amount: number; policy_fee: number; stamp_duty_amount: number; tax_amount: number; total_premium: number; split?: PaymentSplit | null }

export interface PaymentMethod { code: string; label: string }
export interface PaymentIntent { reference: string; method: string; amount: number; status: string }
type Initiation = { amount: number; payment: PaymentIntent; available_payment_methods: PaymentMethod[] };

// The initial premium is collected on the PROPOSAL, after Start Review and before the underwriting case opens
// (Section 30 of the Insurance Ordinance 2000: "no premium, no risk"). It is keyed by the proposal's policy.

export async function getPolicyIPP(policyId: string): Promise<IPP> {
  return (await api.get(`/tenants/${tenantId()}/policies/${policyId}/ipp`)).data;
}

// Asking again while a request for the same proposal is on its way shares that request, so a window that mounts twice
// (development) never starts two payments with two references.
const initiating = new Map<string, Promise<Initiation>>();

export function initiatePolicyIPP(policyId: string, method?: string): Promise<Initiation> {
  const key = `${policyId}|${method ?? ""}`;
  const running = initiating.get(key);
  if (running) return running;
  const request = runOperation(browserOperationScope(), `ipp-initiate:${policyId}`, async operationKey =>
    (await api.post(`/tenants/${tenantId()}/policies/${policyId}/ipp/initiate`, { method }, {headers: operationHeaders(operationKey)})).data as Initiation)
    .finally(() => initiating.delete(key));
  initiating.set(key, request);
  return request;
}

export async function confirmPolicyIPP(policyId: string, opts: { method?: string; reference?: string; realize?: boolean } = {}): Promise<IPP> {
  return runOperation(browserOperationScope(), `ipp-confirm:${policyId}`, async operationKey =>
    (await api.post(`/tenants/${tenantId()}/policies/${policyId}/ipp/confirm`, { realize: true, ...opts },
      { headers: operationHeaders(operationKey) })).data);

}

/** Ask the customer to pay: sends them a secure link by email (and shows it in their walk-in portal). Calling it again renews the link. */
export async function requestPolicyPayment(policyId: string): Promise<PaymentRequestResult> {
  return keyedPost(api, `ipp-request:${policyId}`, `/tenants/${tenantId()}/policies/${policyId}/ipp/request`);
}

/** Staff decision on the customer's payment screenshot. Accepting it clears the initial premium. */
export async function reviewPolicyProof(policyId: string, decision: "accept" | "reject", note?: string): Promise<IPP> {
  return keyedPost(api, `ipp-review:${policyId}`, `/tenants/${tenantId()}/policies/${policyId}/ipp/review`, { decision, note });
}

export const proofUrl = (artifactId: string) => `${process.env.NEXT_PUBLIC_API_URL}/tenants/${tenantId()}/artifacts/${artifactId}/view`;

export interface ReceivedInput { method: string; reference?: string; note?: string }

/** Email the customer a reminder with their payment link (a fresh link if the old one has expired). */
export async function remindPolicyPayment(policyId: string): Promise<PaymentRequestResult> {
  return keyedPost(api, `ipp-remind:${policyId}`, `/tenants/${tenantId()}/policies/${policyId}/ipp/remind`);
}

/** Staff record that the premium has been received (cash, a bank transfer they checked, a customer's message…). Clears it at once. */
export async function markPolicyPaymentReceived(policyId: string, input: ReceivedInput): Promise<IPP> {
  return keyedPost(api, `ipp-received:${policyId}`, `/tenants/${tenantId()}/policies/${policyId}/ipp/mark-received`, input);
}

/** Stop the customer's link working. A new request can be sent later. */
export async function withdrawPolicyPayment(policyId: string): Promise<IPP> {
  return keyedPost(api, `ipp-withdraw:${policyId}`, `/tenants/${tenantId()}/policies/${policyId}/ipp/withdraw`);
}

export interface PaymentReceipt {
  receipt_no: string; received_at: string; amount: number; method: string | null; reference: string | null; confirmed_by: string | null;
  breakdown?: PremiumBreakdown | null;
  customer_name: string | null; plan_label: string | null; insurer: { name: string | null; phone: string | null; email: string | null };
}

/** The plain receipt for the initial premium, once it has been received. */
export async function getPolicyReceipt(policyId: string): Promise<PaymentReceipt> {
  return (await api.get(`/tenants/${tenantId()}/policies/${policyId}/ipp/receipt`)).data;
}
