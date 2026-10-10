// Realistic-looking random values for the demo-mode "Fill demo data" buttons
// (see components/DemoFillButton.tsx). Pakistan-flavoured to match the
// insurers the platform is demoed to. Only used when IS_DEMO is true.

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");

const FIRST_NAMES = [
  "Ali", "Ahmed", "Usman", "Bilal", "Hamza", "Hassan", "Imran", "Kashif", "Faisal", "Zeeshan",
  "Ayesha", "Fatima", "Sana", "Hira", "Mahnoor", "Zainab", "Amna", "Nida", "Saba", "Maryam",
];
const LAST_NAMES = [
  "Khan", "Raza", "Qureshi", "Siddiqui", "Malik", "Chaudhry", "Sheikh", "Butt", "Abbasi", "Hashmi",
  "Mirza", "Javed", "Iqbal", "Rehman", "Shah", "Baig", "Farooq", "Aslam", "Anwar", "Haider",
];

const CITIES = [
  { city: "Karachi", cnic: "42101", code: "KHI", province: "Sindh", postal: "74000", areas: ["Shahrah-e-Faisal", "I.I. Chundrigar Road", "Clifton Block 5", "PECHS Block 6", "DHA Phase 6"] },
  { city: "Lahore", cnic: "35202", code: "LHR", province: "Punjab", postal: "54000", areas: ["Gulberg III", "Mall Road", "DHA Phase 5", "Model Town", "Johar Town"] },
  { city: "Islamabad", cnic: "61101", code: "ISB", province: "Islamabad Capital Territory", postal: "44000", areas: ["Blue Area, Jinnah Avenue", "F-7 Markaz", "G-9 Markaz", "I-8 Markaz", "F-10 Markaz"] },
  { city: "Rawalpindi", cnic: "37405", code: "RWP", province: "Punjab", postal: "46000", areas: ["Saddar", "Bahria Town Phase 7", "Satellite Town", "Committee Chowk"] },
  { city: "Faisalabad", cnic: "33100", code: "FSD", province: "Punjab", postal: "38000", areas: ["Kohinoor City", "D Ground, Peoples Colony", "Susan Road", "Jail Road"] },
  { city: "Multan", cnic: "36302", code: "MUX", province: "Punjab", postal: "60000", areas: ["Bosan Road", "Cantt", "Gulgasht Colony", "Nishtar Road"] },
  { city: "Peshawar", cnic: "17301", code: "PEW", province: "Khyber Pakhtunkhwa", postal: "25000", areas: ["University Road", "Saddar Road", "Hayatabad Phase 3", "Khyber Bazaar"] },
  { city: "Quetta", cnic: "54400", code: "UET", province: "Balochistan", postal: "87300", areas: ["Jinnah Road", "Zarghoon Road", "Samungli Road"] },
  { city: "Hyderabad", cnic: "41303", code: "HDD", province: "Sindh", postal: "71000", areas: ["Auto Bhan Road", "Saddar", "Latifabad Unit 7"] },
  { city: "Sialkot", cnic: "34603", code: "SKT", province: "Punjab", postal: "51310", areas: ["Paris Road", "Kashmir Road", "Cantt"] },
] as const;

const COMPANY_PREFIXES = [
  "Crescent", "Indus", "Margalla", "Ravi", "Sapphire", "Karakoram", "Chenab", "Mehran", "Pak-Gulf", "Saadat", "Noor", "Shaheen",
];
const COMPANY_SUFFIXES = ["Life Assurance", "Life Insurance", "Takaful", "General Insurance"];

const ROLES = [
  { name: "Compliance Officer", description: "Reviews cases against SECP regulations and AML/KYC requirements before policy issuance." },
  { name: "Claims Assessor", description: "Investigates submitted claims, verifies supporting documents and recommends payout decisions." },
  { name: "Medical Reviewer", description: "Evaluates medical exam reports and health disclosures to advise underwriters on mortality risk." },
  { name: "Reinsurance Analyst", description: "Prepares facultative referrals and tracks reinsurer decisions on cases above retention limits." },
  { name: "Actuarial Analyst", description: "Maintains premium rate tables and monitors portfolio experience against pricing assumptions." },
  { name: "Bancassurance Coordinator", description: "Manages leads and proposals originating from partner bank branches." },
  { name: "Policy Servicing Officer", description: "Handles endorsements, beneficiary changes, renewals and policyholder service requests." },
  { name: "Fraud Investigator", description: "Flags and investigates suspicious applications and claims for potential fraud." },
  { name: "Branch Operations Manager", description: "Oversees day-to-day branch activity, agent productivity and case turnaround times." },
  { name: "Customer Service Agent", description: "Answers policyholder queries and logs service requests on their behalf." },
];

