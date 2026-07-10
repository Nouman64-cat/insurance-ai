"use client";

interface MedicalExamTier {
  minSumAssured: number;
  tier: string;
}

interface PlanInfo {
  key: string;
  label: string;
  description: string;
  color: string;
  entryAge: [number, number];
  entryAgeLabel: string;
  dependentAge: [number, number] | null;
  term: [number, number];
  maxMaturityAge: number;
  maxIncomeMultiple: number;
  medicalExamTiers: MedicalExamTier[];
  requiredDocuments: string[];
}

// Mirrors services/risk-engine/underwriting_rules.py (UNDERWRITING_RULES) and
// services/tenant-service/document_requirements.py (REQUIRED_DOCUMENTS) —
// reference/display data only; the actual validation and checklist logic
// lives server-side in those two modules.
const PLANS: PlanInfo[] = [
  {
    key: "TERM_LIFE",
    label: "Term Life",
    description: "Pure protection for a fixed term — no maturity value. The cheapest way to secure a large sum assured; pays out only on death within the term.",
    color: "blue",
    entryAge: [18, 65],
    entryAgeLabel: "Proposer",
    dependentAge: null,
    term: [5, 30],
    maxMaturityAge: 70,
    maxIncomeMultiple: 20,
    medicalExamTiers: [
      { minSumAssured: 0, tier: "No medical exam required" },
      { minSumAssured: 5_000_000, tier: "Paramedical exam required" },
      { minSumAssured: 20_000_000, tier: "Full medical exam + financial underwriting required" },
    ],
    requiredDocuments: ["CNIC", "Medical Report", "Salary Slip"],
  },
  {
    key: "WHOLE_LIFE",
    label: "Whole Life",
    description: "Lifetime coverage with an accumulating cash value. Typically more expensive than term life, but the policy never expires and can be borrowed against.",
    color: "violet",
    entryAge: [18, 65],
    entryAgeLabel: "Proposer",
    dependentAge: null,
    term: [1, 40],
    maxMaturityAge: 99,
    maxIncomeMultiple: 25,
    medicalExamTiers: [
      { minSumAssured: 0, tier: "No medical exam required" },
      { minSumAssured: 5_000_000, tier: "Paramedical exam required" },
      { minSumAssured: 15_000_000, tier: "Full medical exam + financial underwriting required" },
    ],
    requiredDocuments: ["CNIC", "Medical Report", "Salary Slip", "Bank Statement"],
  },
  {
    key: "ENDOWMENT",
    label: "Endowment / Savings Plan",
    description: "A with-profits savings policy that pays a lump sum (sum assured plus accrued bonuses) at maturity, or a death benefit if the proposer dies during the term.",
    color: "amber",
    entryAge: [18, 60],
    entryAgeLabel: "Proposer",
    dependentAge: null,
    term: [10, 30],
    maxMaturityAge: 70,
    maxIncomeMultiple: 15,
    medicalExamTiers: [
      { minSumAssured: 0, tier: "No medical exam required" },
      { minSumAssured: 5_000_000, tier: "Paramedical exam required" },
      { minSumAssured: 15_000_000, tier: "Full medical exam + financial underwriting required" },
    ],
    requiredDocuments: ["CNIC", "Medical Report", "Salary Slip", "Bank Statement"],
  },
  {
    key: "CHILD_EDUCATION_MARRIAGE",
    label: "Child Education & Marriage Plan",
    description: "An endowment plan tied to a dependent's milestone age (typically 18, 21, or 25) rather than the proposer's — pays out for education or marriage expenses. If the proposer dies during the term, future premiums are waived and the policy stays in force for the child.",
    color: "emerald",
    entryAge: [20, 60],
    entryAgeLabel: "Proposer",
    dependentAge: [1, 15],
    term: [10, 24],
    maxMaturityAge: 70,
    maxIncomeMultiple: 15,
    medicalExamTiers: [
      { minSumAssured: 0, tier: "No medical exam required" },
      { minSumAssured: 3_000_000, tier: "Paramedical exam required" },
      { minSumAssured: 10_000_000, tier: "Full medical exam + financial underwriting required" },
    ],
    requiredDocuments: ["CNIC", "Salary Slip", "Bank Statement", "Child's Birth Certificate"],
  },
];

