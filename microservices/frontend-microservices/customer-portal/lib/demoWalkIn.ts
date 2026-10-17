// Fills the whole walk-in application with a believable applicant, to save time when trying the flow out.
// The verified email is not part of the form: it is always the one the visitor signed in with.
import { FamilyDetails, FamilyRow, FormState, blankRow, emptyFamily, emptyForm } from "./walkinForm";
import type { WalkInPlan } from "./types";

const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const MALE = ["Ahmed", "Bilal", "Hamza", "Usman", "Faisal", "Imran", "Kamran", "Zeeshan"];
const FEMALE = ["Ayesha", "Fatima", "Maryam", "Sana", "Hira", "Noor", "Zainab", "Amna"];
const LAST = ["Khan", "Malik", "Raza", "Sheikh", "Qureshi", "Butt", "Chaudhry", "Siddiqui"];
const PLACES = [
  { city: "Lahore", province: "Punjab", postal: "54000", cnic: "35202", area: "Gulberg" },
  { city: "Karachi", province: "Sindh", postal: "75500", cnic: "42101", area: "Clifton" },
  { city: "Islamabad", province: "Islamabad Capital Territory", postal: "44000", cnic: "61101", area: "F-7" },
  { city: "Rawalpindi", province: "Punjab", postal: "46000", cnic: "37405", area: "Satellite Town" },
  { city: "Peshawar", province: "Khyber Pakhtunkhwa", postal: "25000", cnic: "17301", area: "University Town" },
];
const JOBS = [
  { title: "Software Engineer", employer: "Systems Ltd", industry: "Information Technology", hazard: "Low", income: [2_400_000, 4_800_000] },
  { title: "Accountant", employer: "Meezan Bank", industry: "Banking", hazard: "Low", income: [1_500_000, 2_800_000] },
  { title: "Teacher", employer: "City School", industry: "Education", hazard: "Low", income: [900_000, 1_600_000] },
  { title: "Site Engineer", employer: "Descon", industry: "Construction", hazard: "Medium", income: [1_800_000, 3_200_000] },
] as const;

export function demoApplication(plans: WalkInPlan[], preferredPlanId?: string, who: "Self" | "Family" = "Self"): FormState {
  const female = Math.random() < 0.5;
  const first = pick(female ? FEMALE : MALE), last = pick(LAST), place = pick(PLACES), job = pick(JOBS);
  const suitable = who === "Family" ? plans.filter((p) => p.category === "Family") : plans.filter((p) => p.category === "Individual" && p.type !== "CHILD_EDUCATION_MARRIAGE");
  const chosen = suitable.find((p) => p.id === preferredPlanId) ?? (suitable.length ? pick(suitable) : undefined);
  const lo = Math.max(25, chosen?.entry_age_min ?? 25), hi = Math.min(50, chosen?.entry_age_max ?? 50);
  const age = int(lo, Math.max(lo, hi));
  const dob = new Date(); dob.setFullYear(dob.getFullYear() - age); dob.setMonth(int(0, 11)); dob.setDate(int(1, 28));
  const income = Math.round(int(job.income[0], job.income[1]) / 60_000) * 60_000;
  const married = age >= 28 && Math.random() < 0.8;
  const spouse = pick(female ? MALE : FEMALE);
  const h = female ? int(152, 170) : int(165, 185);
  const issued = new Date(); issued.setFullYear(issued.getFullYear() - int(1, 6));
  const expiry = new Date(issued); expiry.setFullYear(expiry.getFullYear() + 10);
  const term = chosen ? Math.min(chosen.term_max_years, Math.max(chosen.term_min_years, pick([10, 15, 20]))) : 10;
  const smoker = Math.random() < 0.15;
  const f = emptyForm();
  Object.assign(f, {
    first_name: first, last_name: last, cnic: `${place.cnic}-${digits(7)}-${female ? 2 : 1}`, date_of_birth: iso(dob), gender: female ? "Female" : "Male",
    marital_status: married ? "Married" : "Single", mobile_number: `+92 3${int(0, 4)}${int(0, 9)} ${digits(7)}`, emergency_contact_name: `${spouse} ${last}`,
    street_address: `House ${int(1, 300)}, Street ${int(1, 40)}, ${place.area}`, city: place.city, province: place.province, postal_code: place.postal,
    cnic_issue_date: iso(issued), cnic_expiry_date: iso(expiry),
    employment_type: "Salaried", occupation: job.title, employer_name: job.employer, industry: job.industry, years_of_experience: String(Math.max(1, age - int(22, 25))),
    occupation_hazard_level: job.hazard, declared_annual_income: String(income), monthly_income: String(Math.round(income / 12)),
    is_smoker: smoker, height_cm: String(h), weight_kg: String(Math.round(((h / 100) ** 2) * (int(200, 260) / 10))), exercise_frequency: pick(["Light", "Moderate", "Active"]),
    smoking_status: smoker ? "Occasional" : "Non-smoker", alcohol_consumption_frequency: "None", moving_violations_past_3_years: "0",
    credit_score: String(int(640, 790)), delinquency_count: "0", risk_grade: pick(["A", "B"]), number_of_dependents: married ? String(int(1, 3)) : "0", dependent_type: married ? "Spouse" : "Parent",
    beneficiary_first_name: spouse, beneficiary_last_name: last, beneficiary_cnic: `${place.cnic}-${digits(7)}-${female ? 1 : 2}`,
    beneficiary_relationship: married ? "Spouse" : "Parent", beneficiary_share: "100",
    plan_id: chosen?.id ?? "", policy_coverage: String(Math.round((income * int(5, 8)) / 100_000) * 100_000), policy_term: String(term),
    preferred_contact: "Phone", message: "Demo application", consent: true,
  });
  return f;
}


