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
  { city: "Karachi", code: "KHI", province: "Sindh", postal: "74000", areas: ["Shahrah-e-Faisal", "I.I. Chundrigar Road", "Clifton Block 5", "PECHS Block 6", "DHA Phase 6"] },
  { city: "Lahore", code: "LHR", province: "Punjab", postal: "54000", areas: ["Gulberg III", "Mall Road", "DHA Phase 5", "Model Town", "Johar Town"] },
  { city: "Islamabad", code: "ISB", province: "Islamabad Capital Territory", postal: "44000", areas: ["Blue Area, Jinnah Avenue", "F-7 Markaz", "G-9 Markaz", "I-8 Markaz", "F-10 Markaz"] },
  { city: "Rawalpindi", code: "RWP", province: "Punjab", postal: "46000", areas: ["Saddar", "Bahria Town Phase 7", "Satellite Town", "Committee Chowk"] },
  { city: "Faisalabad", code: "FSD", province: "Punjab", postal: "38000", areas: ["Kohinoor City", "D Ground, Peoples Colony", "Susan Road", "Jail Road"] },
  { city: "Multan", code: "MUX", province: "Punjab", postal: "60000", areas: ["Bosan Road", "Cantt", "Gulgasht Colony", "Nishtar Road"] },
  { city: "Peshawar", code: "PEW", province: "Khyber Pakhtunkhwa", postal: "25000", areas: ["University Road", "Saddar Road", "Hayatabad Phase 3", "Khyber Bazaar"] },
  { city: "Quetta", code: "UET", province: "Balochistan", postal: "87300", areas: ["Jinnah Road", "Zarghoon Road", "Samungli Road"] },
  { city: "Hyderabad", code: "HDD", province: "Sindh", postal: "71000", areas: ["Auto Bhan Road", "Saddar", "Latifabad Unit 7"] },
  { city: "Sialkot", code: "SKT", province: "Punjab", postal: "51310", areas: ["Paris Road", "Kashmir Road", "Cantt"] },
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
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  return { first, last, full: `${first} ${last}` };
};

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
