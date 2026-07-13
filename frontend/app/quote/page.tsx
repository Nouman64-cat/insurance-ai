"use client";

import { useEffect, useState } from "react";
import api from "../services/api";
import { InsurancePlan, listInsurancePlans } from "../services/insurancePlans";
import { CNIC_PATTERN, formatCnic } from "@/lib/cnic";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormValues {
  cnic:                 string;
  name:                 string;
  dob:                  string;
  gender:               string;
  occupation:           string;
  monthlyIncome:        string;
  isSmoker:              boolean;
  heightCm:             string;
  weightKg:             string;
  planCode:             string;
  coverageAmount:        string;
  termYears:            string;
  nomineeName:           string;
  nomineeRelationship:  string;
}

interface QuoteResult {
  eligible: boolean;
  eligibility_errors: string[];
  quote_id?: string;
  annual_income?: number;
  plan_label?: string;
  coverage_amount?: number;
  term_years?: number;
  base_premium?: number;
  loading_applied?: number;
  total_premium?: number;
  rate_version?: string;
  reasons?: string[];
}

const DEFAULT_FORM: FormValues = {
  cnic: "",
  name: "",
  dob: "",
  gender: "Male",
  occupation: "",
  monthlyIncome: "",
  isSmoker: false,
  heightCm: "",
  weightKg: "",
  planCode: "",
  coverageAmount: "",
  termYears: "",
  nomineeName: "",
  nomineeRelationship: "",
};

