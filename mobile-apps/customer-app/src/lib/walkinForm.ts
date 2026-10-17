// The walk-in application collects the same information as the insurer's "Add New Customer" form, in the same eight tabs, so
// the lead an agent receives looks exactly like one they entered. Field names are the keys the API expects.

export type Kind = "text" | "tel" | "date" | "number" | "select" | "bool";
export interface FieldDef { name: string; tab: TabId; kind: Kind; required?: boolean; options?: readonly string[]; max?: number; dir?: "ltr"; placeholder?: string; wide?: boolean }

export const TABS = ["demographics", "cnic", "employment", "medical", "habit", "financial", "beneficiary", "plan"] as const;
export type Applicant = "Self" | "Family";
export type TabId = (typeof TABS)[number];

export const PROVINCES = ["Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan", "Islamabad Capital Territory", "Gilgit-Baltistan", "Azad Jammu & Kashmir"] as const;
const RELATION = ["Spouse", "Child", "Parent", "Sibling", "Other"] as const;

export const FIELDS: readonly FieldDef[] = [
  // 1. Identity & Contact
  { name: "first_name", tab: "demographics", kind: "text", required: true, max: 120 },
  { name: "last_name", tab: "demographics", kind: "text", required: true, max: 120 },
  { name: "cnic", tab: "demographics", kind: "text", dir: "ltr", placeholder: "35201-1234567-1", max: 15 },
  { name: "date_of_birth", tab: "demographics", kind: "date", required: true, dir: "ltr" },
  { name: "gender", tab: "demographics", kind: "select", required: true, options: ["Male", "Female", "Other"] },
  { name: "marital_status", tab: "demographics", kind: "select", options: ["Single", "Married", "Divorced", "Widowed"] },
  { name: "mobile_number", tab: "demographics", kind: "tel", required: true, dir: "ltr", placeholder: "+92 300 1234567", max: 30 },
  { name: "emergency_contact_name", tab: "demographics", kind: "text", max: 255 },
  { name: "street_address", tab: "demographics", kind: "text", wide: true, max: 500 },
  { name: "city", tab: "demographics", kind: "text", required: true, max: 100 },
  { name: "province", tab: "demographics", kind: "select", options: PROVINCES },
  { name: "postal_code", tab: "demographics", kind: "text", dir: "ltr", max: 20 },
  // 2. CNIC & Docs
  { name: "cnic_issue_date", tab: "cnic", kind: "date", dir: "ltr" },
  { name: "cnic_expiry_date", tab: "cnic", kind: "date", dir: "ltr" },
  // 3. Occupation & Income
  { name: "employment_type", tab: "employment", kind: "select", options: ["Salaried", "Self-Employed", "Business", "Unemployed", "Retired", "Student"] },
  { name: "occupation", tab: "employment", kind: "text", max: 255 },
  { name: "employer_name", tab: "employment", kind: "text", max: 255 },
  { name: "industry", tab: "employment", kind: "text", max: 255 },
  { name: "years_of_experience", tab: "employment", kind: "number" },
  { name: "occupation_hazard_level", tab: "employment", kind: "select", options: ["Low", "Medium", "High", "VeryHigh"] },
  { name: "declared_annual_income", tab: "employment", kind: "number" },
  { name: "monthly_income", tab: "employment", kind: "number" },
  // 4. Medical & Lifestyle
  { name: "has_pre_existing_conditions", tab: "medical", kind: "bool" },
  { name: "is_smoker", tab: "medical", kind: "bool" },
  { name: "is_diabetic", tab: "medical", kind: "bool" },
  { name: "height_cm", tab: "medical", kind: "number" },
  { name: "weight_kg", tab: "medical", kind: "number" },
  { name: "exercise_frequency", tab: "medical", kind: "select", options: ["Sedentary", "Light", "Moderate", "Active", "VeryActive"] },
  // 5. Habit Check
  { name: "smoking_status", tab: "habit", kind: "select", options: ["Non-smoker", "Occasional", "Heavy Smoker", "Vaper", "Chewing Tobacco"] },
  { name: "alcohol_consumption_frequency", tab: "habit", kind: "select", options: ["None", "Occasional", "Moderate", "Heavy"] },
  { name: "recreational_drug_use_history", tab: "habit", kind: "bool" },
  { name: "participates_in_extreme_sports", tab: "habit", kind: "bool" },
  { name: "private_aviation", tab: "habit", kind: "bool" },
  { name: "frequent_high_risk_travel", tab: "habit", kind: "bool" },
  { name: "moving_violations_past_3_years", tab: "habit", kind: "number" },
  { name: "dui_dwi_history", tab: "habit", kind: "bool" },
  { name: "criminal_record", tab: "habit", kind: "bool" },
  // 6. Financial Profile
  { name: "credit_score", tab: "financial", kind: "number" },
  { name: "delinquency_count", tab: "financial", kind: "number" },
  { name: "risk_grade", tab: "financial", kind: "select", options: ["A", "B", "C", "D", "E", "F"] },
  { name: "number_of_dependents", tab: "financial", kind: "number" },
  { name: "dependent_type", tab: "financial", kind: "select", options: ["Spouse", "Child", "Parent"] },
  // 7. Nominee Details
  { name: "beneficiary_first_name", tab: "beneficiary", kind: "text", max: 120 },
  { name: "beneficiary_last_name", tab: "beneficiary", kind: "text", max: 120 },
  { name: "beneficiary_cnic", tab: "beneficiary", kind: "text", dir: "ltr", placeholder: "35201-1234567-1", max: 15 },
  { name: "beneficiary_relationship", tab: "beneficiary", kind: "select", options: RELATION },
  { name: "beneficiary_share", tab: "beneficiary", kind: "number" },
  // 8. Insurance Plan (plan itself, cover wishes)
  { name: "policy_coverage", tab: "plan", kind: "number" },
  { name: "policy_term", tab: "plan", kind: "number" },
] as const;

