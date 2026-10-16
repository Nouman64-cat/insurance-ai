"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import axios from "axios";
import DemoFillButton from "@/components/DemoFillButton";

const publicApi = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL, timeout: 30000 });
const NONE = "None of these";
const CHOICES: Record<string, Record<string, string[]>> = {
  medical: {
    conditions: ["Diabetes", "High blood pressure", "Heart condition", "Respiratory condition", "Previous surgery or hospital admission", "Other condition or symptoms", NONE],
    medications: ["Regular medication", "Current treatment", "Known allergies", NONE],
    family_history: ["Diabetes", "Heart disease", "Cancer", "Inherited condition", "Other major illness", "Unknown", NONE],
    lifestyle: ["Smoking or tobacco", "Alcohol consumption", "Regular exercise", "Hazardous activities", NONE],
    tests: ["Blood tests", "ECG or heart tests", "X-ray or scan", "Other tests", NONE],
  },
  financial: {
    occupation: ["Employed", "Self-employed", "Business owner", "Retired", "Student", "Not currently working"],
    commitments: ["Household expenses", "Mortgage or rent", "Loans or credit cards", "Financial dependants", "Other commitments", NONE],
    assets: ["Property", "Savings or deposits", "Investments", "Business assets", "Outstanding liabilities", NONE],
    insurance: ["Existing life insurance", "Pending insurance application", NONE],
    funding: ["My salary", "Business income", "Savings or investments", "Family member pays", "Other source"],
  },
};
const DEMO_DETAILS: Record<string, Record<string, string>> = {
  medical: {
    conditions: "No diagnosed illnesses, previous operations, admissions or current symptoms.",
    medications: "No current medicines, treatment or known allergies.",
    family_history: "No known major illnesses in immediate family.",
    lifestyle: "Walks for 30 minutes five days a week. Does not smoke or drink alcohol; no hazardous activities.",
    tests: "Routine blood tests in January 2026 were reported normal. No ongoing treatment.",
  },
  financial: {
    occupation: "Software engineer at Demo Company for 5 years.",
    income: "PKR 3,600,000 gross annual salary; no additional income sources.",
    commitments: "Monthly household expenses PKR 100,000 including rent; two dependants; no loans.",
    assets: "Savings PKR 1,200,000; no outstanding liabilities.",
    insurance: "No existing or pending life insurance policies.",
    funding: "I will pay from my salary for family income protection.",
  },
};
type Questionnaire = { track: string; questions: Record<string, string>; submitted: boolean };

