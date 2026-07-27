import * as z from "zod";
import { InsurancePlan } from "@/app/services/insurancePlans";
import { ProfileStatus } from "@/app/services/customers";

export type { ProfileStatus };

export const customerCoreSchema = z.object({
  cnic: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  firstName: z.string().min(1, "First Name is required"),
  lastName: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  dob: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  gender: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  maritalStatus: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  nationality: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  occupation: z.union([z.string(), z.null(), z.undefined()]).transform((v) => v ?? ""),
  declaredIncome: z.union([z.coerce.number(), z.string(), z.null(), z.undefined()]).optional(),
  selectedPlanId: z.union([z.string(), z.null(), z.undefined()]).optional(),
  policyCoverage: z.union([z.coerce.number(), z.string(), z.null(), z.undefined()]).optional(),
  policyTerm: z.union([z.coerce.number(), z.string(), z.null(), z.undefined()]).optional(),
  policyDependentName: z.union([z.string(), z.null(), z.undefined()]).optional(),
  policyDependentDob: z.union([z.string(), z.null(), z.undefined()]).optional(),
});

export type CustomerCoreForm = z.infer<typeof customerCoreSchema>;

export function getPlanValidationError(
  plan: InsurancePlan,
  coverage: any,
  term: any,
  declaredIncome?: number | null,
  dob?: string | null,
  dependentName?: string | null,
  dependentDob?: string | null
): string | null {
  if (coverage === undefined || coverage === null || String(coverage).trim() === "" || isNaN(Number(coverage)) || Number(coverage) <= 0) {
    return "Please enter a valid Coverage Amount greater than PKR 0.";
  }
  const coverageNum = Number(coverage);

  if (term === undefined || term === null || String(term).trim() === "" || isNaN(Number(term))) {
    return `Please enter a Policy Term between ${plan.term_min_years} and ${plan.term_max_years} years.`;
  }
  const termNum = Number(term);
  if (termNum < plan.term_min_years || termNum > plan.term_max_years) {
    return `Policy Term (${termNum} yrs) is out of allowed range (${plan.term_min_years}–${plan.term_max_years} yrs) for plan '${plan.label}'.`;
  }

  if (declaredIncome && declaredIncome > 0 && plan.max_income_multiple) {
    const maxAllowed = declaredIncome * plan.max_income_multiple;
    if (coverageNum > maxAllowed) {
      return `Coverage Amount (PKR ${coverageNum.toLocaleString()}) exceeds the maximum allowed limit of PKR ${maxAllowed.toLocaleString()} (${plan.max_income_multiple}× declared income of PKR ${declaredIncome.toLocaleString()}).`;
    }
  }

  if (dob) {
    const birthYear = new Date(dob).getFullYear();
    const currentYear = new Date().getFullYear();
    if (!isNaN(birthYear)) {
      const age = currentYear - birthYear;
      if (age < plan.entry_age_min || age > plan.entry_age_max) {
        return `Customer age (${age} yrs) is outside the allowed entry age range (${plan.entry_age_min}–${plan.entry_age_max} yrs) for plan '${plan.label}'.`;
      }
    }
  }

  if (plan.insurance_type === "CHILD_EDUCATION_MARRIAGE" && !dependentName?.trim()) {
    return "Dependent Name is required for Child Education & Marriage plans.";
  }

  return null;
}

export interface AcquisitionSource {
  id: string;
  source_type: string;
  name: string;
  code: string;
  partner_name?: string | null;
  city?: string | null;
}

export interface Customer {
  id: string;
  tenant_id: string;
  cnic?: string | null;
  name: string;
  dob?: string | null;
  gender?: string | null;
  occupation?: string | null;
  declared_income?: number | null;
  profile_status?: ProfileStatus;
  created_at: string;
  details?: any;
  acquisition_source_id?: string | null;
  acquisition_source?: AcquisitionSource | null;
  branch_id?: string | null;
  assigned_agent_id?: string | null;
  city?: string | null;
  province?: string | null;
}

export interface Policy {
  id: string;
  tenant_id: string;
  customer_id: string;
  product_name: string;
  insurance_type: string;
  coverage_amount: number;
  term_years: number;
  dependent_name: string | null;
  dependent_dob: string | null;
  created_at: string;
}

export const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Direct",
  DIGITAL: "Digital",
};

export const PLAN_TYPE_COLORS: Record<string, string> = {
  TERM_LIFE: "border-emerald-400 bg-emerald-50",
  WHOLE_LIFE: "border-emerald-400 bg-emerald-50",
  ENDOWMENT: "border-emerald-400 bg-emerald-50",
  CHILD_EDUCATION_MARRIAGE: "border-emerald-400 bg-emerald-50",
  GROUP_LIFE: "border-emerald-400 bg-emerald-50",
  SAVINGS: "border-emerald-400 bg-emerald-50",
  SINGLE_PREMIUM: "border-emerald-400 bg-emerald-50",
  HEALTH_CASH: "border-emerald-400 bg-emerald-50",
};