export type FormState = Record<string, string | boolean>;

export const emptyForm = (): FormState => {
  const f: FormState = {};
  for (const d of FIELDS) f[d.name] = d.kind === "bool" ? false : "";
  Object.assign(f, { plan_id: "", preferred_contact: "Any", message: "", consent: false });
  return f;
};

export const optionKey = (v: string) => v.replace(/[^A-Za-z0-9]/g, "");

/** Required fields still empty, per tab (the plan tab also needs a chosen plan and consent). */
export function missing(f: FormState): Record<TabId, string[]> {
  const out = Object.fromEntries(TABS.map((t) => [t, [] as string[]])) as Record<TabId, string[]>;
  for (const d of FIELDS) if (d.required && !String(f[d.name] ?? "").trim()) out[d.tab].push(d.name);
  if (!f.plan_id) out.plan.push("plan_id");
  if (!f.consent) out.plan.push("consent");
  return out;
}

/** The profile document the API expects: blanks left out, numbers as numbers. The verified email is never taken from here. */
export function buildProfile(f: FormState): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const d of FIELDS) {
    const v = f[d.name];
    if (d.kind === "bool") { p[d.name] = !!v; continue; }
    const s = String(v ?? "").trim();
    if (!s) continue;
    p[d.name] = d.kind === "number" ? Number(s) : s;
  }
  return p;
}

// ── "For my family": the same three tabs as the insurer's "Add New Family" form ──────────────────────────────

export type FamilyTab = "details" | "policy" | "members";
export const FAMILY_TABS: FamilyTab[] = ["details", "policy", "members"];
export type MemberKind = "Self" | "Spouse" | "Nominee";
export const NOMINEE_RELATIONSHIPS = ["Child", "Parent", "Sibling", "Other"] as const;

export interface FamilyRow {
  kind: MemberKind;
  relationship: string;                 // nominees only: how they are related to the head
  insured: "" | "yes" | "no";           // spouse only: is the spouse fully insured too?
  name: string; cnic: string; dob: string; gender: string; occupation: string; declared_income: string;
  is_smoker: "" | "true" | "false"; height_cm: string; weight_kg: string; coverage_amount: string; share_pct: string;
}
export const blankRow = (kind: MemberKind = "Nominee"): FamilyRow => ({
  kind, relationship: kind === "Nominee" ? "Child" : "", insured: kind === "Self" ? "yes" : "", name: "", cnic: "", dob: "", gender: "", occupation: "",
  declared_income: "", is_smoker: "", height_cm: "", weight_kg: "", coverage_amount: "", share_pct: "",
});
export const startRows = (): FamilyRow[] => [blankRow("Self"), blankRow("Spouse")];
export const isInsured = (r: FamilyRow) => r.kind === "Self" || (r.kind === "Spouse" && r.insured === "yes");