const isoDate = (fromYear: number, toYear: number) =>
  `${int(fromYear, toYear)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`;

export const demoPerson = () => {
  const i = int(0, FIRST_NAMES.length - 1);
  const first = FIRST_NAMES[i];
  const last = pick(LAST_NAMES);
  // FIRST_NAMES lists male names first, then female — the CNIC's last digit encodes it.
  return { first, last, full: `${first} ${last}`, female: i >= FIRST_NAMES.length / 2 };
};

// CNIC: district prefix - 7 digits - check digit (odd = male, even = female).
export const demoCnic = (districtPrefix: string, female: boolean) =>
  `${districtPrefix}-${digits(7)}-${female ? pick([2, 4, 6, 8]) : pick([1, 3, 5, 7, 9])}`;

export const demoMobile = () => `+92 3${int(0, 4)}${int(0, 9)} ${digits(7)}`;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Admin credentials are emailed, so the address must reach a real inbox.
// Plus-address the signed-in user's own email so the mail lands with them.
export const demoInboxEmail = (person: { first: string; last: string }) => {
  const tag = `${slugify(person.first)}.${slugify(person.last)}.${digits(4)}`;
  let own = "";
  try {
    own = localStorage.getItem("user_email") ?? "";
  } catch {}
  const [local, domain] = own.split("@");
  return local && domain ? `${local.split("+")[0]}+${tag}@${domain}` : `${tag}@example.com`;
};

export const demoTenant = () => {
  const prefix = pick(COMPANY_PREFIXES);
  const suffix = pick(COMPANY_SUFFIXES);
  const name = `${prefix} ${suffix} Ltd.`;
  const domain = `${slugify(prefix)}${slugify(suffix.split(" ")[0])}.com.pk`;
  const loc = pick(CITIES);
  const contact = demoPerson();
  const code = `${prefix.replace(/[^A-Za-z]/g, "").slice(0, 2)}${suffix[0]}${int(10, 99)}`.toUpperCase();
  return {
    name,
    code,
    profile: {
      registration_number: `0${digits(6)}`,
      license_number: `SECP/IC/${int(1995, 2022)}/${digits(3)}`,
      head_office_address: `${pick(["Floor", "Suite", "Plot"])} ${int(1, 30)}, ${pick(loc.areas)}`,
      city: loc.city,
      province: loc.province,
      contact_person: contact.full,
      contact_email: `${slugify(contact.first)}.${slugify(contact.last)}@${domain}`,
      contact_phone: demoMobile(),
      website: `https://www.${domain}`,
      established_date: isoDate(1990, 2020),
    },
  };
};

export const demoBranch = (branchTypes: readonly string[]) => {
  const loc = pick(CITIES);
  const area = pick(loc.areas);
  const branch_type = pick(branchTypes);
  const contact = demoPerson();
  const name =
    branch_type === "HEAD_OFFICE" ? `${loc.city} Head Office`
    : branch_type === "REGIONAL_OFFICE" ? `${loc.province} Regional Office`
    : branch_type === "LIAISON_OFFICE" ? `${loc.city} Liaison Office`
    : `${loc.city} ${area.split(",")[0]} Branch`;
  return {
    branch_code: `${loc.code}-${digits(2)}`,
    name,
    branch_type,
    region: loc.province,
    city: loc.city,
    address: `Office ${int(1, 40)}, ${pick(["Ground", "1st", "2nd", "3rd"])} Floor, ${area}`,
    postal_code: loc.postal,
    contact_person: contact.full,
    contact_phone: demoMobile(),
    contact_email: `${slugify(loc.city)}.${slugify(contact.first)}@example.com`,
    opened_date: isoDate(2005, 2024),
  };
};

// Avoids names already taken so the create request doesn't 409.
export const demoRole = (existingNames: string[]) => {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const free = ROLES.filter((r) => !taken.has(r.name.toLowerCase()));
  if (free.length) return { ...pick(free) };
  const base = pick(ROLES);
  return { ...base, name: `${base.name} ${int(2, 99)}` };
};

