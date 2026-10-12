import { ComparisonOperator, ImpactType } from "@/app/services/ruleEngine";

// ── Validation ─────────────────────────────────────────────────────────────
// Valid formats: medical.nml_grid | commission.secp_rate | aml.sanctions_matrix
// Blocks:        a | RS-MED-001 | ADAM_JEE
export const RULE_CODE_REGEX = /^[a-z][a-z0-9]*(\.[a-z_][a-z0-9_]*)+$/;

// Plain-English field translations for non-technical users.
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
  composite_score: "AI Risk Score (0–100)",
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

export const GROUPED_FIELDS: { group: string; fields: { code: string; label: string }[] }[] = [
  {
    group: "Applicant & Demographics",
    fields: [
      { code: "age", label: "Applicant Age (age)" },
      { code: "entry_age", label: "Entry Age (entry_age)" },
      { code: "is_smoker", label: "Smoker Status (is_smoker)" },
      { code: "bmi", label: "Body Mass Index (bmi)" },
      { code: "occupation", label: "Occupation (occupation)" },
    ],
  },
  {
    group: "Financial & Coverage",
    fields: [
      { code: "sum_assured", label: "Sum Assured (sum_assured)" },
      { code: "proposed_sum_assured", label: "Proposed Sum Assured (proposed_sum_assured)" },
      { code: "tsar_accumulated", label: "Total Sum At Risk (tsar_accumulated)" },
      { code: "total_sum_at_risk", label: "Total Sum At Risk (total_sum_at_risk)" },
      { code: "declared_income", label: "Declared Income (declared_income)" },
      { code: "annual_premium", label: "Annual Premium (annual_premium)" },
      { code: "premium_type", label: "Premium Type (premium_type)" },
    ],
  },
  {
    group: "AI Risk & Underwriting Score",
    fields: [
      { code: "composite_score", label: "AI Risk Score 0–100 (composite_score)" },
      { code: "score", label: "Insurance History Score (score)" },
      { code: "has_adverse_disclosure", label: "Adverse Disclosure (has_adverse_disclosure)" },
      { code: "facultative_required", label: "Facultative Required (facultative_required)" },
    ],
  },
  {
    group: "Compliance & AML",
    fields: [
      { code: "sanctions_matched", label: "UN/SECP Sanctions Match (sanctions_matched)" },
      { code: "is_pep", label: "Politically Exposed Person (is_pep)" },
      { code: "compliance_status", label: "Compliance Status (compliance_status)" },
    ],
  },
  {
    group: "Clearance Gates & Verification",
    fields: [
      { code: "e_application_status", label: "E-App Status (e_application_status)" },
      { code: "acr_status", label: "Agent Confidential Report (acr_status)" },
      { code: "ipp_status", label: "Initial Payment Status (ipp_status)" },
      { code: "insurance_history_status", label: "Insurance History (insurance_history_status)" },
      { code: "medical_status", label: "Medical Requirement (medical_status)" },
    ],
  },
  {
    group: "Policy & Duration",
    fields: [
      { code: "category", label: "Policy Category (category)" },
      { code: "policy_year", label: "Policy Year (policy_year)" },
      { code: "age_in_entry_band", label: "Age In Entry Band (age_in_entry_band)" },
      { code: "term_in_band", label: "Term In Band (term_in_band)" },
      { code: "maturity_age_ok", label: "Maturity Age OK (maturity_age_ok)" },
      { code: "coverage_within_multiple", label: "Within Income Multiple (coverage_within_multiple)" },
    ],
  },
];

export const MEDICAL_PROFILE_OPTIONS = [
  { code: "MER", label: "MER — Medical Examiner's Report" },
  { code: "FBS", label: "FBS — Fasting Blood Sugar" },
  { code: "HbA1c", label: "HbA1c — Glycated Hemoglobin Test" },
  { code: "ECG", label: "ECG — Resting Electrocardiogram" },
  { code: "TMT", label: "TMT — Treadmill Stress Test" },
  { code: "LFT", label: "LFT — Liver Function & Lipid Profile" },
  { code: "RFT", label: "RFT — Renal Function Test" },
  { code: "CBC", label: "CBC — Complete Blood Count" },
  { code: "HIV", label: "HIV / Hepatitis Screening" },
  { code: "Urine_RE", label: "Urine Routine Examination" },
];

export const EXCLUSION_RIDER_OPTIONS = [
  { code: "Aviation_Exclusion", label: "Aviation & Flying Exclusion" },
  { code: "Hazardous_Sports", label: "Extreme & Hazardous Sports Exclusion" },
  { code: "Pre_Existing_Condition", label: "Pre-existing Medical Condition Exclusion" },
  { code: "Occupational_Hazard", label: "High Risk Occupation Exclusion" },
  { code: "Foreign_Travel_War", label: "Active War & High-Risk Travel Exclusion" },
  { code: "Substance_Abuse", label: "Alcohol & Substance Abuse Exclusion" },
];

export const OPERATOR_TEXT: Record<ComparisonOperator, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  in_set: "in",
  contains: "contains",
  field_gt: ">",
  field_gte: "≥",
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
  { value: "contains", label: "Contains text" },
  { value: "field_gt", label: "Is greater than field ×" },
  { value: "field_gte", label: "Is at least field ×" },
];

export const CROSS_FIELD_OPERATORS: ComparisonOperator[] = ["field_gt", "field_gte"];
export const RANGE_OPERATORS: ComparisonOperator[] = ["between"];
export const LIST_OPERATORS: ComparisonOperator[] = ["in_set"];

