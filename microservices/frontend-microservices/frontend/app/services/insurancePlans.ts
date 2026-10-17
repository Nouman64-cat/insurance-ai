import api from "./api";

export type PlanCategory = "Individual" | "Group" | "Family";
export type ProductCategory = "Conventional" | "Takaful" | "Bancassurance";
export type PlanStatus = "Draft" | "Active" | "Archived";
export type InsuranceType =
  | "TERM_LIFE"
  | "WHOLE_LIFE"
  | "ENDOWMENT"
  | "CHILD_EDUCATION_MARRIAGE"
  | "GROUP_LIFE"
  | "SAVINGS"
  | "SINGLE_PREMIUM"
  | "HEALTH_CASH"
  | "FAMILY_FLOATER";

export interface MedicalExamTier {
  minSumAssured: number;
  tier: string;
}

export interface SurrenderChargeBand {
  from: number;
  through: number | null;
  charge_pct: number;
}

export interface SurrenderTerms {
  status: "verified" | "conflicting_sources" | "not_disclosed" | "not_applicable";
  researched_on: string;
  has_surrender_value: boolean | null;
  schedule_unit: string | null;
  charge_schedule: SurrenderChargeBand[] | null;
  processing_fee_pkr: number | null;
  free_look_days: number | null;
  minimum_full_surrender_months: number | null;
  partial_withdrawal: {
    minimum_inforce_months: number | null;
    maximum_pct_of_net_cash_surrender_value: number;
    maximum_per_year: number | null;
    minimum_remaining_net_cash_surrender_value_pkr: number;
    conditions: string[];
  } | null;
  loan: { maximum_pct_of_net_cash_surrender_value: number; eligibility_text: string | null } | null;
  zero_charge_conditions: {
    minimum_completed_months: number;
    minimum_full_years_premiums_paid?: number;
    minimum_full_years_contributions_paid?: number;
    note?: string;
  } | null;
  notes: string[];
  sources: { url: string; title: string; pages?: number[]; section?: string }[];
  alternative_published_schedules?: {
    source_url: string;
    schedule_unit: string;
    charge_schedule: SurrenderChargeBand[];
  }[];
}

export interface ClaimsTerms {
  status: "published_summary" | "conflicting_sources" | "not_disclosed";
  researched_on: string;
  benefits: { event: string; scope: "base" | "built_in" | "optional_rider" | "plan_benefit"; summary: string; conditions: string[] }[];
  waiting_periods: { summary: string; days: number; applies_to: string }[] | null;
  notification: { days: number; summary: string } | null;
  exclusions: { summary: string; scope: string }[] | null;
  documents: Record<string, { required: string[]; conditional: { document: string; condition: string }[] }>;
  filing: { portal_url: string; steps: string[]; document_authenticity: string; decision_time: string };
  notes: string[];
  not_disclosed: string[];
  sources: { id: string; url: string; title: string; pages?: number[]; section?: string }[];
}

export interface InsurancePlan {
  id: string;
  tenant_id: string;
  code: string;
  label: string;
  insurance_type: InsuranceType;
  category: PlanCategory;
  product_category: ProductCategory;
  partner_bank: string | null;
  status: PlanStatus;
  description: string;
  color: string;
  surrender_terms?: SurrenderTerms | null;
  claims_terms?: ClaimsTerms | null;

  entry_age_min: number;
  entry_age_max: number;
  entry_age_label: string;
  dependent_age_min: number | null;
  dependent_age_max: number | null;

  term_min_years: number;
  term_max_years: number;
  max_maturity_age: number;
  max_income_multiple: number;

  min_group_size: number | null;
  underwriting_basis: string | null;

  medical_exam_tiers: MedicalExamTier[];
  required_documents: string[];

  // Pricing framework — consumed by POST /quote (see routers/quote.py).
  base_premium_rate: number;
  smoker_factor: number;
  rate_version: string;

  /** The plan's uploaded policy wording (PDF), added to each policy's application dossier. */
  policy_wording_filename?: string | null;
  policy_wording_uploaded_at?: string | null;

  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Fields an Admin submits when creating a plan. `code` is immutable after
// creation, so it is absent from the update payload.
export type InsurancePlanCreate = Omit<
  InsurancePlan,
  "id" | "tenant_id" | "is_active" | "created_at" | "updated_at"
>;

export type InsurancePlanUpdate = Partial<Omit<InsurancePlanCreate, "code">> & {
  is_active?: boolean;
};

const base = (tenantId: string) => `/tenants/${tenantId}/insurance-plans`;

export async function listInsurancePlans(tenantId: string): Promise<InsurancePlan[]> {
  const resp = await api.get<InsurancePlan[]>(base(tenantId));
  return resp.data;
}

export async function createInsurancePlan(
  tenantId: string,
  body: InsurancePlanCreate,
): Promise<InsurancePlan> {
  const resp = await api.post<InsurancePlan>(base(tenantId), body);
  return resp.data;
}

export async function updateInsurancePlan(
  tenantId: string,
  planId: string,
  body: InsurancePlanUpdate,
): Promise<InsurancePlan> {
  const resp = await api.patch<InsurancePlan>(`${base(tenantId)}/${planId}`, body);
  return resp.data;
}

export async function uploadPolicyWording(tenantId: string, planId: string, file: File): Promise<InsurancePlan> {
  const form = new FormData();
  form.append("file", file);
  const resp = await api.post<InsurancePlan>(`${base(tenantId)}/${planId}/policy-wording`, form);
  return resp.data;
}

export async function removePolicyWording(tenantId: string, planId: string): Promise<InsurancePlan> {
  const resp = await api.delete<InsurancePlan>(`${base(tenantId)}/${planId}/policy-wording`);
  return resp.data;
}

export async function deleteInsurancePlan(tenantId: string, planId: string): Promise<void> {
  await api.delete(`${base(tenantId)}/${planId}`);
}

export async function seedDefaultPlans(tenantId: string): Promise<InsurancePlan[]> {
  const resp = await api.post<InsurancePlan[]>(`${base(tenantId)}/seed-defaults`, {});
  return resp.data;
}