const BANKS = [
  "Habib Bank Limited", "MCB Bank Limited", "United Bank Limited", "Meezan Bank", "Bank Alfalah",
  "Allied Bank Limited", "Faysal Bank", "Bank Al Habib",
];
const BROKER_FIRMS = ["Alpha", "Trust", "Premier", "Unity", "Capital", "Prime"];
const CORPORATE_AGENTS = ["Shield Corporate Services", "Apex Insurance Solutions", "Pak Assurance Associates", "Horizon Risk Partners"];
// Channel → the platform it runs on (the "partner" for a digital source).
const DIGITAL_CHANNELS = [
  { name: "Company Website", partner: "In-house Web Portal" },
  { name: "Mobile App", partner: "In-house Mobile App" },
  { name: "Facebook Lead Ads", partner: "Meta Platforms" },
  { name: "Google Ads", partner: "Google" },
  { name: "WhatsApp Business", partner: "Meta Platforms" },
  { name: "Daraz Insurance Mall", partner: "Daraz" },
];
// The agency an individual agent works under.
const AGENCIES = ["Elite Sales Agency", "Prime Life Agency", "Pinnacle Insurance Agency", "Golden Shield Agency"];

const SOURCE_CODE_PREFIX: Record<string, string> = {
  AGENT: "AGT", BROKER: "BRK", BANCASSURANCE: "BNK", CORPORATE_AGENT: "CRP", DIRECT: "WLK", DIGITAL: "DIG",
};

// An acquisition source of the given type (AGENT, BROKER, BANCASSURANCE, ...).
// The contact email gets the login credentials, so it routes to the signed-in user's inbox.
export const demoAcquisitionSource = (sourceType: string) => {
  const loc = pick(CITIES);
  const area = pick(loc.areas).split(",")[0];
  const contact = demoPerson();
  let name: string;
  let partner_name = "";
  switch (sourceType) {
    case "AGENT":
      name = contact.full;
      partner_name = `${pick(AGENCIES)} — ${loc.city}`;
      break;
    case "BROKER":
      name = `${pick(BROKER_FIRMS)} Insurance Brokers (Pvt) Ltd.`;
      partner_name = name;
      break;
    case "BANCASSURANCE":
      partner_name = pick(BANKS);
      name = `${partner_name} — ${area} Branch`;
      break;
    case "CORPORATE_AGENT":
      name = `${pick(CORPORATE_AGENTS)} (Pvt) Ltd.`;
      partner_name = name;
      break;
    case "DIRECT":
      name = `${loc.city} ${area} Walk-in Desk`;
      partner_name = `${loc.city} Customer Service Centre`;
      break;
    default: {
      const channel = pick(DIGITAL_CHANNELS);
      name = channel.name;
      partner_name = channel.partner;
    }
  }
  return {
    source_type: sourceType,
    name,
    code: `${SOURCE_CODE_PREFIX[sourceType] ?? "SRC"}-${digits(4)}`,
    partner_name,
    contact_person: contact.full,
    contact_phone: demoMobile(),
    contact_email: demoInboxEmail(contact),
    city: loc.city,
    cnic: demoCnic(loc.cnic, contact.female),
    location: area,
    is_active: true,
  };
};

// ── Leads: individual / family / corporate ───────────────────────────────────
// These return the same shapes the document reader (ocr-engine /extract-*) returns,
// so the full-entry forms run demo data through their existing "fill from document"
// path instead of a second, hand-wired one.

const OCCUPATIONS = [
  { title: "Software Engineer", industry: "Information Technology", employer: "Systems Limited", income: [2_400_000, 6_000_000], hazard: "Low" },
  { title: "Bank Officer", industry: "Banking & Finance", employer: "Meezan Bank", income: [1_800_000, 4_200_000], hazard: "Low" },
  { title: "Civil Engineer", industry: "Construction", employer: "Descon Engineering", income: [2_000_000, 5_000_000], hazard: "Medium" },
  { title: "Doctor", industry: "Healthcare", employer: "Shaukat Khanum Memorial Hospital", income: [3_600_000, 9_000_000], hazard: "Low" },
  { title: "School Teacher", industry: "Education", employer: "Beaconhouse School System", income: [900_000, 1_800_000], hazard: "Low" },
  { title: "Textile Merchant", industry: "Textiles", employer: "Self", income: [3_000_000, 8_000_000], hazard: "Low" },
  { title: "Pharmacist", industry: "Pharmaceuticals", employer: "Getz Pharma", income: [1_500_000, 3_000_000], hazard: "Low" },
  { title: "Sales Manager", industry: "FMCG", employer: "Unilever Pakistan", income: [2_400_000, 5_400_000], hazard: "Low" },
];

