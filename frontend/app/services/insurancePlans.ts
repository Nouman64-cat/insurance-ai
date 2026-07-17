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

export async function deleteInsurancePlan(tenantId: string, planId: string): Promise<void> {
  await api.delete(`${base(tenantId)}/${planId}`);
}

export async function seedDefaultPlans(tenantId: string): Promise<InsurancePlan[]> {
  const resp = await api.post<InsurancePlan[]>(`${base(tenantId)}/seed-defaults`, {});
  return resp.data;
}