/** A whole family application: family details, the policy wanted, and the members (insured head and spouse, two nominee children). */
export function demoFamily(plans: WalkInPlan[], preferredPlanId?: string): { details: FamilyDetails; rows: FamilyRow[] } {
  const family = plans.filter((p) => p.category === "Family");
  const chosen = family.find((p) => p.id === preferredPlanId) ?? (family.length ? pick(family) : undefined);
  const female = Math.random() < 0.15, last = pick(LAST), place = pick(PLACES), job = pick(JOBS);
  const first = pick(female ? FEMALE : MALE), spouseFirst = pick(female ? MALE : FEMALE);
  const income = Math.round(int(job.income[0], job.income[1]) / 60_000) * 60_000;
  const spouseIncome = Math.round(income / 3 / 60_000) * 60_000;
  const dobAge = (age: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - age); d.setMonth(int(0, 11)); d.setDate(int(1, 28)); return iso(d); };
  const headAge = int(32, 46);
  const person = (row: FamilyRow, patch: Partial<FamilyRow>) => Object.assign(row, patch);
  const h = female ? int(152, 168) : int(165, 183);
  const head = person(blankRow("Self"), { name: `${first} ${last}`, cnic: `${place.cnic}-${digits(7)}-${female ? 2 : 1}`, dob: dobAge(headAge), gender: female ? "Female" : "Male",
    occupation: job.title, declared_income: String(income), is_smoker: "false", height_cm: String(h), weight_kg: String(Math.round(((h / 100) ** 2) * (int(210, 260) / 10))) });
  const sh = female ? int(165, 183) : int(152, 168);
  const spouse = person(blankRow("Spouse"), { insured: "yes", name: `${spouseFirst} ${last}`, cnic: `${place.cnic}-${digits(7)}-${female ? 1 : 2}`, dob: dobAge(headAge - int(1, 5)),
    gender: female ? "Male" : "Female", occupation: pick(["Teacher", "Accountant", "Doctor"]), declared_income: String(spouseIncome), is_smoker: "false", height_cm: String(sh),
    weight_kg: String(Math.round(((sh / 100) ** 2) * (int(200, 250) / 10))), share_pct: "50" });
  const kid = (age: number) => person(blankRow("Nominee"), { relationship: "Child", name: `${pick(Math.random() < 0.5 ? MALE : FEMALE)} ${last}`, dob: dobAge(age), share_pct: "25" });
  const details: FamilyDetails = { ...emptyFamily(), family_name: `${last} Family`, contact_person: `${first} ${last}`, contact_phone: `+92 3${int(0, 4)}${int(0, 9)} ${digits(7)}`,
    household_income: String(income + spouseIncome), city: place.city, province: place.province, kind: "Floater", sum_insured: String(pick([3_000_000, 5_000_000, 7_500_000])),
    term: String(chosen ? Math.min(chosen.term_max_years, Math.max(chosen.term_min_years, 1)) : 1), plan_id: chosen?.id ?? "", preferred_contact: "Phone", message: "Demo application", consent: true };
  return { details, rows: [head, spouse, kid(int(8, 14)), kid(int(2, 7))] };
}