const COLOR_CLASSES: Record<string, { badge: string; accent: string }> = {
  blue: { badge: "bg-blue-50 text-blue-700 border-blue-200", accent: "border-t-blue-500" },
  violet: { badge: "bg-violet-50 text-violet-700 border-violet-200", accent: "border-t-violet-500" },
  amber: { badge: "bg-amber-50 text-amber-700 border-amber-200", accent: "border-t-amber-500" },
  emerald: { badge: "bg-emerald-50 text-emerald-700 border-emerald-200", accent: "border-t-emerald-500" },
};

export default function InsurancePlansPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Insurance Plans</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Reference catalog of the plan types available for underwriting, their eligibility rules, and required documents.
        </p>
      </div>

      <div>
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-3">Individual Plans</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {PLANS.map((plan) => {
          const colors = COLOR_CLASSES[plan.color];
          return (
            <div
              key={plan.key}
              className={`bg-white rounded-xl border border-slate-200 border-t-4 ${colors.accent} shadow-sm overflow-hidden`}
            >
              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-bold text-slate-900">{plan.label}</h2>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${colors.badge}`}>
                    {plan.key}
                  </span>
                </div>

                <p className="text-sm text-slate-600 leading-relaxed">{plan.description}</p>

                <div className="grid grid-cols-2 gap-x-6 gap-y-3 pt-2 border-t border-slate-100">
                  <div>
                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                      {plan.entryAgeLabel} Entry Age
                    </span>
                    <span className="text-sm font-semibold text-slate-800">{plan.entryAge[0]}–{plan.entryAge[1]} years</span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Policy Term</span>
                    <span className="text-sm font-semibold text-slate-800">{plan.term[0]}–{plan.term[1]} years</span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Max Maturity Age</span>
                    <span className="text-sm font-semibold text-slate-800">{plan.maxMaturityAge} years</span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Max Coverage</span>
                    <span className="text-sm font-semibold text-slate-800">{plan.maxIncomeMultiple}× annual income</span>
                  </div>
                  {plan.dependentAge && (
                    <div className="col-span-2">
                      <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Dependent Age (at entry)</span>
                      <span className="text-sm font-semibold text-slate-800">{plan.dependentAge[0]}–{plan.dependentAge[1]} years</span>
                    </div>
                  )}
                </div>

                <div className="pt-2 border-t border-slate-100">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Medical Exam Thresholds (PKR)</span>
                  <div className="space-y-1">
                    {plan.medicalExamTiers.map((t, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-slate-500">
                          {i === plan.medicalExamTiers.length - 1
                            ? `≥ PKR ${t.minSumAssured.toLocaleString()}`
                            : `PKR ${t.minSumAssured.toLocaleString()} – ${(plan.medicalExamTiers[i + 1].minSumAssured - 1).toLocaleString()}`}
                        </span>
                        <span className="font-semibold text-slate-700">{t.tier}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Required Documents (Underwriting)</span>
                  <div className="flex flex-wrap gap-1.5">
                    {plan.requiredDocuments.map((doc) => (
                      <span key={doc} className="text-xs px-2 py-1 rounded-lg border bg-slate-50 text-slate-700 border-slate-200">
                        {doc}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pt-2">
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-3">Group / Business Plans</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-slate-200 border-t-4 border-t-indigo-500 shadow-sm overflow-hidden">
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-bold text-slate-900">Group Life</h2>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-indigo-50 text-indigo-700 border-indigo-200">
                GROUP_LIFE
              </span>
            </div>

            <p className="text-sm text-slate-600 leading-relaxed">
              A single Master Policy issued to a business, covering its staff under one contract — employees get a
              Certificate of Insurance, not their own individual policy. Pays out only on death during employment; no
              maturity/surrender value.
            </p>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3 pt-2 border-t border-slate-100">
              <div>
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Minimum Group Size</span>
                <span className="text-sm font-semibold text-slate-800">10 employees</span>
              </div>
              <div>
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Sum Assured Formula</span>
                <span className="text-sm font-semibold text-slate-800">12×–36× monthly basic salary</span>
              </div>
              <div>
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Medical Underwriting</span>
                <span className="text-sm font-semibold text-slate-800">None — guaranteed issue</span>
              </div>
              <div>
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Underwriting Basis</span>
                <span className="text-sm font-semibold text-slate-800">Group-level (size, industry, claims history)</span>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Enrollment</span>
              <p className="text-xs text-slate-500">
                Employer submits an employee census (CNIC, DOB, gender, occupation, salary per employee) which is validated for
                duplicates and missing fields before certificates are issued. See <span className="font-semibold text-slate-700">Organization Management</span> to onboard a business.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
