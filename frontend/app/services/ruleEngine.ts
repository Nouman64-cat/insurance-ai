import api from "./api";

// ── Hierarchy ──────────────────────────────────────────────────────────────

export interface EligibilityProfile {
  id: string;
  channel_code: string;
  min_entry_age: number;
  max_entry_age: number;
  max_maturity_age: number;
  min_sum_assured: number;
}

export interface SubCategory {
  id: string;
  code: string;
  name: string;
  eligibility_profiles: EligibilityProfile[];
}

export interface Category {
  id: string;
  code: string;
  name: string;
  description: string;
  subcategories: SubCategory[];
}

export async function listCategories(tenantId: string): Promise<Category[]> {
  const res = await api.get(`/tenants/${tenantId}/rules/categories`);
  return res.data;
}

export async function createCategory(tenantId: string, body: { code: string; name: string; description?: string }) {
  const res = await api.post(`/tenants/${tenantId}/rules/categories`, body);
  return res.data;
}

export async function createSubCategory(tenantId: string, categoryId: string, body: { code: string; name: string }) {
  const res = await api.post(`/tenants/${tenantId}/rules/categories/${categoryId}/subcategories`, body);
  return res.data;
}

export async function createEligibilityProfile(
  tenantId: string,
  subcategoryId: string,
  body: { channel_code: string; min_entry_age?: number; max_entry_age?: number; max_maturity_age?: number; min_sum_assured?: number }
) {
  const res = await api.post(`/tenants/${tenantId}/rules/subcategories/${subcategoryId}/eligibility-profiles`, body);
  return res.data;
}

// ── Rule sets / versions / rules ─────────────────────────────────────────────

export type ScopeType = "GLOBAL" | "CHANNEL_PRODUCT" | "RIDER";
export type ImpactType =
  | "AUTO_APPROVE"
  | "REQUIRE_MEDICAL"
  | "APPLY_LOADING"
  | "EXCLUSION_CLAUSE"
  | "FINANCIAL_JUSTIFICATION"
  | "REFER_TO_UNDERWRITER"
  | "REINSURANCE_FACULTATIVE"
  | "DECLINE";

export type ComparisonOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "in_set" | "contains" | "field_gt" | "field_gte";

export interface RuleSetSummary {
  id: string;
  rule_code: string;
  name: string;
  description: string;
  scope_type: ScopeType;
  category_code: string | null;
  subcategory_code: string | null;
  channel_code: string | null;
  is_active: boolean;
  active_version_number: string | null;
  active_version_status: string;
  version_count: number;
  rule_count: number;
  updated_at: string;
}

export interface RuleCriteriaDraft {
  group_id: number;
  field_name: string;
  operator: ComparisonOperator;
  value_numeric?: number | null;
  value_string?: string | null;
  value_range_min?: number | null;
  value_range_max?: number | null;
  value_list?: any[] | null;
  target_field_name?: string | null;
  target_multiplier?: number;
}

export interface ActuarialImpactDetail {
  extra_mortality_pct: number;
  flat_extra_per_thousand: number;
  medical_profile_codes: string[];
  hlv_max_multiple: number | null;
  reinsurance_retention_limit: number | null;
  underwriter_authority_level: number | null;
  exclusion_riders: string[];
  is_terminal: boolean;
  commission_pct: number | null;
  withholding_tax_pct: number | null;
}

export const DEFAULT_IMPACT_DATA: ActuarialImpactDetail = {
  extra_mortality_pct: 0,
  flat_extra_per_thousand: 0,
  medical_profile_codes: [],
  hlv_max_multiple: null,
  reinsurance_retention_limit: null,
  underwriter_authority_level: null,
  exclusion_riders: [],
  is_terminal: false,
  commission_pct: null,
  withholding_tax_pct: null,
};

export interface RuleDetail {
  id: string;
  rule_code: string;
  name: string;
  priority: number;
  is_active: boolean;
  affected_from: string | null;
  affected_to: string | null;
  impact_type: ImpactType;
  impact_data: ActuarialImpactDetail;
  action_outcome: string;
  criteria: (RuleCriteriaDraft & { id: string })[];
}

export interface RuleVersionDetail {
  id: string;
  version_number: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  effective_from: string;
  effective_to: string | null;
  authored_by: string;
  approved_by: string | null;
  notes: string | null;
  rules: RuleDetail[];
}

export interface RuleSetDetail extends Omit<RuleSetSummary, "active_version_number" | "active_version_status" | "version_count" | "rule_count" | "updated_at"> {
  versions: RuleVersionDetail[];
}