// ── Impact type config ──────────────────────────────────────────────────────
// icon: inline SVG path(s) as a string — no external dependency
export interface ImpactTypeConfig {
  label: string;
  description: string;
  /** Tailwind bg + text + border classes for badge */
  badge: string;
  /** Tailwind bg + border + text for card (selected state: add ring) */
  cardColor: string;
  /** SVG path d= attribute for a 16x16 viewBox icon */
  iconPath: string;
}

export const IMPACT_TYPE_CONFIG: Record<ImpactType, ImpactTypeConfig> = {
  AUTO_APPROVE: {
    label: "Auto-Approve",
    description: "Automatically approve with no further action required.",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    cardColor: "bg-emerald-50 border-emerald-200 text-emerald-800",
    // checkmark circle
    iconPath: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  REQUIRE_MEDICAL: {
    label: "Require Medical Exam",
    description: "Mandate a panel medical examination before underwriting proceeds.",
    badge: "bg-blue-50 text-blue-700 border-blue-200",
    cardColor: "bg-blue-50 border-blue-200 text-blue-800",
    // heart / medical cross
    iconPath: "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z",
  },
  APPLY_LOADING: {
    label: "Apply Premium Loading",
    description: "Add an extra mortality or flat-rate loading to the base premium.",
    badge: "bg-indigo-50 text-indigo-700 border-indigo-200",
    cardColor: "bg-indigo-50 border-indigo-200 text-indigo-800",
    // trending up
    iconPath: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
  },
  EXCLUSION_CLAUSE: {
    label: "Attach Exclusion Rider",
    description: "Exclude specific conditions or activities from policy coverage.",
    badge: "bg-amber-50 text-amber-700 border-amber-200",
    cardColor: "bg-amber-50 border-amber-200 text-amber-800",
    // shield-exclamation
    iconPath: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  },
  FINANCIAL_JUSTIFICATION: {
    label: "Require Financial Justification",
    description: "Trigger enhanced due diligence (EDD) / financial documentation review.",
    badge: "bg-orange-50 text-orange-700 border-orange-200",
    cardColor: "bg-orange-50 border-orange-200 text-orange-800",
    // document text
    iconPath: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  REFER_TO_UNDERWRITER: {
    label: "Refer to Senior Underwriter",
    description: "Escalate case for manual review by a senior underwriting officer.",
    badge: "bg-violet-50 text-violet-700 border-violet-200",
    cardColor: "bg-violet-50 border-violet-200 text-violet-800",
    // user-check
    iconPath: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  },
  REINSURANCE_FACULTATIVE: {
    label: "Facultative Reinsurance",
    description: "Route case to reinsurer for individual facultative treaty assessment.",
    badge: "bg-purple-50 text-purple-700 border-purple-200",
    cardColor: "bg-purple-50 border-purple-200 text-purple-800",
    // arrows exchange / flow
    iconPath: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4",
  },
  DECLINE: {
    label: "Decline Application",
    description: "Reject the application outright — no policy can be issued.",
    badge: "bg-red-50 text-red-700 border-red-200",
    cardColor: "bg-red-50 border-red-200 text-red-800",
    // x-circle
    iconPath: "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
};

// Kept for backward-compat with any remaining references
export const IMPACT_TYPE_LABELS: Record<ImpactType, { label: string; badge: string }> = Object.fromEntries(
  Object.entries(IMPACT_TYPE_CONFIG).map(([k, v]) => [k, { label: v.label, badge: v.badge }])
) as Record<ImpactType, { label: string; badge: string }>;

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
    return `${field} between ${formatValue(c.value_range_min)} and ${formatValue(c.value_range_max)}`;
  }
  if (c.operator === "in_set") {
    return `${field} in [${formatValue(c.value_list)}]`;
  }
  if (c.value_string !== null && c.value_string !== undefined && c.value_string !== "") {
    return `${field} ${op} "${c.value_string}"`;
  }
  return `${field} ${op} ${formatValue(c.value_numeric)}`;
}

/** Detect overlap between two rules on the same numeric field */
export function detectOverlap(
  criteriaA: { field_name: string; operator: ComparisonOperator; value_numeric?: number | null; value_range_min?: number | null; value_range_max?: number | null }[],
  criteriaB: typeof criteriaA
): string[] {
  const overlapping: string[] = [];
  const fieldsA = new Map<string, { min: number; max: number }>();

  for (const c of criteriaA) {
    if (!c.field_name) continue;
    if (c.operator === "between" && c.value_range_min != null && c.value_range_max != null) {
      fieldsA.set(c.field_name, { min: c.value_range_min, max: c.value_range_max });
    } else if ((c.operator === "gt" || c.operator === "gte") && c.value_numeric != null) {
      fieldsA.set(c.field_name, { min: c.value_numeric, max: Infinity });
    } else if ((c.operator === "lt" || c.operator === "lte") && c.value_numeric != null) {
      fieldsA.set(c.field_name, { min: -Infinity, max: c.value_numeric });
    }
  }

  for (const c of criteriaB) {
    if (!c.field_name || !fieldsA.has(c.field_name)) continue;
    const a = fieldsA.get(c.field_name)!;
    let bMin = -Infinity, bMax = Infinity;
    if (c.operator === "between" && c.value_range_min != null && c.value_range_max != null) {
      bMin = c.value_range_min; bMax = c.value_range_max;
    } else if ((c.operator === "gt" || c.operator === "gte") && c.value_numeric != null) {
      bMin = c.value_numeric;
    } else if ((c.operator === "lt" || c.operator === "lte") && c.value_numeric != null) {
      bMax = c.value_numeric;
    }
    if (a.min <= bMax && bMin <= a.max) {
      overlapping.push(c.field_name);
    }
  }
  return overlapping;
}