export interface FamilyDetails {
  family_name: string; contact_person: string; contact_phone: string; household_income: string; city: string; province: string;
  kind: "Floater" | "LifeBundle"; sum_insured: string; discount: string; term: string; effective: string;
  plan_id: string; preferred_contact: string; message: string; consent: boolean;
}
export const emptyFamily = (): FamilyDetails => ({
  family_name: "", contact_person: "", contact_phone: "", household_income: "", city: "", province: "", kind: "Floater", sum_insured: "", discount: "",
  term: "1", effective: new Date().toISOString().slice(0, 10), plan_id: "", preferred_contact: "Any", message: "", consent: false,
});

const num = (v: string) => (v.trim() === "" ? 0 : Number(v) || 0);
export const totalShare = (rows: FamilyRow[]) => Math.round(rows.filter((r) => r.kind !== "Self").reduce((n, r) => n + num(r.share_pct), 0) * 100) / 100;

/** What is missing, per tab: `details` and `policy` as field names, `members` as `row.<n>.<field>` plus whole-table problems. */
export function familyGaps(d: FamilyDetails, rows: FamilyRow[]): Record<FamilyTab, string[]> {
  const out: Record<FamilyTab, string[]> = { details: [], policy: [], members: [] };
  if (!d.family_name.trim()) out.details.push("family_name");
  if (d.contact_phone.trim().length < 7) out.details.push("contact_phone");
  if (d.city.trim().length < 2) out.details.push("city");
  if (!d.plan_id) out.policy.push("plan_id");
  if (d.kind === "Floater" && !(num(d.sum_insured) > 0)) out.policy.push("sum_insured");
  if (!(num(d.term) >= 1)) out.policy.push("term");
  if (!d.consent) out.policy.push("consent");
  if (rows.filter((r) => r.kind === "Self").length !== 1) out.members.push("head");
  if (rows.length < 2) out.members.push("count");
  if (rows.filter((r) => r.kind === "Spouse").length > 1) out.members.push("spouse");
  rows.forEach((r, i) => {
    if (r.kind === "Spouse" && r.insured === "") out.members.push(`row.${i}.insured`);
    if (!r.name.trim()) out.members.push(`row.${i}.name`);
    if (r.kind !== "Self" && !(num(r.share_pct) > 0)) out.members.push(`row.${i}.share_pct`);
    if (isInsured(r)) {
      for (const f of ["cnic", "dob", "gender", "occupation", "declared_income"] as const) if (!String(r[f]).trim()) out.members.push(`row.${i}.${f}`);
      if (d.kind === "LifeBundle" && !(num(r.coverage_amount) > 0)) out.members.push(`row.${i}.coverage_amount`);
    }
  });
  const cnics = rows.map((r) => r.cnic.trim()).filter(Boolean);
  if (new Set(cnics).size !== cnics.length) out.members.push("cnic_duplicate");
  if (rows.some((r) => r.kind !== "Self") && Math.abs(totalShare(rows) - 100) > 0.01) out.members.push("shares");
  return out;
}

/** The body the API expects for a family application (blanks left out, numbers as numbers). */
export function buildFamily(d: FamilyDetails, rows: FamilyRow[]): Record<string, unknown> {
  const bundle = d.kind === "LifeBundle";
  return {
    family_name: d.family_name.trim(),
    ...(d.contact_person.trim() ? { contact_person: d.contact_person.trim() } : {}),
    contact_phone: d.contact_phone.trim(),
    ...(d.household_income.trim() ? { household_declared_income: num(d.household_income) } : {}),
    city: d.city.trim(), ...(d.province ? { province: d.province } : {}),
    policy_type: d.kind, term_years: num(d.term) || 1, ...(d.effective ? { effective_date: d.effective } : {}),
    ...(bundle ? (d.discount.trim() ? { discount_percentage: num(d.discount) } : {}) : { total_sum_insured: num(d.sum_insured) }),
    members: rows.map((r) => {
      const ins = isInsured(r);
      const m: Record<string, unknown> = { relationship: r.kind === "Nominee" ? r.relationship : r.kind, name: r.name.trim(), is_insured: ins };
      if (r.kind !== "Self") m.share_pct = num(r.share_pct);
      for (const f of ["cnic", "dob", "gender"] as const) if (r[f].trim()) m[f] = r[f].trim();
      if (ins) {
        m.occupation = r.occupation.trim(); m.declared_income = num(r.declared_income);
        if (r.is_smoker !== "") m.is_smoker = r.is_smoker === "true";
        if (r.height_cm.trim()) m.height_cm = num(r.height_cm);
        if (r.weight_kg.trim()) m.weight_kg = num(r.weight_kg);
        if (bundle) m.coverage_amount = num(r.coverage_amount);
      }
      return m;
    }),
  };
}
