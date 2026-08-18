import { ComparisonOperator, ImpactType } from "@/app/services/ruleEngine";

// Plain-English field translations for non-technical users. Any field_name
// not listed here just renders as-is (still readable — field names are
// snake_case, e.g. "annual_premium").
export const FIELD_LABELS: Record<string, string> = {
  age: "Applicant Age",
  entry_age: "Entry Age",
  sum_assured: "Sum Assured",
  proposed_sum_assured: "Proposed Sum Assured",
  tsar_accumulated: "Total Sum At Risk (TSAR)",
  total_sum_at_risk: "Total Sum At Risk (TSAR)",
  declared_income: "Declared Annual Income",
  is_smoker: "Smoker Status",
  sanctions_matched: "UN / SECP Sanctions Match",
  is_pep: "Politically Exposed Person (PEP)",
  annual_premium: "Annual Premium",
  category: "Policy Category",
  policy_year: "Policy Duration Year",
  premium_type: "Premium Type",
  bmi: "Body Mass Index (BMI)",
  composite_score: "AI Risk Score (0-100)",
  score: "Insurance History Score",
  occupation: "Occupation",
  has_adverse_disclosure: "Adverse Disclosure on E-Application",
  facultative_required: "Facultative Reinsurance Required",
  e_application_status: "E-Application Status",
  acr_status: "Agent's Confidential Report Status",
  compliance_status: "Compliance Screen Status",
  ipp_status: "Initial Premium Payment Status",
  insurance_history_status: "Insurance History Status",
  medical_status: "Medical Requirement Status",
  role: "User Role",
  action: "Action",
  age_in_entry_band: "Age Within Entry Band",
  term_in_band: "Term Within Band",
  maturity_age_ok: "Maturity Age OK",
  coverage_within_multiple: "Coverage Within Income Multiple",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] || field;
}

export const OPERATOR_TEXT: Record<ComparisonOperator, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  between: "between",
  in_set: "in",
  contains: "contains",
  field_gt: ">",
  field_gte: ">=",
};

export const OPERATOR_OPTIONS: { value: ComparisonOperator; label: string }[] = [
  { value: "eq", label: "Is equal to" },
  { value: "neq", label: "Is not equal to" },
  { value: "gt", label: "Is greater than" },
  { value: "gte", label: "Is at least (≥)" },
  { value: "lt", label: "Is less than" },
  { value: "lte", label: "Is at most (≤)" },
  { value: "between", label: "Is between" },
  { value: "in_set", label: "Is one of (list)" },
  { value: "contains", label: "Contains the text" },
  { value: "field_gt", label: "Is greater than another field ×" },
  { value: "field_gte", label: "Is at least another field ×" },
];

export const CROSS_FIELD_OPERATORS: ComparisonOperator[] = ["field_gt", "field_gte"];
export const RANGE_OPERATORS: ComparisonOperator[] = ["between"];
export const LIST_OPERATORS: ComparisonOperator[] = ["in_set"];

export const IMPACT_TYPE_LABELS: Record<ImpactType, { label: string; badge: string }> = {
  AUTO_APPROVE: { label: "Auto-Approve", badge: "bg-slate-100 text-slate-700 border-slate-200" },
  REQUIRE_MEDICAL: { label: "Require Panel Medical Exam", badge: "bg-blue-50 text-blue-700 border-blue-200" },
  APPLY_LOADING: { label: "Apply Premium Loading / Rate", badge: "bg-blue-50 text-blue-700 border-blue-200" },
  EXCLUSION_CLAUSE: { label: "Attach Exclusion Rider", badge: "bg-amber-50 text-amber-700 border-amber-200" },
  FINANCIAL_JUSTIFICATION: { label: "Require Financial Justification (EDD)", badge: "bg-amber-50 text-amber-700 border-amber-200" },
  REFER_TO_UNDERWRITER: { label: "Refer to Senior Underwriter", badge: "bg-blue-50 text-blue-700 border-blue-200" },
  REINSURANCE_FACULTATIVE: { label: "Facultative Reinsurance Referral", badge: "bg-purple-50 text-purple-700 border-purple-200" },
  DECLINE: { label: "Decline Application", badge: "bg-red-50 text-red-700 border-red-200" },
};

export function formatValue(val: any): string {
  if (val === true) return "Yes";
  if (val === false) return "No";
  if (val === null || val === undefined) return "";
  if (typeof val === "number") return val.toLocaleString();
  if (Array.isArray(val)) return val.map((v) => String(v)).join(", ");
  return String(val);
}

export function criterionSentence(c: {
  field_name: string;
  operator: ComparisonOperator;
  value_numeric?: number | null;
  value_string?: string | null;
  value_range_min?: number | null;
  value_range_max?: number | null;
  value_list?: any[] | null;
  target_field_name?: string | null;
  target_multiplier?: number;
}): string {
  const field = fieldLabel(c.field_name);
  const op = OPERATOR_TEXT[c.operator] || c.operator;

  if (c.operator === "field_gt" || c.operator === "field_gte") {
    const mult = c.target_multiplier && c.target_multiplier !== 1 ? ` × ${c.target_multiplier}` : "";
    return `${field} ${op} ${fieldLabel(c.target_field_name || "")}${mult}`;
  }
  if (c.operator === "between") {
    return `${field} ${op} ${formatValue(c.value_range_min)} and ${formatValue(c.value_range_max)}`;
  }
  if (c.operator === "in_set") {
    return `${field} ${op} [${formatValue(c.value_list)}]`;
  }
  if (c.value_string !== null && c.value_string !== undefined && c.value_string !== "") {
    return `${field} ${op} "${c.value_string}"`;
  }
  return `${field} ${op} ${formatValue(c.value_numeric)}`;
}