export default function QuestionnairePage() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<Questionnaire | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [signature, setSignature] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [demoFilled, setDemoFilled] = useState(false);

  useEffect(() => {
    setForm(null); setAnswers({}); setSelected({}); setSignature(""); setConsent(false); setError(""); setDemoFilled(false);
    const controller = new AbortController();
    publicApi.get(`/public/underwriting-questionnaire/${token}`, { signal: controller.signal })
      .then(r => setForm(r.data))
      .catch(e => { if (!controller.signal.aborted) setError(e.response?.data?.detail ?? "Could not load questionnaire."); });
    return () => controller.abort();
  }, [token]);

  const toggle = (key: string, option: string) => {
    setSelected(current => {
      const values = current[key] ?? [];
      const exclusive = (value: string) => value === NONE || value === "Unknown";
      return { ...current, [key]: values.includes(option) ? values.filter(v => v !== option) : exclusive(option) ? [option] : [...values.filter(v => !exclusive(v)), option] };
    });
  };
  const fillDemo = () => {
    if (!form) return;
    setAnswers(DEMO_DETAILS[form.track] ?? {});
    setSelected(form.track === "medical" ? {
      conditions: [NONE], medications: [NONE], family_history: [NONE], lifestyle: ["Regular exercise"], tests: ["Blood tests"],
    } : {
      occupation: ["Employed"], commitments: ["Household expenses", "Mortgage or rent", "Financial dependants"], assets: ["Savings or deposits"], insurance: [NONE], funding: ["My salary"],
    });
    setSignature("Demo Customer"); setConsent(false); setDemoFilled(true); setError("");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const payload: Record<string, string> = {};
    for (const key of Object.keys(form.questions)) {
      const options = CHOICES[form.track]?.[key];
      const values = selected[key] ?? [];
      if (options && !values.length) { setError("Select at least one answer for each checkbox question."); return; }
      payload[key] = [values.length ? `Selected: ${values.join(", ")}` : "", answers[key]?.trim() ?? ""].filter(Boolean).join("\n");
    }
    setBusy(true); setError("");
    try {
      await publicApi.post(`/public/underwriting-questionnaire/${token}/submit`, { answers: payload, signature, consent });
      setForm(f => f ? { ...f, submitted: true } : f);
    } catch (e: any) {
      setError(typeof e.response?.data?.detail === "string" ? e.response.data.detail : "Submission failed. Check your answers and try again.");
    } finally { setBusy(false); }
  };

  return <main className="min-h-screen bg-slate-50 px-5 py-12">
    <div className="mx-auto max-w-2xl rounded-2xl border bg-white p-6 shadow-sm sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Insurance application</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold capitalize">{form?.track} questionnaire</h1>
        {form && !form.submitted && <DemoFillButton onFill={fillDemo} />}
      </div>
      {error && <p role="alert" className="my-4 text-red-700">{error}</p>}
      {!form && !error && <p className="mt-6">Loading…</p>}
      {form?.submitted ? <p role="status" className="mt-6">Thank you. Your answers have been submitted to your reviewer.</p> : form && <form onSubmit={submit} className="mt-6 space-y-6">
        <p className="text-sm text-slate-600">Select all answers that apply and add details where relevant. Select “None of these” when appropriate.</p>
        {demoFilled && <p role="status" className="rounded-lg bg-violet-50 p-3 text-sm text-violet-800">Demo answers filled. Review them and confirm the declaration before submitting.</p>}
        {Object.entries(form.questions).map(([key, label], index) => {
          const options = CHOICES[form.track]?.[key];
          const values = selected[key] ?? [];
          const needsDetails = !options || (form.track === "financial" && !values.includes(NONE)) || (form.track === "medical" && ["conditions", "medications", "family_history", "tests"].includes(key) && values.some(v => v !== NONE && v !== "Unknown"));
          return <fieldset key={key} className="rounded-xl border border-slate-200 p-4">
            <legend className="px-1 text-sm font-semibold text-slate-900">{index + 1}. {label}</legend>
            {options && <div className="mb-4 mt-2 grid gap-2 sm:grid-cols-2">{options.map(option => <label key={option} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${values.includes(option) ? "border-blue-300 bg-blue-50 text-blue-900" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
              <input type="checkbox" checked={values.includes(option)} onChange={() => toggle(key, option)} className="mt-0.5 h-4 w-4 accent-blue-600" />{option}
            </label>)}</div>}
            <label className="block text-xs font-medium text-slate-600" htmlFor={`details-${key}`}>{options ? `Additional details${needsDetails ? " (required)" : " (optional)"}` : "Your answer"}</label>
            <textarea id={`details-${key}`} required={needsDetails} maxLength={4000} value={answers[key] ?? ""} onChange={e => setAnswers(current => ({ ...current, [key]: e.target.value }))} className="mt-2 min-h-20 w-full rounded-lg border p-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </fieldset>;
        })}
        <label className="block text-sm font-medium">Full name / signature<input required minLength={2} maxLength={200} value={signature} onChange={e => setSignature(e.target.value)} className="mt-2 w-full rounded-lg border p-3" /></label>
        <label className="flex gap-3 text-sm"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-blue-600" />I confirm these answers are accurate and authorize their use for my insurance application review.</label>
        <button disabled={busy} className="w-full rounded-lg bg-blue-600 p-3 font-semibold text-white disabled:opacity-50">{busy ? "Submitting…" : "Submit questionnaire"}</button>
      </form>}
    </div>
  </main>;
}
