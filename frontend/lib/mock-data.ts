// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AIDecision =
  | "Auto Approve"
  | "Approve with Loading"
  | "Human Review"
  | "Decline";

export interface QueueCase {
  id: string;
  applicantName: string;
  cnic: string;
  age: number;
  occupation: string;
  product: string;
  coverageAmount: number;
  termYears: number;
  submittedAt: string;
  medicalScore: number;
  financialScore: number;
  fraudProbability: number; // 0.0 – 1.0
  compositeScore: number;   // 0 – 100
  aiDecision: AIDecision;
  suggestedLoading: number | null; // % premium loading, null when n/a
}

export interface CaseDetail extends QueueCase {
  dob: string;            // YYYY-MM-DD
  gender: string;
  declaredIncome: number; // annual PKR
  medicalReasons: string[];
  financialReasons: string[];
  fraudReasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

export function fmtCoverage(n: number): string {
  if (n >= 10_000_000) return `PKR ${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000_000)  return `PKR ${(n / 1_000_000).toFixed(1)}M`;
  return `PKR ${(n / 1_000).toFixed(0)}K`;
}

export function fmtIncome(n: number): string {
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(2)}M / yr`;
  return `PKR ${(n / 1_000).toFixed(0)}K / yr`;
}

export function fmtDob(dob: string): string {
  return new Date(dob).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard metrics
// ─────────────────────────────────────────────────────────────────────────────

export const METRICS = {
  totalToday: 210,
  pending: 18,
  autoApproved: 128,
  approvedWithLoading: 29,
  referred: 23,
  declined: 12,
  avgProcessingSeconds: 2.3,
  autoDecisionRate: 75.2,
  avgConfidence: 87.4,
  processed: 192,
};

export const DECISION_DISTRIBUTION = [
  { label: "Auto Approve",        count: 128, pct: 61, colorBar: "bg-emerald-500", colorText: "text-emerald-700" },
  { label: "Approve w/ Loading",  count:  29, pct: 14, colorBar: "bg-amber-400",   colorText: "text-amber-700"   },
  { label: "Human Review",        count:  23, pct: 11, colorBar: "bg-blue-500",    colorText: "text-blue-700"    },
  { label: "Declined",            count:  12, pct:  6, colorBar: "bg-red-500",     colorText: "text-red-700"     },
  { label: "Pending",             count:  18, pct:  9, colorBar: "bg-slate-300",   colorText: "text-slate-500"   },
];

// ─────────────────────────────────────────────────────────────────────────────
// Today's Queue (8 cases across all 4 decision states)
// ─────────────────────────────────────────────────────────────────────────────

export const QUEUE_CASES: QueueCase[] = [
  {
    id: "INS-2026-003",
    applicantName: "Ahmed Raza",
    cnic: "35201-7654321-3",
    age: 55,
    occupation: "Mining Engineer",
    product: "Term Life 30",
    coverageAmount: 15_000_000,
    termYears: 30,
    submittedAt: "09:38 AM",
    medicalScore: 78,
    financialScore: 60,
    fraudProbability: 0.05,
    compositeScore: 53,
    aiDecision: "Human Review",
    suggestedLoading: null,
  },
  {
    id: "INS-2026-001",
    applicantName: "Muhammad Ali Khan",
    cnic: "35201-1234567-1",
    age: 42,
    occupation: "Software Engineer",
    product: "Term Life 20",
    coverageAmount: 5_000_000,
    termYears: 20,
    submittedAt: "08:42 AM",
    medicalScore: 37,
    financialScore: 35,
    fraudProbability: 0.02,
    compositeScore: 31,
    aiDecision: "Approve with Loading",
    suggestedLoading: 20,
  },
  {
    id: "INS-2026-007",
    applicantName: "Bilal Ahmed",
    cnic: "35201-3456789-7",
    age: 50,
    occupation: "Construction Manager",
    product: "Health Platinum",
    coverageAmount: 15_000_000,
    termYears: 25,
    submittedAt: "11:32 AM",
    medicalScore: 65,
    financialScore: 55,
    fraudProbability: 0.08,
    compositeScore: 63,
    aiDecision: "Human Review",
    suggestedLoading: null,
  },
  {
    id: "INS-2026-002",
    applicantName: "Dr. Fatima Sheikh",
    cnic: "42101-9876543-2",
    age: 35,
    occupation: "General Physician",
    product: "Health Platinum",
    coverageAmount: 20_000_000,
    termYears: 20,
    submittedAt: "09:15 AM",
    medicalScore: 20,
    financialScore: 22,
    fraudProbability: 0.02,
    compositeScore: 20,
    aiDecision: "Auto Approve",
    suggestedLoading: 0,
  },
  {
    id: "INS-2026-006",
    applicantName: "Amna Nawaz",
    cnic: "35202-8765432-6",
    age: 33,
    occupation: "Chartered Accountant",
    product: "Term Life 25",
    coverageAmount: 8_000_000,
    termYears: 25,
    submittedAt: "11:05 AM",
    medicalScore: 20,
    financialScore: 35,
    fraudProbability: 0.02,
    compositeScore: 27,
    aiDecision: "Approve with Loading",
    suggestedLoading: 10,
  },
  {
    id: "INS-2026-005",
    applicantName: "Tariq Hassan",
    cnic: "37401-2109876-5",
    age: 62,
    occupation: "Truck Driver",
    product: "Health Gold",
    coverageAmount: 5_000_000,
    termYears: 15,
    submittedAt: "10:24 AM",
    medicalScore: 92,
    financialScore: 88,
    fraudProbability: 0.25,
    compositeScore: 76,
    aiDecision: "Decline",
    suggestedLoading: null,
  },
  {
    id: "INS-2026-004",
    applicantName: "Sara Malik",
    cnic: "31201-5432167-4",
    age: 28,
    occupation: "High School Teacher",
    product: "Term Life 15",
    coverageAmount: 3_000_000,
    termYears: 15,
    submittedAt: "10:02 AM",
    medicalScore: 10,
    financialScore: 25,
    fraudProbability: 0.02,
    compositeScore: 15,
    aiDecision: "Auto Approve",
    suggestedLoading: 0,
  },
  {
    id: "INS-2026-008",
    applicantName: "Zainab Khan",
    cnic: "42201-6543210-8",
    age: 29,
    occupation: "Barrister-at-Law",
    product: "Term Life 20",
    coverageAmount: 7_000_000,
    termYears: 20,
    submittedAt: "11:48 AM",
    medicalScore: 15,
    financialScore: 28,
    fraudProbability: 0.02,
    compositeScore: 21,
    aiDecision: "Auto Approve",
    suggestedLoading: 0,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Full case detail — looked up by ID in the Case 360 view
// ─────────────────────────────────────────────────────────────────────────────

export const CASE_DETAILS: Record<string, CaseDetail> = {
  "INS-2026-003": {
    id: "INS-2026-003",
    applicantName: "Ahmed Raza",
    cnic: "35201-7654321-3",
    dob: "1971-03-22",
    age: 55,
    gender: "Male",
    occupation: "Mining Engineer",
    declaredIncome: 1_800_000,
    product: "Term Life 30",
    coverageAmount: 15_000_000,
    termYears: 30,
    submittedAt: "09:38 AM",
    medicalScore: 78,
    financialScore: 60,
    fraudProbability: 0.05,
    compositeScore: 53,
    aiDecision: "Human Review",
    suggestedLoading: null,
    medicalReasons: [
      "Age 55 (bracket 46–55): +48 pts — elevated mortality exposure in this age group",
      "Gender Male: +5 pts — actuarial mortality differential applied",
      "Occupation 'Mining Engineer' (high-hazard category): +20 pts — underground operations, respiratory risk, equipment hazard",
    ],
    financialReasons: [
      "Coverage-to-income ratio 8.3× (5–10×, moderate tier): +45 pts — above standard affordability threshold",
      "Annual income PKR 1.8M (bracket PKR 1.2M–2.4M/yr): +10 pts — middle-income segment with moderate lapse risk",
      "Long policy term (30 yrs): +10 pts — extended exposure increases lapse and adverse-selection probability",
    ],
    fraudReasons: [
      "CNIC format valid (35201-7654321-3 → 13 digits confirmed): no fraud signal",
      "Coverage-to-income ratio 8.3× — below the 10× elevated-signal threshold: no signal",
      "Applicant age 55 within normal underwriting range (18–70): no signal",
      "No compound fraud signals detected; baseline probability (2%) raised to 5% due to occupation–coverage combination",
    ],
  },

  "INS-2026-001": {
    id: "INS-2026-001",
    applicantName: "Muhammad Ali Khan",
    cnic: "35201-1234567-1",
    dob: "1984-09-14",
    age: 42,
    gender: "Male",
    occupation: "Software Engineer",
    declaredIncome: 1_200_000,
    product: "Term Life 20",
    coverageAmount: 5_000_000,
    termYears: 20,
    submittedAt: "08:42 AM",
    medicalScore: 37,
    financialScore: 35,
    fraudProbability: 0.02,
    compositeScore: 31,
    aiDecision: "Approve with Loading",
    suggestedLoading: 20,
    medicalReasons: [
      "Age 42 (bracket 36–45): +32 pts — mid-career mortality bracket",
      "Gender Male: +5 pts — actuarial mortality differential applied",
      "Occupation 'Software Engineer' (low-hazard category): +0 pts — sedentary professional role",
    ],
    financialReasons: [
      "Coverage-to-income ratio 4.2× (3–5×, acceptable tier): +25 pts — within standard affordability range",
      "Annual income PKR 1.2M (bracket PKR 1.2M–2.4M/yr): +10 pts — moderate income stability",
      "Policy term (20 yrs): +0 pts — standard term length",
    ],
    fraudReasons: [
      "CNIC format valid (35201-1234567-1 → 13 digits confirmed): no fraud signal",
      "Coverage-to-income ratio 4.2× — well below threshold: no signal",
      "No fraud signals detected; baseline probability (2%) applies",
    ],
  },

  "INS-2026-007": {
    id: "INS-2026-007",
    applicantName: "Bilal Ahmed",
    cnic: "35201-3456789-7",
    dob: "1976-07-30",
    age: 50,
    gender: "Male",
    occupation: "Construction Manager",
    declaredIncome: 2_400_000,
    product: "Health Platinum",
    coverageAmount: 15_000_000,
    termYears: 25,
    submittedAt: "11:32 AM",
    medicalScore: 65,
    financialScore: 55,
    fraudProbability: 0.08,
    compositeScore: 63,
    aiDecision: "Human Review",
    suggestedLoading: null,
    medicalReasons: [
      "Age 50 (bracket 46–55): +48 pts — elevated mortality exposure",
      "Gender Male: +5 pts — actuarial mortality differential",
      "Occupation 'Construction Manager' (medium-hazard category): +10 pts — site supervision with environmental exposure",
    ],
    financialReasons: [
      "Coverage-to-income ratio 6.25× (5–10×, moderate tier): +45 pts",
      "Annual income PKR 2.4M (bracket PKR 2.4M–4.8M/yr): +5 pts — good income stability",
      "Long policy term (25 yrs): +5 pts — moderate lapse exposure",
    ],
    fraudReasons: [
      "CNIC format valid: no fraud signal",
      "Coverage-to-income ratio 6.25× — below elevated-signal threshold: no signal",
      "Elevated baseline due to high coverage amount combined with medium-hazard occupation: +0.06",
    ],
  },

  "INS-2026-002": {
    id: "INS-2026-002",
    applicantName: "Dr. Fatima Sheikh",
    cnic: "42101-9876543-2",
    dob: "1991-04-05",
    age: 35,
    gender: "Female",
    occupation: "General Physician",
    declaredIncome: 3_600_000,
    product: "Health Platinum",
    coverageAmount: 20_000_000,
    termYears: 20,
    submittedAt: "09:15 AM",
    medicalScore: 20,
    financialScore: 22,
    fraudProbability: 0.02,
    compositeScore: 20,
    aiDecision: "Auto Approve",
    suggestedLoading: 0,
    medicalReasons: [
      "Age 35 (bracket 26–35): +20 pts — low-risk age bracket",
      "Gender Female: +0 pts — lower mortality risk actuarially",
      "Occupation 'General Physician' (low-hazard category): +0 pts — professional clinical setting",
    ],
    financialReasons: [
      "Coverage-to-income ratio 5.6× (5–10×, moderate tier): +45 pts",
      "Annual income PKR 3.6M (bracket PKR 2.4M–4.8M/yr): +5 pts — strong income stability",
      "Policy term (20 yrs): +0 pts — standard term",
    ],
    fraudReasons: [
      "CNIC format valid: no fraud signal",
      "Coverage-to-income ratio 5.6× — below elevated-signal threshold",
      "No fraud signals detected; baseline probability (2%) applies",
    ],
  },

  "INS-2026-006": {
    id: "INS-2026-006",
    applicantName: "Amna Nawaz",
    cnic: "35202-8765432-6",
    dob: "1993-11-18",
    age: 33,
    gender: "Female",
    occupation: "Chartered Accountant",
    declaredIncome: 2_400_000,
    product: "Term Life 25",
    coverageAmount: 8_000_000,
    termYears: 25,
    submittedAt: "11:05 AM",
    medicalScore: 20,
    financialScore: 35,
    fraudProbability: 0.02,
    compositeScore: 27,
    aiDecision: "Approve with Loading",
    suggestedLoading: 10,
    medicalReasons: [
      "Age 33 (bracket 26–35): +20 pts — low-risk age bracket",
      "Gender Female: +0 pts — lower mortality risk actuarially",
      "Occupation 'Chartered Accountant' (low-hazard category): +0 pts",
    ],
    financialReasons: [
      "Coverage-to-income ratio 3.3× (3–5×, acceptable tier): +25 pts — within standard range",
      "Annual income PKR 2.4M (bracket PKR 2.4M–4.8M/yr): +5 pts — strong financial stability",
      "Long policy term (25 yrs): +5 pts — moderate lapse exposure over extended horizon",
    ],
    fraudReasons: [
      "CNIC format valid: no fraud signal",
      "Coverage-to-income ratio 3.3× — well within normal range",
      "No fraud signals detected; baseline probability (2%) applies",
    ],
  },

  "INS-2026-005": {
    id: "INS-2026-005",
    applicantName: "Tariq Hassan",
    cnic: "37401-2109876-5",
    dob: "1964-01-09",
    age: 62,
    gender: "Male",
    occupation: "Truck Driver",
    declaredIncome: 480_000,
    product: "Health Gold",
    coverageAmount: 5_000_000,
    termYears: 15,
    submittedAt: "10:24 AM",
    medicalScore: 92,
    financialScore: 88,
    fraudProbability: 0.25,
    compositeScore: 76,
    aiDecision: "Decline",
    suggestedLoading: null,
    medicalReasons: [
      "Age 62 (bracket 56–65): +62 pts — significant elevated mortality risk",
      "Gender Male: +5 pts — actuarial mortality differential",
      "Occupation 'Truck Driver' (medium-hazard category): +10 pts — long-haul road risk, fatigue exposure",
    ],
    financialReasons: [
      "Coverage-to-income ratio 10.4× (10–15×, high tier): +65 pts — above standard affordability threshold",
      "Annual income PKR 480K (< PKR 600K/yr bracket): +20 pts — below minimum income stability threshold",
      "Policy term (15 yrs): +0 pts — standard term, no additional exposure",
    ],
    fraudReasons: [
      "CNIC format valid: no signal from identity check",
      "Elevated coverage-to-income ratio (10.4×, above 10× threshold): +0.12 fraud signal",
      "Low annual income (<PKR 600k) combined with coverage of PKR 5M: +0.10 signal",
      "Multiple compounding fraud signals identified: total probability raised to 25%",
    ],
  },

  "INS-2026-004": {
    id: "INS-2026-004",
    applicantName: "Sara Malik",
    cnic: "31201-5432167-4",
    dob: "1998-07-22",
    age: 28,
    gender: "Female",
    occupation: "High School Teacher",
    declaredIncome: 600_000,
    product: "Term Life 15",
    coverageAmount: 3_000_000,
    termYears: 15,
    submittedAt: "10:02 AM",
    medicalScore: 10,
    financialScore: 25,
    fraudProbability: 0.02,
    compositeScore: 15,
    aiDecision: "Auto Approve",
    suggestedLoading: 0,
    medicalReasons: [
      "Age 28 (bracket 26–35): +10 pts — excellent age bracket",
      "Gender Female: +0 pts — lower mortality risk actuarially",
      "Occupation 'High School Teacher' (low-hazard category): +0 pts — stable indoor professional role",
    ],
    financialReasons: [
      "Coverage-to-income ratio 5.0× (3–5×, acceptable tier): +25 pts — at upper boundary of acceptable range",
      "Annual income PKR 600K (< PKR 600K/yr bracket): +0 pts — borderline, no additional penalty applied",
      "Policy term (15 yrs): +0 pts — standard short-to-medium term",
    ],
    fraudReasons: [
      "CNIC format valid: no fraud signal",
      "Coverage-to-income ratio 5.0× — at threshold but below elevated signal level",
      "No fraud signals detected; baseline probability (2%) applies",
    ],
  },

  "INS-2026-008": {
    id: "INS-2026-008",
    applicantName: "Zainab Khan",
    cnic: "42201-6543210-8",
    dob: "1997-03-12",
    age: 29,
    gender: "Female",
    occupation: "Barrister-at-Law",
    declaredIncome: 2_000_000,
    product: "Term Life 20",
    coverageAmount: 7_000_000,
    termYears: 20,
    submittedAt: "11:48 AM",
    medicalScore: 15,
    financialScore: 28,
    fraudProbability: 0.02,
    compositeScore: 21,
    aiDecision: "Auto Approve",
    suggestedLoading: 0,
    medicalReasons: [
      "Age 29 (bracket 26–35): +15 pts — low-risk age bracket",
      "Gender Female: +0 pts — lower mortality risk actuarially",
      "Occupation 'Barrister-at-Law' (low-hazard category): +0 pts — professional legal practice",
    ],
    financialReasons: [
      "Coverage-to-income ratio 3.5× (3–5×, acceptable tier): +25 pts — comfortably within standard range",
      "Annual income PKR 2.0M (bracket PKR 1.2M–2.4M/yr): +3 pts — good financial stability",
      "Policy term (20 yrs): +0 pts — standard term",
    ],
    fraudReasons: [
      "CNIC format valid: no fraud signal",
      "Coverage-to-income ratio 3.5×: well within normal underwriting parameters",
      "No fraud signals detected; baseline probability (2%) applies",
    ],
  },
};