export const PLAN_TYPE_TEXT: Record<string, string> = {
  TERM_LIFE: "text-emerald-700",
  WHOLE_LIFE: "text-emerald-700",
  ENDOWMENT: "text-emerald-700",
  CHILD_EDUCATION_MARRIAGE: "text-emerald-700",
  GROUP_LIFE: "text-emerald-700",
  SAVINGS: "text-emerald-700",
  SINGLE_PREMIUM: "text-emerald-700",
  HEALTH_CASH: "text-emerald-700",
};

export const customerTabs = [
  { id: "demographics", label: "Identity & Contact" },
  { id: "cnic", label: "CNIC & Docs" },
  { id: "employment", label: "Occupation & Income" },
  { id: "medical", label: "Medical & Lifestyle" },
  { id: "habit_check", label: "Habit Check" },
  { id: "financial", label: "Financial Profile" },
  { id: "beneficiary", label: "Nominee Details" },
  { id: "insurance_plan", label: "Insurance Plans" },
];

export const formatCNIC = (value: string): string => {
  const clean = value.replace(/\D/g, "");
  const trimmed = clean.slice(0, 13);
  if (trimmed.length <= 5) {
    return trimmed;
  } else if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 5)}-${trimmed.slice(5)}`;
  } else {
    return `${trimmed.slice(0, 5)}-${trimmed.slice(5, 12)}-${trimmed.slice(12)}`;
  }
};

export const defaultDetails = {
  cnic_metadata: {
    issue_date: "",
    expiry_date: "",
    is_valid: true,
    validation_status: "Valid",
    validated_at: "",
    front_image_url: "",
    back_image_url: "",
    ocr_extracted: false
  },
  address: {
    address_type: "Residential",
    street_address: "",
    area: "",
    city: "",
    district: "",
    province: "",
    country: "Pakistan",
    postal_code: "",
    is_primary: true,
    is_verified: false
  },
  contact: {
    mobile_number: "",
    phone_number: "",
    email: "",
    is_primary: true,
    is_verified: false,
    emergency_contact_name: "",
    emergency_contact_phone: "",
    emergency_contact_relation: ""
  },
  occupation_details: {
    job_title: "",
    employer_name: "",
    industry: "",
    employment_type: "Salaried",
    years_of_experience: 0,
    occupation_hazard_level: "Low",
    work_address: "",
    is_current: true,
    start_date: "",
    end_date: ""
  },
  income_record: {
    monthly_income: 0,
    annual_income: 0,
    declared_income: 0,
    verified_income: 0,
    income_source: "Salary",
    currency: "PKR",
    income_stability_score: 100,
    discrepancy_flag: false,
    is_verified: false
  },
  beneficiary: {
    first_name: "",
    last_name: "",
    cnic_number: "",
    date_of_birth: "",
    relationship: "Spouse",
    share_percentage: 100,
    phone: "",
    email: "",
    address: "",
    is_minor: false,
    guardian_name: "",
    guardian_cnic: "",
    is_active: true
  },
  medical_history: {
    has_pre_existing_conditions: false,
    is_smoker: false,
    is_diabetic: false,
    has_hypertension: false,
    has_heart_disease: false,
    surgical_history: "",
    notes: ""
  },
  conditions: [] as any[],
  family_history: [] as any[],
  lifestyle: {
    smoking_status: "NonSmoker",
    packs_per_day: 0,
    smoking_years: 0,
    quit_smoking_date: "",
    alcohol_status: "None",
    units_per_week: 0,
    height_cm: 0,
    weight_kg: 0,
    bmi: 0,
    exercise_frequency: "Sedentary",
    diet_type: "Regular",
    has_hazardous_hobby: false,
    hazardous_hobby_details: "",
    occupation_hazard_level: "Low"
  },
  financial_records: {
    tax_records: [] as any[],
    bank_statement: {
      bank_name: "",
      average_monthly_balance: 0,
      transaction_volume: 0,
      income_credits: 0,
      expense_debits: 0,
      cash_flow_score: 100,
      anomaly_flag: false
    },
    debts: [] as any[],
    credit_bureau: {
      credit_score: 750,
      credit_history_length: 0,
      delinquency_count: 0,
      default_history: false,
      inquiry_count: 0,
      risk_grade: "A",
      bureau_name: ""
    },
    external_policies: [] as any[],
    dependents: {
      dependent_type: "Child",
      number_of_dependents: 0,
      financial_burden_score: 0,
      dependency_ratio: 0
    }
  },
  habit_check: {
    smoking_status: "Non-smoker",
    alcohol_consumption_frequency: "None",
    recreational_drug_use_history: false,
    participates_in_extreme_sports: false,
    extreme_sports_details: [] as string[],
    private_aviation: false,
    frequent_high_risk_travel: false,
    travel_destinations: [] as string[],
    moving_violations_past_3_years: 0,
    dui_dwi_history: false,
    criminal_record: false
  }
};

export type CustomerDetails = typeof defaultDetails;

export const cloneDefaultDetails = (): CustomerDetails => JSON.parse(JSON.stringify(defaultDetails));