const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const todayIso = () => new Date().toISOString().slice(0, 10);
/** A date of birth for someone `age` years old today. */
const dobForAge = (age: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  d.setMonth(int(0, 11), int(1, 28));
  if (d > new Date()) d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
};

/** Name + phone for the quick-lead forms. */
export const demoQuickLead = () => {
  const p = demoPerson();
  return { first: p.first, last: p.last, full: p.full, phone: demoMobile() };
};

export const demoFamilyName = () => {
  const last = pick(LAST_NAMES);
  const head = pick(FIRST_NAMES.slice(0, FIRST_NAMES.length / 2)); // male names come first
  return { familyName: `${last} Family`, contactPerson: `${head} ${last}`, phone: demoMobile() };
};

export const demoCompanyQuick = () => {
  const p = demoPerson();
  return { name: pick(COMPANIES).name, contactPerson: `${p.full} (HR Manager)`, phone: demoMobile() };
};

interface PlanLike {
  label: string; insurance_type: string; category?: string; is_active?: boolean;
  term_min_years: number; term_max_years: number; entry_age_min: number; entry_age_max: number; max_income_multiple?: number;
}

/**
 * Every field the individual full-entry form reads from a document (CustomerFormModal's
 * `data.fields`). Age, term and coverage are fitted to a plan from `plans` so the
 * plan checks pass on save.
 */
export const demoCustomerFields = (plans: PlanLike[]) => {
  const person = demoPerson();
  const loc = pick(CITIES);
  const job = pick(OCCUPATIONS);
  const eligible = plans.filter(
    (p) => p.category !== "Group" && p.category !== "Family" && p.insurance_type !== "CHILD_EDUCATION_MARRIAGE" && p.is_active !== false
  );
  const plan = eligible.length ? pick(eligible) : undefined;

  const ageLo = Math.max(25, plan?.entry_age_min ?? 25);
  const ageHi = Math.min(50, plan?.entry_age_max ?? 50);
  const age = int(ageLo, Math.max(ageLo, ageHi));
  const income = roundTo(int(job.income[0], job.income[1]), 60_000);
  const term = plan ? Math.min(plan.term_max_years, Math.max(plan.term_min_years, pick([10, 15, 20]))) : 10;
  const coverage = roundTo(income * Math.min(plan?.max_income_multiple || 10, int(5, 10)), 100_000);
  const married = age >= 28 && Math.random() < 0.8;
  const spouse = demoPerson();
  const issued = new Date();
  issued.setFullYear(issued.getFullYear() - int(1, 6));
  const expiry = new Date(issued);
  expiry.setFullYear(expiry.getFullYear() + 10);
  const smoker = Math.random() < 0.2;
  const heightCm = person.female ? int(152, 170) : int(165, 185);

  return {
    first_name: person.first,
    last_name: person.last,
    cnic: demoCnic(loc.cnic, person.female),
    date_of_birth: dobForAge(age),
    gender: person.female ? "Female" : "Male",
    marital_status: married ? "Married" : "Single",
    mobile_number: demoMobile(),
    email: `${person.first}.${person.last}${digits(2)}@gmail.com`.toLowerCase(),
    emergency_contact_name: married ? `${spouse.first} ${person.last}` : `${demoPerson().first} ${person.last}`,
    street_address: `House ${int(1, 300)}, Street ${int(1, 40)}, ${pick(loc.areas)}`,
    postal_code: loc.postal,
    city: loc.city,
    province: loc.province,

    cnic_issue_date: issued.toISOString().slice(0, 10),
    cnic_expiry_date: expiry.toISOString().slice(0, 10),
    cnic_validation_status: "Valid",

    employment_type: job.employer === "Self" ? "Business" : "Salaried",
    occupation: job.title,
    employer_name: job.employer === "Self" ? `${person.last} Traders` : job.employer,
    industry: job.industry,
    years_of_experience: Math.max(1, age - int(22, 25)),
    occupation_hazard_level: job.hazard,
    declared_annual_income: income,
    monthly_income: Math.round(income / 12),
    income_stability_score: int(65, 95),

    has_pre_existing_conditions: false,
    is_smoker: smoker,
    is_diabetic: false,
    height_cm: heightCm,
    weight_kg: Math.round(((heightCm / 100) ** 2) * (int(200, 270) / 10)),
    exercise_frequency: pick(["Light", "Moderate", "Active"]),

    smoking_status: smoker ? "Occasional" : "Non-smoker",
    alcohol_consumption_frequency: "None",
    recreational_drug_use_history: false,
    participates_in_extreme_sports: false,
    private_aviation: false,
    frequent_high_risk_travel: false,
    moving_violations_past_3_years: 0,
    dui_dwi_history: false,
    criminal_record: false,

    credit_score: int(620, 800),
    delinquency_count: 0,
    risk_grade: pick(["A", "B"]),
    number_of_dependents: married ? int(1, 4) : 0,
    dependent_type: married ? "Spouse" : "Parent",

    beneficiary_first_name: married ? spouse.first : demoPerson().first,
    beneficiary_last_name: person.last,
    beneficiary_cnic: demoCnic(loc.cnic, married ? !person.female : spouse.female),
    beneficiary_relationship: married ? "Spouse" : "Parent",
    beneficiary_share: 100,

    insurance_plan_name: plan?.label ?? "",
    policy_coverage: plan ? coverage : "",
    policy_term: plan ? term : "",
  };
};