function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QuotePage() {
  const [form, setForm] = useState<FormValues>(DEFAULT_FORM);
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tid = localStorage.getItem("tenant_id");
    setTenantId(tid);
    if (!tid) return;
    listInsurancePlans(tid)
      .then((data) => {
        const active = data.filter((p) => p.status === "Active" && p.insurance_type !== "GROUP_LIFE");
        setPlans(active);
        if (active.length > 0) setForm((f) => ({ ...f, planCode: active[0].code }));
      })
      .catch(() => setPlans([]));
  }, []);

  const setField = <K extends keyof FormValues>(key: K, val: FormValues[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const selectedPlan = plans.find((p) => p.code === form.planCode) ?? null;
  const monthlyIncomeNum = parseFloat(form.monthlyIncome) || 0;
  const annualIncomePreview = monthlyIncomeNum * 12;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId) {
      setError("No active tenant session found. Please log in again.");
      return;
    }

    setLoading(true);
    setResult(null);
    setError(null);

    const payload = {
      applicant: {
        cnic: form.cnic,
        name: form.name,
        dob: form.dob,
        gender: form.gender,
        occupation: form.occupation,
        monthly_income: monthlyIncomeNum,
        is_smoker: form.isSmoker,
        height_cm: parseFloat(form.heightCm) || 0,
        weight_kg: parseFloat(form.weightKg) || 0,
      },
      policy: {
        plan_code: form.planCode,
        coverage_amount: parseFloat(form.coverageAmount) || 0,
        term_years: parseInt(form.termYears) || 0,
        nominee_name: form.nomineeName,
        nominee_relationship: form.nomineeRelationship,
      },
    };

    try {
      const res = await api.post<QuoteResult>("/quote", payload, {
        headers: { "X-Tenant-Id": tenantId },
      });
      setResult(res.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to get a quote.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 py-5 max-w-screen-2xl mx-auto w-full space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Get a Quote</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Instant premium estimate — pure actuarial math, no AI underwriting wait.
          </p>
        </div>
        <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold tracking-wide">
          POST /quote
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-5 items-start">
        {/* ── LEFT — Form ─────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-700">Quote Request</p>
            <p className="text-xs text-slate-400 mt-0.5">Everything needed to price the policy</p>
          </div>

          <div className="p-5 space-y-5">
            <section>
              <SectionLabel>Applicant</SectionLabel>
              <div className="space-y-3">
                <InputField label="CNIC" placeholder="35201-1234567-1" value={form.cnic} onChange={(v) => setField("cnic", formatCnic(v))} inputMode="numeric" maxLength={15} pattern={CNIC_PATTERN} title="Format: 35201-1234567-1" />
                <InputField label="Full Name" placeholder="Muhammad Ali Khan" value={form.name} onChange={(v) => setField("name", v)} />
                <InputField label="Date of Birth" type="date" value={form.dob} onChange={(v) => setField("dob", v)} />
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Gender</label>
                  <select
                    value={form.gender}
                    onChange={(e) => setField("gender", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                  >
                    <option>Male</option>
                    <option>Female</option>
                    <option>Other</option>
                  </select>
                </div>
                <InputField label="Occupation" placeholder="Software Engineer" value={form.occupation} onChange={(v) => setField("occupation", v)} />
                <InputField
                  label="Monthly Salary (PKR)"
                  type="number"
                  placeholder="250000"
                  value={form.monthlyIncome}
                  onChange={(v) => setField("monthlyIncome", v)}
                />
                {annualIncomePreview > 0 && (
                  <p className="text-[11px] text-slate-400">
                    Annualized: <span className="font-semibold text-slate-600">{formatPKR(annualIncomePreview)}</span> / year
                  </p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <InputField label="Height (cm)" type="number" placeholder="175" value={form.heightCm} onChange={(v) => setField("heightCm", v)} />
                  <InputField label="Weight (kg)" type="number" placeholder="75" value={form.weightKg} onChange={(v) => setField("weightKg", v)} />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                  <input type="checkbox" checked={form.isSmoker} onChange={(e) => setField("isSmoker", e.target.checked)} />
                  Smoker
                </label>
              </div>
            </section>

            <section>
              <SectionLabel>Policy</SectionLabel>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Plan</label>
                  <select
                    value={form.planCode}
                    onChange={(e) => setField("planCode", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                  >
                    {plans.length === 0 && <option value="">No active plans found</option>}
                    {plans.map((p) => (
                      <option key={p.code} value={p.code}>{p.label}</option>
                    ))}
                  </select>
                  {selectedPlan && (
                    <p className="text-[11px] text-slate-400 mt-1">
                      Entry age {selectedPlan.entry_age_min}-{selectedPlan.entry_age_max} · term {selectedPlan.term_min_years}-{selectedPlan.term_max_years} yrs · max {selectedPlan.max_income_multiple}x income
                    </p>
                  )}
                </div>
                <InputField label="Coverage Amount (PKR)" type="number" placeholder="10000000" value={form.coverageAmount} onChange={(v) => setField("coverageAmount", v)} />
                <InputField label="Term (Years)" type="number" placeholder="10" value={form.termYears} onChange={(v) => setField("termYears", v)} />
                <InputField label="Nominee Name" placeholder="Amna Khan" value={form.nomineeName} onChange={(v) => setField("nomineeName", v)} />
                <InputField label="Nominee Relationship" placeholder="Mother" value={form.nomineeRelationship} onChange={(v) => setField("nomineeRelationship", v)} />
              </div>
            </section>
          </div>

          <div className="px-5 py-4 border-t border-slate-100">
            <button
              type="submit"
              disabled={loading || !form.planCode}
              className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
                loading || !form.planCode
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : "bg-slate-900 text-white hover:bg-slate-800 active:scale-[0.99]"
              }`}
            >
              {loading ? "Calculating…" : "Get Quote"}
            </button>
          </div>
        </form>

        {/* ── RIGHT — Result ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}

          {result && !result.eligible && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-2">Not Eligible</p>
              <ul className="space-y-1">
                {result.eligibility_errors.map((msg, i) => (
                  <li key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                    <span className="text-red-400 mt-0.5 flex-shrink-0">✕</span>
                    {msg}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result && result.eligible && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100">
                <p className="text-sm font-semibold text-slate-700">Your Quote</p>
              </div>
              <div className="p-5 space-y-4">
                <p className="text-sm text-slate-600">
                  Your estimated premium is{" "}
                  <span className="font-bold text-slate-900">{formatPKR(result.total_premium ?? 0)}</span> per year
                  for <span className="font-bold text-slate-900">{result.term_years}</span> years of{" "}
                  <span className="font-bold text-slate-900">{formatPKR(result.coverage_amount ?? 0)}</span> coverage
                  under <span className="font-semibold">{result.plan_label}</span>.
                </p>

                <div className="grid grid-cols-3 gap-3">
                  <StatTile label="Base Premium" value={formatPKR(result.base_premium ?? 0)} />
                  <StatTile label="Loading" value={formatPKR(result.loading_applied ?? 0)} />
                  <StatTile label="Total / Year" value={formatPKR(result.total_premium ?? 0)} highlight />
                </div>

                <p className="text-[11px] text-slate-400">
                  Annual income used: {formatPKR(result.annual_income ?? 0)} · rate version {result.rate_version}
                </p>

                {result.reasons && result.reasons.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Breakdown</p>
                    <ul className="space-y-1.5">
                      {result.reasons.map((r, i) => (
                        <li key={i} className="text-xs text-slate-600 flex items-start gap-2">
                          <span className="text-slate-300 mt-0.5 flex-shrink-0">–</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-[11px] text-slate-400 pt-2 border-t border-slate-100">
                  This is an indicative quote, not a final underwriting decision — run{" "}
                  <a href="/live-evaluation" className="underline hover:text-slate-600">Live Evaluation</a> for full AI risk assessment.
                </p>
              </div>
            </div>
          )}

          {!result && !error && (
            <div className="bg-white rounded-xl border border-slate-200 border-dashed p-12 flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                <span className="text-2xl">💰</span>
              </div>
              <p className="text-sm font-semibold text-slate-600">Ready to quote</p>
              <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
                Fill in the form and click <strong>Get Quote</strong> for an instant premium estimate.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">{children}</p>;
}

function InputField({
  label, type = "text", placeholder, value, onChange, inputMode, maxLength, pattern, title,
}: {
  label: string;
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  maxLength?: number;
  pattern?: string;
  title?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        required
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        maxLength={maxLength}
        pattern={pattern}
        title={title}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
      />
    </div>
  );
}

function StatTile({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-slate-900" : "bg-slate-50"}`}>
      <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${highlight ? "text-slate-300" : "text-slate-400"}`}>
        {label}
      </p>
      <p className={`text-sm font-bold ${highlight ? "text-white" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}
