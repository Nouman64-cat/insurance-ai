import api from "./api";

const tenantId = () =>
  typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

// ─────────────────────────────────────────────────────────────────────────────
// Post-Underwriting — Facultative Reinsurance Referral
//
// Runs after the underwriter has formed a view and before final approval: the
// slice of sum assured above the insurer's retention has to be placed with a
// reinsurer, whose terms then flow back onto the contract.
// ─────────────────────────────────────────────────────────────────────────────

export type ReferralStatus =
  | "NotRequired" | "Required" | "Submitted" | "Quoted"
  | "Accepted" | "Declined" | "Withdrawn";

export type ReinsurerDecision =
  | "Accept" | "AcceptWithLoading" | "AcceptWithExclusion" | "Postpone" | "Decline";

export interface Reinsurer {
  id: string;
  code: string;
  name: string;
  country: string | null;
  am_best_rating: string | null;
  contact_email: string | null;
  is_lead: boolean;
  treaty_capacity: number;
  facultative_capacity: number;
  typical_response_days: number;
  is_active: boolean;
}

export interface Cession {
  total_sum_assured: number;
  retention_limit: number;
  treaty_capacity: number;
  automatic_capacity: number;
  retained_amount: number;
  treaty_ceded_amount: number;
  facultative_ceded_amount: number;
  total_ceded_amount: number;
  cession_pct: number;
  referral_required: boolean;
  referral_type: "Treaty" | "Facultative";
  reinsurance_premium: number;
}

export interface ExpectedTerms {
  basis: string;
  expected_decision: ReinsurerDecision;
  expected_extra_mortality_pct: number;
  expected_loading_over_standard_pct: number;
  expected_exclusions: string[];
  drivers: string[];
}

export interface Referral {
  id: string;
  status: ReferralStatus;
  referral_type: "Treaty" | "Facultative";
  total_sum_assured: number;
  retention_limit: number;
  retained_amount: number;
  treaty_ceded_amount: number;
  facultative_ceded_amount: number;
  cession_pct: number | null;
  reinsurance_premium: number | null;
  reinsurer: Reinsurer | null;
  slip: Record<string, any> | null;
  submitted_at: string | null;
  submitted_by: string | null;
  response_due_at: string | null;
  reinsurer_decision: ReinsurerDecision | null;
  reinsurer_reference: string | null;
  extra_mortality_pct: number | null;
  extra_premium_per_mille: number | null;
  imposed_exclusions: string[];
  reinsurer_conditions: string | null;
  responded_at: string | null;
  terms_applied: boolean;
  terms_applied_at: string | null;
  applied_counter_offer_id: string | null;
  created_at: string;
}

export interface ReinsuranceView {
  policy_id: string;
  policy_status: string;
  cession: Cession;
  referral_required: boolean;
  can_refer: boolean;
  referral: Referral | null;
  expected_terms: ExpectedTerms;
  panel: Reinsurer[];
}

export async function getReinsurance(policyId: string): Promise<ReinsuranceView> {
  const res = await api.get(`/tenants/${tenantId()}/policies/${policyId}/reinsurance`);
  return res.data;
}

export async function referToReinsurer(
  policyId: string,
  body: { reinsurer_id: string; underwriter_note?: string },
): Promise<{ policy_status: string; referral: Referral }> {
  const res = await api.post(`/tenants/${tenantId()}/policies/${policyId}/reinsurance/refer`, body);
  return res.data;
}

export async function recordReinsurerResponse(
  policyId: string,
  body: {
    decision: ReinsurerDecision;
    reinsurer_reference?: string;
    extra_mortality_pct?: number;
    extra_premium_per_mille?: number;
    exclusions?: string[];
    conditions?: string;
  },
): Promise<Referral> {
  const res = await api.post(`/tenants/${tenantId()}/policies/${policyId}/reinsurance/response`, body);
  return res.data;
}

export async function applyReinsurerTerms(
  policyId: string,
  body: { valid_days?: number; note?: string } = {},
): Promise<{ policy_status: string; counter_offer_id: string | null; referral: Referral }> {
  const res = await api.post(`/tenants/${tenantId()}/policies/${policyId}/reinsurance/apply`, body);
  return res.data;
}

export async function withdrawReferral(
  policyId: string,
  reason?: string,
): Promise<{ policy_status: string; referral: Referral }> {
  const res = await api.post(`/tenants/${tenantId()}/policies/${policyId}/reinsurance/withdraw`, { reason });
  return res.data;
}

export async function listReinsurers(): Promise<Reinsurer[]> {
  const res = await api.get(`/tenants/${tenantId()}/reinsurers`);
  return res.data;
}