/**
 * A household for the family full-entry form (FamilyFullEntryModal's extract-family
 * shape): an insured head and spouse on a health floater, plus two children as nominees.
 */
export const demoFamilyExtraction = () => {
  const loc = pick(CITIES);
  const last = pick(LAST_NAMES);
  const maleFirst = FIRST_NAMES.slice(0, FIRST_NAMES.length / 2);
  const femaleFirst = FIRST_NAMES.slice(FIRST_NAMES.length / 2);
  const headFirst = pick(maleFirst);
  const spouseFirst = pick(femaleFirst);
  const headJob = pick(OCCUPATIONS);
  const spouseJob = pick(OCCUPATIONS);
  const headIncome = roundTo(int(headJob.income[0], headJob.income[1]), 60_000);
  const spouseIncome = roundTo(int(spouseJob.income[0], spouseJob.income[1]) / 2, 60_000);
  const headAge = int(32, 48);
  const insured = (first: string, female: boolean, age: number, job: (typeof OCCUPATIONS)[number], income: number, relationship: string, share?: number) => {
    const h = female ? int(152, 168) : int(165, 183);
    return {
      relationship, name: `${first} ${last}`, cnic: demoCnic(loc.cnic, female), dob: dobForAge(age),
      gender: female ? "Female" : "Male", occupation: job.title, declared_income: income,
      is_insured: true, is_smoker: !female && Math.random() < 0.2,
      height_cm: h, weight_kg: Math.round(((h / 100) ** 2) * (int(210, 260) / 10)),
      ...(share !== undefined ? { share_pct: share } : {}),
    };
  };
  const child = (age: number, share: number) => {
    const female = Math.random() < 0.5;
    return {
      relationship: "Child", name: `${pick(female ? femaleFirst : maleFirst)} ${last}`, dob: dobForAge(age),
      gender: female ? "Female" : "Male", is_insured: false, share_pct: share,
    };
  };
  const members = [
    insured(headFirst, false, headAge, headJob, headIncome, "Self"),
    insured(spouseFirst, true, headAge - int(2, 6), spouseJob, spouseIncome, "Spouse", 50),
    child(int(8, 14), 25),
    child(int(2, 7), 25),
  ];
  return {
    family: {
      family_name: `${last} Family`,
      contact_person: `${headFirst} ${last}`,
      contact_email: demoInboxEmail({ first: headFirst, last }),
      contact_phone: demoMobile(),
      household_declared_income: headIncome + spouseIncome,
      city: loc.city,
      province: loc.province,
      policy_type: "Floater",
      term_years: 1,
      effective_date: todayIso(),
      total_sum_insured: pick([3_000_000, 5_000_000, 7_500_000]),
    },
    members,
    found: 11 + members.length * 6,
  };
};