export async function listRuleSets(
  tenantId: string,
  filters?: { category?: string; subcategory?: string; channel?: string; scope_type?: ScopeType }
): Promise<RuleSetSummary[]> {
  const params = new URLSearchParams();
  if (filters?.category) params.set("category", filters.category);
  if (filters?.subcategory) params.set("subcategory", filters.subcategory);
  if (filters?.channel) params.set("channel", filters.channel);
  if (filters?.scope_type) params.set("scope_type", filters.scope_type);
  const qs = params.toString();
  const res = await api.get(`/tenants/${tenantId}/rules/sets${qs ? `?${qs}` : ""}`);
  return res.data;
}

export async function createRuleSet(
  tenantId: string,
  body: { rule_code: string; name: string; description?: string; scope_type: ScopeType; subcategory_id: string; eligibility_id?: string | null }
) {
  const res = await api.post(`/tenants/${tenantId}/rules/sets`, body);
  return res.data;
}

export async function getRuleSetDetail(tenantId: string, ruleSetId: string): Promise<RuleSetDetail> {
  const res = await api.get(`/tenants/${tenantId}/rules/sets/${ruleSetId}`);
  return res.data;
}

export async function createRuleVersion(tenantId: string, ruleSetId: string) {
  const res = await api.post(`/tenants/${tenantId}/rules/sets/${ruleSetId}/versions`);
  return res.data;
}

export async function updateVersionStatus(tenantId: string, versionId: string, status: "ACTIVE" | "ARCHIVED", approvedBy?: string) {
  const res = await api.patch(`/tenants/${tenantId}/rules/versions/${versionId}/status`, { status, approved_by: approvedBy });
  return res.data;
}

export interface RuleDraft {
  name: string;
  rule_code?: string;
  priority: number;
  is_active: boolean;
  impact_type: ImpactType;
  impact_data: ActuarialImpactDetail;
  action_outcome: string;
  criteria: RuleCriteriaDraft[];
}

export async function addRuleToVersion(tenantId: string, versionId: string, body: RuleDraft) {
  const res = await api.post(`/tenants/${tenantId}/rules/versions/${versionId}/rules`, body);
  return res.data;
}

export async function updateRule(tenantId: string, versionId: string, ruleId: string, body: Partial<RuleDraft>) {
  const res = await api.put(`/tenants/${tenantId}/rules/versions/${versionId}/rules/${ruleId}`, body);
  return res.data;
}

export async function deleteRule(tenantId: string, ruleId: string) {
  await api.delete(`/tenants/${tenantId}/rules/rules/${ruleId}`);
}

// ── Evaluation ────────────────────────────────────────────────────────────

export interface EvaluationResult {
  rule_set_code?: string;
  subcategory_code?: string;
  channel_code?: string | null;
  version_number?: string;
  status: string;
  matched_rule_codes: string[];
  final_impacts: ActuarialImpactDetail;
  reasons?: string[];
  rule_set_results?: EvaluationResult[];
  evaluated_at: string;
}

export interface EvaluateContextOptions {
  customer_id?: string;
  cnic?: string;
  proposed_sum_assured?: number;
  exclude_policy_id?: string;
}

export async function evaluateRuleSet(
  tenantId: string,
  ruleSetCode: string,
  context: Record<string, any>,
  opts?: EvaluateContextOptions & { actor?: string }
): Promise<EvaluationResult> {
  const res = await api.post(`/tenants/${tenantId}/rules/evaluate`, {
    rule_set_code: ruleSetCode,
    context,
    actor: opts?.actor || "Portal Admin",
    ...opts,
  });
  return res.data;
}

export async function evaluateScope(
  tenantId: string,
  subcategoryCode: string,
  channelCode: string | null,
  context: Record<string, any>,
  opts?: EvaluateContextOptions & { actor?: string }
): Promise<EvaluationResult> {
  const res = await api.post(`/tenants/${tenantId}/rules/evaluate-scope`, {
    subcategory_code: subcategoryCode,
    channel_code: channelCode,
    context,
    actor: opts?.actor || "Portal Admin",
    ...opts,
  });
  return res.data;
}

// ── Audit logs ────────────────────────────────────────────────────────────

export interface RuleEvaluationLog {
  id: string;
  rule_set_code: string;
  version_number: string;
  proposal_id: string | null;
  customer_cnic: string | null;
  category_code: string | null;
  subcategory_code: string | null;
  channel_code: string | null;
  actor: string | null;
  input_context_snapshot: Record<string, any>;
  tsar_accumulated: number;
  matched_rule_codes: string[];
  final_impacts: ActuarialImpactDetail;
  reasons: string[];
  execution_duration_ms: number;
  evaluated_at: string;
}

export async function listEvaluationLogs(tenantId: string, limit = 50): Promise<RuleEvaluationLog[]> {
  const res = await api.get(`/tenants/${tenantId}/rules/logs?limit=${limit}`);
  return res.data;
}