const COMPANIES = [
  { name: "Indus Textile Mills (Pvt) Ltd.", industry: "Textiles" },
  { name: "Margalla Software House (Pvt) Ltd.", industry: "Information Technology" },
  { name: "Ravi Pharmaceuticals Ltd.", industry: "Pharmaceuticals" },
  { name: "Karakoram Logistics (Pvt) Ltd.", industry: "Logistics" },
  { name: "Mehran Foods Ltd.", industry: "Food & Beverages" },
  { name: "Chenab Cement Industries Ltd.", industry: "Construction Materials" },
];
const CORP_ROLES = [
  { title: "Manager", designation: "Manager", grade: "M1", cls: "Management", salary: [350_000, 600_000] },
  { title: "Senior Engineer", designation: "Senior Engineer", grade: "E3", cls: "Staff", salary: [220_000, 380_000] },
  { title: "Engineer", designation: "Engineer", grade: "E2", cls: "Staff", salary: [140_000, 240_000] },
  { title: "Accountant", designation: "Accountant", grade: "E2", cls: "Staff", salary: [120_000, 200_000] },
  { title: "Officer", designation: "Officer", grade: "E1", cls: "Staff", salary: [90_000, 150_000] },
];

/**
 * A company with a Group Life scheme for the corporate full-entry form
 * (OrganizationFullEntryModal's extract-organization shape): two benefit classes,
 * a 12-employee census (Group Life needs at least 10), and dependants and
 * nominees for a few of the employees.
 */
export const demoOrganizationExtraction = () => {
  const loc = pick(CITIES);
  const company = pick(COMPANIES);
  const hr = demoPerson();
  const domain = `${company.name.split(" ")[0].toLowerCase()}.com.pk`;
  const used = new Set<string>();
  const employees = Array.from({ length: 12 }, (_, i) => {
    const p = demoPerson();
    const role = i < 2 ? CORP_ROLES[0] : pick(CORP_ROLES.slice(1));
    const salary = roundTo(int(role.salary[0], role.salary[1]), 5_000);
    let cnic = demoCnic(loc.cnic, p.female);
    while (used.has(cnic)) cnic = demoCnic(loc.cnic, p.female);
    used.add(cnic);
    const h = p.female ? int(152, 168) : int(165, 183);
    const age = int(24, 55);
    const joined = new Date();
    joined.setFullYear(joined.getFullYear() - int(1, Math.max(1, age - 23)));
    return {
      employee_id: `EMP-${String(1001 + i)}`, cnic, name: p.full, dob: dobForAge(age), gender: p.female ? "Female" : "Male",
      occupation: role.title, declared_income: salary * 12, designation: role.designation, grade: role.grade,
      joining_date: joined.toISOString().slice(0, 10), basic_monthly_salary: salary, benefit_class: role.cls,
      is_smoker: Math.random() < 0.15, height_cm: h, weight_kg: Math.round(((h / 100) ** 2) * (int(210, 270) / 10)),
      _last: p.last, _female: p.female,
    };
  });
  const dependants: any[] = [];
  const nominees: any[] = [];
  employees.slice(0, 4).forEach((e) => {
    const spouseFirst = pick(e._female ? FIRST_NAMES.slice(0, 10) : FIRST_NAMES.slice(10));
    dependants.push({ employee_ref: e.employee_id, name: `${spouseFirst} ${e._last}`, relationship: "Spouse", dob: dobForAge(int(25, 50)), gender: e._female ? "Male" : "Female", covered_amount: 500_000 });
    nominees.push({ employee_ref: e.employee_id, name: `${spouseFirst} ${e._last}`, relationship: "Spouse", share_pct: 100, is_minor: false });
  });
  return {
    company: {
      name: company.name, registration_number: `${digits(7)}-${digits(1)}`, industry: company.industry,
      contact_person: hr.full, contact_email: demoInboxEmail(hr).replace("@example.com", `@${domain}`), contact_phone: demoMobile(),
      city: loc.city, province: loc.province,
    },
    policy: { plan_name: "Group Life", sum_assured_multiple: 24, term_years: 1, effective_date: todayIso() },
    classes: [
      { name: "Management", basis: "SalaryMultiple", salary_multiple: 36, grades: ["M1"], is_default: false,
        coverages: [{ coverage_type: "AccidentalDeath", percent_of_base: 100 }] },
      { name: "Staff", basis: "SalaryMultiple", salary_multiple: 24, grades: ["E1", "E2", "E3"], is_default: true, coverages: [] },
    ],
    employees: employees.map(({ _last, _female, ...e }) => e),
    dependants,
    nominees,
    found: 40,
  };
};
