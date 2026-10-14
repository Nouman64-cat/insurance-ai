"use client";

// Public E-Application — no login. Reached via a tokenized link an agent/staff
// member generates from a case (see /case/[id] "Pre-Underwriting" section).
// Deliberately does NOT use app/services/api.ts — that shared instance
// redirects to /login on 401 and attaches whatever staff JWT happens to be in
// this browser's localStorage, neither of which is correct for an anonymous
// customer filling in their own declaration.

import { useEffect, useState } from "react";
import axios from "axios";
import { tx } from "@/lib/i18n/tx";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

const publicApi = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

// The demo fill answers every question with made-up data under a signed declaration, so it is for
// development and demos only — never offered on a production build.
const SHOW_DEMO_FILL = process.env.NODE_ENV !== "production";

type LoadState =
  | "loading"
  | "ready"
  | "not_found"
  | "expired"
  | "submitted"
  | "error";

interface YesNoAnswer {
  answer: "" | "Yes" | "No";
  details: string;
}

interface FamilyHistoryEntry {
  relation: string;
  name: string;
  age: string;
  is_alive: boolean;
  condition: string;
  age_at_onset: string;
}

interface ExistingPolicy {
  insurer_name: string;
  policy_number: string;
  sum_assured: string;
  status: "Active" | "Lapsed" | "Surrendered";
}

// ── 3B: itemized medical conditions checklist, each with 3C detail fields ───
interface ConditionEntry {
  key: string;
  label: string;
  checked: boolean;
  year_of_diagnosis: string;
  under_treatment: boolean;
  medications: string;
  physician_name: string;
  physician_clinic: string;
  physician_phone: string;
  last_consultation_date: string;
}

const CONDITION_LABELS: { key: string; label: string }[] = [
  { key: "hypertension", label: "High Blood Pressure / Hypertension" },
  { key: "diabetes", label: "Diabetes (Type 1 or Type 2)" },
  { key: "heart_disease", label: "Heart Disease / Cardiovascular Condition" },
  { key: "cancer", label: "Cancer / Malignancy" },
  { key: "respiratory", label: "Respiratory Disease (Asthma, COPD)" },
  { key: "kidney_liver", label: "Kidney or Liver Disorder" },
  { key: "neurological", label: "Neurological Condition (Stroke, Epilepsy)" },
  {
    key: "mental_health",
    label: "Mental Health Condition (Depression, Anxiety)",
  },
  { key: "hiv_aids", label: "HIV / AIDS" },
  {
    key: "other_chronic",
    label: "Any Other Chronic Illness Requiring Ongoing Treatment",
  },
];

const emptyConditions = (): ConditionEntry[] =>
  CONDITION_LABELS.map((c) => ({
    key: c.key,
    label: c.label,
    checked: false,
    year_of_diagnosis: "",
    under_treatment: false,
    medications: "",
    physician_name: "",
    physician_clinic: "",
    physician_phone: "",
    last_consultation_date: "",
  }));

interface HistoryEntry {
  date: string;
  reason_or_type: string;
  hospital: string;
  duration: string;
}

interface MedicalQuestionnaire {
  // 3A: Basic Health Indicators
  height_cm: string;
  weight_kg: string;
  tobacco_use: boolean;
  tobacco_frequency: string;
  alcohol_use: boolean;
  alcohol_units_per_week: string;
  drug_use: boolean;
  drug_use_details: string;
  // 3B/3C: itemized conditions
  conditions: ConditionEntry[];
  // Hospitalizations & surgeries (last 5 years)
  has_hospitalizations: boolean;
  hospitalizations: HistoryEntry[];
  has_surgeries: boolean;
  surgeries: HistoryEntry[];
  // Additional regulatory disclosures not covered by the checklist above
  disclosures: Record<string, YesNoAnswer>;
}

const ADDITIONAL_DISCLOSURES: { key: string; label: string }[] = [
  {
    key: "physical_deformity",
    label:
      "Are you or any of your family members (spouse/children/parents) suffering, or have suffered, from any physical deformity?",
  },
  {
    key: "congenital_defect",
    label:
      "Do you or any of your family members have, or have had, any congenital abnormality or birth defect?",
  },
  {
    key: "mental_disorder",
    label:
      "Do you or any of your family members suffer, or have suffered, from any mental, psychiatric or nervous disorder not already listed above?",
  },
  {
    key: "pregnancy",
    label:
      "Are you, or is your spouse, currently pregnant? If yes, how many months?",
  },
  {
    key: "family_not_healthy",
    label:
      "Is there anything about your or your family's health you have not already disclosed above?",
  },
];

const bmiOf = (heightCm: string, weightKg: string): string => {
  const h = Number(heightCm) / 100;
  const w = Number(weightKg);
  if (!h || !w) return "";
  return (w / (h * h)).toFixed(1);
};

const emptyMedical = (): MedicalQuestionnaire => ({
  height_cm: "",
  weight_kg: "",
  tobacco_use: false,
  tobacco_frequency: "",
  alcohol_use: false,
  alcohol_units_per_week: "",
  drug_use: false,
  drug_use_details: "",
  conditions: emptyConditions(),
  has_hospitalizations: false,
  hospitalizations: [],
  has_surgeries: false,
  surgeries: [],
  disclosures: Object.fromEntries(
    ADDITIONAL_DISCLOSURES.map((q) => [q.key, { answer: "", details: "" }]),
  ),
});

const STEPS = [
  "Confirm Details",
  "Medical Questionnaire",
  "Family History",
  "Lifestyle & Habits",
  "Existing Insurance",
  "Declaration & Signature",
];

export default function EApplicationPage({
  params,
}: {
  params: { token: string };
}) {
  const { token } = params;

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const [applicant, setApplicant] = useState<{
    name: string;
    cnic: string | null;
    product_name: string | null;
    coverage_amount: number | null;
    term_years: number | null;
  }>({
    name: "",
    cnic: null,
    product_name: null,
    coverage_amount: null,
    term_years: null,
  });

  const [medical, setMedical] = useState<MedicalQuestionnaire>(emptyMedical());
  const [familyHistory, setFamilyHistory] = useState<FamilyHistoryEntry[]>([]);
  const [lifestyle, setLifestyle] = useState({
    has_hazardous_hobby: false,
    hazardous_hobby_details: "",
    occupation_hazard_level: "Low",
    frequent_foreign_travel: false,
    foreign_travel_details: "",
    road_travel_frequent: false,
    road_trips_per_month: "",
    road_trip_hours: "",
    road_travel_details: "",
    moving_violations_past_3_years: "0",
    dui_dwi_history: false,
    criminal_record: false,
  });
  const [existingInsurance, setExistingInsurance] = useState({
    has_existing_policies: false,
    policies: [] as ExistingPolicy[],
    applied_last_2_years: false,
    was_declined_or_deferred: false,
    declined_details: "",
  });
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [declaration, setDeclaration] = useState({
    confirms_accurate: false,
    authorizes_records_access: false,
    not_signed_blank: false,
    understood_terms: false,
    signature_name: "",
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await publicApi.get(`/public/e-application/${token}`);
        const d = res.data;
        if (d.status === "Submitted") {
          setLoadState("submitted");
          return;
        }
        setApplicant({
          name: d.customer_name,
          cnic: d.cnic,
          product_name: d.product_name,
          coverage_amount: d.coverage_amount,
          term_years: d.term_years,
        });
        if (d.medical_questionnaire) {
          setMedical({
            ...emptyMedical(),
            ...d.medical_questionnaire,
            conditions:
              Array.isArray(d.medical_questionnaire.conditions) &&
              d.medical_questionnaire.conditions.length > 0
                ? d.medical_questionnaire.conditions
                : emptyConditions(),
            hospitalizations: Array.isArray(
              d.medical_questionnaire.hospitalizations,
            )
              ? d.medical_questionnaire.hospitalizations
              : [],
            surgeries: Array.isArray(d.medical_questionnaire.surgeries)
              ? d.medical_questionnaire.surgeries
              : [],
            disclosures: {
              ...emptyMedical().disclosures,
              ...(d.medical_questionnaire.disclosures || {}),
            },
          });
        }
        if (d.family_history?.entries)
          setFamilyHistory(
            Array.isArray(d.family_history.entries)
              ? d.family_history.entries
              : [],
          );
        if (d.lifestyle_habits)
          setLifestyle((s) => ({ ...s, ...d.lifestyle_habits }));
        if (d.existing_insurance) {
          setExistingInsurance((s) => ({
            ...s,
            ...d.existing_insurance,
            policies: Array.isArray(d.existing_insurance.policies)
              ? d.existing_insurance.policies
              : [],
          }));
        }
        if (d.declaration) setDeclaration((s) => ({ ...s, ...d.declaration }));
        setLoadState("ready");
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 410) setLoadState("expired");
        else if (status === 404) setLoadState("not_found");
        else setLoadState("error");
        setErrorMsg(
          e?.response?.data?.detail ??
            tx("Something went wrong loading your application."),
        );
      }
    })();
  }, [token]);

  const saveDraft = async () => {
    setSaving(true);
    try {
      await publicApi.put(`/public/e-application/${token}`, {
        medical_questionnaire: medical,
        family_history: { entries: familyHistory },
        lifestyle_habits: lifestyle,
        existing_insurance: existingInsurance,
        declaration,
      });
    } catch {
      // Autosave is best-effort — the user can still move on and retry at final submit.
    } finally {
      setSaving(false);
    }
  };

  const goNext = async () => {
    await saveDraft();
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  // Demo helper: fills every step with plausible answers and jumps to the last step, ready to submit.
  const fillDemoData = () => {
    const conditions = emptyConditions().map((c) =>
      c.key === "hypertension"
        ? {
            ...c,
            checked: true,
            year_of_diagnosis: "2021",
            under_treatment: true,
            medications: "Amlodipine 5mg, once daily",
            physician_name: "Dr. Sana Malik",
            physician_clinic: "Shifa International Hospital",
            physician_phone: "0300-1234567",
            last_consultation_date: "15 Aug 2026",
          }
        : c,
    );
    setMedical({
      ...emptyMedical(),
      height_cm: "172",
      weight_kg: "74",
      tobacco_use: false,
      alcohol_use: false,
      drug_use: false,
      conditions,
      has_hospitalizations: true,
      hospitalizations: [
        {
          date: "March 2023",
          reason_or_type: "Dengue fever",
          hospital: "Shifa International Hospital",
          duration: "4 days",
        },
      ],
      has_surgeries: true,
      surgeries: [
        {
          date: "June 2019",
          reason_or_type: "Appendectomy",
          hospital: "Aga Khan University Hospital",
          duration: "3 days",
        },
      ],
      disclosures: Object.fromEntries(
        ADDITIONAL_DISCLOSURES.map((q) => [
          q.key,
          { answer: "No" as const, details: "" },
        ]),
      ),
    });
    setFamilyHistory([
      {
        relation: "Father",
        name: "Muhammad Aslam",
        age: "68",
        is_alive: true,
        condition: "Hypertension",
        age_at_onset: "55",
      },
      {
        relation: "Mother",
        name: "Razia Begum",
        age: "64",
        is_alive: true,
        condition: "Type 2 Diabetes",
        age_at_onset: "58",
      },
    ]);
    setLifestyle({
      has_hazardous_hobby: false,
      hazardous_hobby_details: "",
      occupation_hazard_level: "Low",
      frequent_foreign_travel: true,
      foreign_travel_details: "Business trips to the UAE, 2–3 times a year",
      moving_violations_past_3_years: "0",
      dui_dwi_history: false,
      criminal_record: false,
    });
    setExistingInsurance({
      has_existing_policies: true,
      policies: [
        {
          insurer_name: "State Life Insurance",
          policy_number: "SL-2018-004512",
          sum_assured: "2000000",
          status: "Active",
        },
      ],
      applied_last_2_years: false,
      was_declined_or_deferred: false,
      declined_details: "",
    });
    setDeclaration({
      confirms_accurate: true,
      authorizes_records_access: true,
      not_signed_blank: true,
      understood_terms: true,
      signature_name: applicant.name || "Applicant",
    });
    setSubmitErr(null);
    setStep(STEPS.length - 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitErr(null);
    setSubmitting(true);
    try {
      await publicApi.put(`/public/e-application/${token}`, {
        medical_questionnaire: medical,
        family_history: { entries: familyHistory },
        lifestyle_habits: lifestyle,
        existing_insurance: existingInsurance,
        declaration,
      });
      await publicApi.post(`/public/e-application/${token}/submit`);
      setLoadState("submitted");
    } catch (e: any) {
      setSubmitErr(
        e?.response?.data?.detail ??
          "Failed to submit. Please review your answers and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loadState === "loading") {
    return <CenteredMessage title={tx("Loading your application…")} />;
  }
  if (loadState === "not_found" || loadState === "error") {
    return (
      <CenteredMessage
        title={tx("We couldn't find this application")}
        body={
          errorMsg ??
          "The link may be invalid. Please contact your agent for a new one."
        }
        tone="error"
      />
    );
  }
  if (loadState === "expired") {
    return (
      <CenteredMessage
        title={tx("This link has expired")}
        body="Please contact your agent or the branch to have a new E-Application link sent to you."
        tone="error"
      />
    );
  }
  if (loadState === "submitted") {
    return (
      <CenteredMessage
        title={tx("Thank you — your application has been submitted")}
        body="Your insurer has received your E-Application. No further action is needed from you at this time."
        tone="success"
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">
            {tx("Life Insurance E-Application")}
          </p>
          <h1 className="text-xl font-bold text-slate-800">
            {tx("Hi")} {applicant.name || tx("there")}
            {tx(", let's complete your application")}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            {tx("Step")} {step + 1} {tx("of")} {STEPS.length} · {STEPS[step]}
          </p>
          <div className="mt-2 h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          {step === 0 && (
            <StepConfirmDetails
              applicant={applicant}
              accepted={disclaimerAccepted}
              setAccepted={setDisclaimerAccepted}
            />
          )}
          {step === 1 && (
            <StepMedical medical={medical} setMedical={setMedical} />
          )}
          {step === 2 && (
            <StepFamilyHistory
              entries={familyHistory}
              setEntries={setFamilyHistory}
            />
          )}
          {step === 3 && (
            <StepLifestyle lifestyle={lifestyle} setLifestyle={setLifestyle} />
          )}
          {step === 4 && (
            <StepExistingInsurance
              data={existingInsurance}
              setData={setExistingInsurance}
            />
          )}
          {step === 5 && (
            <StepDeclaration
              declaration={declaration}
              setDeclaration={setDeclaration}
            />
          )}
        </div>

        {submitErr && <p className="text-xs text-red-600 mt-3">{submitErr}</p>}

        <div className="flex items-center justify-between mt-4">
          <button
            onClick={goBack}
            disabled={step === 0}
            className="px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-30"
          >
            {tx("← Back")}
          </button>
          {step === 0 && SHOW_DEMO_FILL ? (
            <button
              type="button"
              onClick={fillDemoData}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-fuchsia-700 bg-fuchsia-50 border border-fuchsia-200 hover:bg-fuchsia-100"
            >
              {tx("Fill demo details")}
            </button>
          ) : (
            saving && (
              <span className="text-[11px] text-slate-400">{tx("Saving…")}</span>
            )
          )}
          {step < STEPS.length - 1 ? (
            <button
              onClick={goNext}
              disabled={step === 0 && !disclaimerAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40"
            >
              {tx("Next →")}
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={submitting}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40"
            >
              {submitting ? tx("Submitting…") : tx("Submit Application")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function CenteredMessage({
  title,
  body,
  tone,
}: {
  title: string;
  body?: string;
  tone?: "error" | "success";
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center bg-white border border-slate-200 rounded-xl p-8 shadow-sm">
        <h1
          className={`text-lg font-bold ${tone === "error" ? "text-red-600" : tone === "success" ? "text-blue-600" : "text-slate-800"}`}
        >
          {title}
        </h1>
        {body && <p className="text-sm text-slate-500 mt-2">{body}</p>}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 ${props.className ?? ""}`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 ${props.className ?? ""}`}
    />
  );
}

// ── Step 1: Confirm details ──────────────────────────────────────────────────

function StepConfirmDetails({
  applicant,
  accepted,
  setAccepted,
}: {
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  applicant: {
    name: string;
    cnic: string | null;
    product_name: string | null;
    coverage_amount: number | null;
    term_years: number | null;
  };
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        {tx(
          "Please confirm the details below are correct before continuing. If anything looks wrong, contact your agent before submitting — this information cannot be changed here.",
        )}
      </p>
      <div className="grid grid-cols-2 gap-3 pt-2">
        <div>
          <Label>{tx("Full Name")}</Label>
          <p className="text-sm text-slate-800 mt-1">{applicant.name}</p>
        </div>
        <div>
          <Label>{tx("CNIC")}</Label>
          <p className="text-sm text-slate-800 mt-1">{applicant.cnic ?? "—"}</p>
        </div>
        <div>
          <Label>{tx("Plan")}</Label>
          <p className="text-sm text-slate-800 mt-1">
            {applicant.product_name ?? "—"}
          </p>
        </div>
        <div>
          <Label>{tx("Coverage Amount")}</Label>
          <p className="text-sm text-slate-800 mt-1">
            {applicant.coverage_amount
              ? tx("PKR {0}", { 0: applicant.coverage_amount.toLocaleString() })
              : "—"}
          </p>
        </div>
        <div>
          <Label>{tx("Policy Term")}</Label>
          <p className="text-sm text-slate-800 mt-1">
            {applicant.term_years
              ? tx("{0} years", { 0: applicant.term_years })
              : "—"}
          </p>
        </div>
      </div>
      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span className="text-xs text-amber-900 leading-relaxed">
            <span className="font-bold">{tx("Disclaimer")}: </span>
            {tx(
            "I confirm the information I provide is correct. If it is not, I am responsible for any penalty under company policy.",
            )}
          </span>
        </label>
      </div>
    </div>
  );
}

// ── Step 2: Medical questionnaire (spec sections 3A–3D) ─────────────────────

function StepMedical({
  medical,
  setMedical,
}: {
  medical: MedicalQuestionnaire;
  setMedical: (v: MedicalQuestionnaire) => void;
}) {
  const currentConditions = medical?.conditions || emptyConditions();
  const currentHospitalizations = medical?.hospitalizations || [];
  const currentSurgeries = medical?.surgeries || [];
  const currentDisclosures = medical?.disclosures || {};

  const set = (patch: Partial<MedicalQuestionnaire>) =>
    setMedical({ ...medical, ...patch });

  const updateCondition = (key: string, patch: Partial<ConditionEntry>) =>
    set({
      conditions: currentConditions.map((c) =>
        c.key === key ? { ...c, ...patch } : c,
      ),
    });

  const setDisclosure = (key: string, patch: Partial<YesNoAnswer>) =>
    set({
      disclosures: {
        ...currentDisclosures,
        [key]: {
          ...(currentDisclosures[key] || { answer: "", details: "" }),
          ...patch,
        },
      },
    });

  const addHistoryEntry = (field: "hospitalizations" | "surgeries") =>
    set({
      [field]: [
        ...(medical?.[field] || []),
        { date: "", reason_or_type: "", hospital: "", duration: "" },
      ],
    } as any);
  const updateHistoryEntry = (
    field: "hospitalizations" | "surgeries",
    i: number,
    patch: Partial<HistoryEntry>,
  ) =>
    set({
      [field]: (medical?.[field] || []).map((e, idx) =>
        idx === i ? { ...e, ...patch } : e,
      ),
    } as any);
  const removeHistoryEntry = (
    field: "hospitalizations" | "surgeries",
    i: number,
  ) =>
    set({
      [field]: (medical?.[field] || []).filter((_, idx) => idx !== i),
    } as any);

  const bmi = bmiOf(medical?.height_cm || "", medical?.weight_kg || "");

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        {tx(
          "Please answer honestly and completely — non-disclosure of any fact may invalidate a future claim.",
        )}
      </p>

      {/* 3A — Basic Health Indicators */}
      <div>
        <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">
          {tx("Basic Health Indicators")}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <TextInput
            type="number"
            placeholder={tx("Height (cm)")}
            value={medical?.height_cm || ""}
            onChange={(e) => set({ height_cm: e.target.value })}
          />
          <TextInput
            type="number"
            placeholder={tx("Weight (kg)")}
            value={medical?.weight_kg || ""}
            onChange={(e) => set({ weight_kg: e.target.value })}
          />
          <div className="mt-1 flex items-center text-sm text-slate-500">
            {bmi ? tx("BMI: {0}", { 0: bmi }) : tx("BMI: —")}
          </div>
        </div>
        <div className="space-y-2 mt-3">
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={!!medical?.tobacco_use}
              onChange={(e) => set({ tobacco_use: e.target.checked })}
            />
            {tx("I use tobacco/nicotine products")}
          </label>
          {medical?.tobacco_use && (
            <TextInput
              placeholder={tx("Frequency (e.g. 10 cigarettes/day, 5 years)")}
              value={medical?.tobacco_frequency || ""}
              onChange={(e) => set({ tobacco_frequency: e.target.value })}
            />
          )}
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={!!medical?.alcohol_use}
              onChange={(e) => set({ alcohol_use: e.target.checked })}
            />
            {tx("I consume alcohol")}
          </label>
          {medical?.alcohol_use && (
            <TextInput
              placeholder={tx("Units per week")}
              value={medical?.alcohol_units_per_week || ""}
              onChange={(e) => set({ alcohol_units_per_week: e.target.value })}
            />
          )}
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={!!medical?.drug_use}
              onChange={(e) => set({ drug_use: e.target.checked })}
            />
            {tx("I have a history of drug/substance use")}
          </label>
          {medical?.drug_use && (
            <TextArea
              rows={2}
              placeholder={tx("Please give details")}
              value={medical?.drug_use_details || ""}
              onChange={(e) => set({ drug_use_details: e.target.value })}
            />
          )}
        </div>
      </div>

      {/* 3B/3C — Medical Conditions checklist + per-condition detail */}
      <div>
        <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">
          {tx("Medical Conditions")}
        </p>
        <p className="text-[11px] text-slate-500 mb-2">
          {tx(
            "Tick any that apply to you — a few extra details will be asked for each.",
          )}
        </p>
        <div className="space-y-3">
          {currentConditions.map((c) => (
            <div
              key={c.key}
              className="border border-slate-200 rounded-lg p-2.5"
            >
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={!!c.checked}
                  onChange={(e) =>
                    updateCondition(c.key, { checked: e.target.checked })
                  }
                />
                {tx(c.label)}
              </label>
              {c.checked && (
                <div className="grid grid-cols-2 gap-2 mt-2 pl-5">
                  <TextInput
                    placeholder={tx("Year of diagnosis")}
                    value={c.year_of_diagnosis || ""}
                    onChange={(e) =>
                      updateCondition(c.key, {
                        year_of_diagnosis: e.target.value,
                      })
                    }
                  />
                  <label className="flex items-center gap-1.5 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={!!c.under_treatment}
                      onChange={(e) =>
                        updateCondition(c.key, {
                          under_treatment: e.target.checked,
                        })
                      }
                    />
                    {tx("Currently under treatment")}
                  </label>
                  <TextInput
                    placeholder={tx("Medications (name, dosage, frequency)")}
                    value={c.medications || ""}
                    onChange={(e) =>
                      updateCondition(c.key, { medications: e.target.value })
                    }
                    className="col-span-2"
                  />
                  <TextInput
                    placeholder={tx("Attending physician name")}
                    value={c.physician_name || ""}
                    onChange={(e) =>
                      updateCondition(c.key, { physician_name: e.target.value })
                    }
                  />
                  <TextInput
                    placeholder={tx("Clinic/hospital")}
                    value={c.physician_clinic || ""}
                    onChange={(e) =>
                      updateCondition(c.key, {
                        physician_clinic: e.target.value,
                      })
                    }
                  />
                  <TextInput
                    placeholder={tx("Physician phone")}
                    value={c.physician_phone || ""}
                    onChange={(e) =>
                      updateCondition(c.key, {
                        physician_phone: e.target.value,
                      })
                    }
                  />
                  <TextInput
                    placeholder={tx("Last consultation date")}
                    value={c.last_consultation_date || ""}
                    onChange={(e) =>
                      updateCondition(c.key, {
                        last_consultation_date: e.target.value,
                      })
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hospitalizations & surgeries in the last 5 years */}
      <div>
        <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">
          {tx("Hospitalizations & Surgeries (last 5 years)")}
        </p>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={!!medical?.has_hospitalizations}
            onChange={(e) => set({ has_hospitalizations: e.target.checked })}
          />
          {tx("I have been hospitalized in the last 5 years")}
        </label>
        {medical?.has_hospitalizations && (
          <div className="space-y-2 mt-2">
            {currentHospitalizations.map((h, i) => (
              <div key={i} className="grid grid-cols-3 gap-2 items-center">
                <TextInput
                  placeholder={tx("Date")}
                  value={h.date || ""}
                  onChange={(e) =>
                    updateHistoryEntry("hospitalizations", i, {
                      date: e.target.value,
                    })
                  }
                />
                <TextInput
                  placeholder={tx("Reason")}
                  value={h.reason_or_type || ""}
                  onChange={(e) =>
                    updateHistoryEntry("hospitalizations", i, {
                      reason_or_type: e.target.value,
                    })
                  }
                />
                <div className="flex gap-1">
                  <TextInput
                    placeholder={tx("Hospital")}
                    value={h.hospital || ""}
                    onChange={(e) =>
                      updateHistoryEntry("hospitalizations", i, {
                        hospital: e.target.value,
                      })
                    }
                  />
                  <button
                    onClick={() => removeHistoryEntry("hospitalizations", i)}
                    className="text-xs text-red-600 font-semibold flex-shrink-0"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={() => addHistoryEntry("hospitalizations")}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700"
            >
              {tx("+ Add hospitalization")}
            </button>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-sm text-slate-700 mt-3">
          <input
            type="checkbox"
            checked={!!medical?.has_surgeries}
            onChange={(e) => set({ has_surgeries: e.target.checked })}
          />
          {tx("I have had surgery/a medical procedure in the last 5 years")}
        </label>
        {medical?.has_surgeries && (
          <div className="space-y-2 mt-2">
            {currentSurgeries.map((s, i) => (
              <div key={i} className="grid grid-cols-3 gap-2 items-center">
                <TextInput
                  placeholder={tx("Date")}
                  value={s.date || ""}
                  onChange={(e) =>
                    updateHistoryEntry("surgeries", i, { date: e.target.value })
                  }
                />
                <TextInput
                  placeholder={tx("Type of surgery")}
                  value={s.reason_or_type || ""}
                  onChange={(e) =>
                    updateHistoryEntry("surgeries", i, {
                      reason_or_type: e.target.value,
                    })
                  }
                />
                <div className="flex gap-1">
                  <TextInput
                    placeholder={tx("Hospital")}
                    value={s.hospital || ""}
                    onChange={(e) =>
                      updateHistoryEntry("surgeries", i, {
                        hospital: e.target.value,
                      })
                    }
                  />
                  <button
                    onClick={() => removeHistoryEntry("surgeries", i)}
                    className="text-xs text-red-600 font-semibold flex-shrink-0"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={() => addHistoryEntry("surgeries")}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700"
            >
              {tx("+ Add surgery/procedure")}
            </button>
          </div>
        )}
      </div>

      {/* Additional regulatory disclosures */}
      <div>
        <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">
          {tx("Additional Disclosures")}
        </p>
        {ADDITIONAL_DISCLOSURES.map((q) => (
          <div
            key={q.key}
            className="border-b border-slate-100 py-2.5 last:border-0"
          >
            <p className="text-sm text-slate-700">{tx(q.label)}</p>
            <div className="flex gap-4 mt-1.5">
              {(["Yes", "No"] as const).map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-1.5 text-sm text-slate-600"
                >
                  <input
                    type="radio"
                    name={q.key}
                    checked={currentDisclosures[q.key]?.answer === opt}
                    onChange={() => setDisclosure(q.key, { answer: opt })}
                  />
                  {opt}
                </label>
              ))}
            </div>
            {currentDisclosures[q.key]?.answer === "Yes" && (
              <TextArea
                placeholder={tx("Please provide details")}
                rows={2}
                value={currentDisclosures[q.key]?.details ?? ""}
                onChange={(e) =>
                  setDisclosure(q.key, { details: e.target.value })
                }
              />
            )}
          </div>
        ))}
      </div>

      {/* Additional custom questions specified by portal user */}
      {(medical as any).custom_questions &&
        (medical as any).custom_questions.length > 0 && (
          <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-blue-900 uppercase tracking-wide">
              {tx("Additional Questions Requested by Underwriter")}
            </p>
            {(medical as any).custom_questions.map((cq: any, idx: number) => (
              <div
                key={cq.id || idx}
                className="bg-white border border-slate-200 rounded-lg p-3 space-y-2"
              >
                <p className="text-sm font-medium text-slate-800">
                  {cq.question}
                </p>
                {cq.type === "yes_no" ? (
                  <div className="flex gap-4">
                    {["Yes", "No"].map((opt) => (
                      <label
                        key={opt}
                        className="flex items-center gap-1.5 text-sm text-slate-700"
                      >
                        <input
                          type="radio"
                          name={`cq_${cq.id || idx}`}
                          checked={cq.answer === opt}
                          onChange={() => {
                            const updated = [
                              ...(medical as any).custom_questions,
                            ];
                            updated[idx] = { ...cq, answer: opt };
                            setMedical({
                              ...medical,
                              custom_questions: updated,
                            } as any);
                          }}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                ) : (
                  <TextInput
                    placeholder={tx("Your answer")}
                    value={cq.answer || ""}
                    onChange={(e) => {
                      const updated = [...(medical as any).custom_questions];
                      updated[idx] = { ...cq, answer: e.target.value };
                      setMedical({
                        ...medical,
                        custom_questions: updated,
                      } as any);
                    }}
                  />
                )}
                {cq.type === "yes_no" && cq.answer === "Yes" && (
                  <TextArea
                    placeholder={tx("Please provide details")}
                    rows={2}
                    value={cq.details || ""}
                    onChange={(e) => {
                      const updated = [...(medical as any).custom_questions];
                      updated[idx] = { ...cq, details: e.target.value };
                      setMedical({
                        ...medical,
                        custom_questions: updated,
                      } as any);
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Step 3: Family history ───────────────────────────────────────────────────

function StepFamilyHistory({
  entries,
  setEntries,
}: {
  entries: FamilyHistoryEntry[];
  setEntries: (v: FamilyHistoryEntry[]) => void;
}) {
  const addRow = () =>
    setEntries([
      ...entries,
      {
        relation: "",
        name: "",
        age: "",
        is_alive: true,
        condition: "",
        age_at_onset: "",
      },
    ]);
  const updateRow = (i: number, patch: Partial<FamilyHistoryEntry>) =>
    setEntries(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const removeRow = (i: number) =>
    setEntries(entries.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {tx(
          "List any medical conditions in your immediate family (parents, siblings, children) — e.g. heart disease, diabetes, cancer, or other hereditary conditions. Leave blank if none apply.",
        )}
      </p>
      {entries.map((e, i) => (
        <div
          key={i}
          className="border border-slate-200 rounded-lg p-3 space-y-2"
        >
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>{tx("Relation")}</Label>
              <select
                value={e.relation}
                onChange={(ev) => updateRow(i, { relation: ev.target.value })}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="">{tx("Select")}</option>
                <option>{tx("Father")}</option>
                <option>{tx("Mother")}</option>
                <option>{tx("Brother")}</option>
                <option>{tx("Sister")}</option>
                <option>{tx("Son")}</option>
                <option>{tx("Daughter")}</option>
              </select>
            </div>
            <TextInput
              placeholder={tx("Name")}
              value={e.name}
              onChange={(ev) => updateRow(i, { name: ev.target.value })}
            />
            <TextInput
              placeholder={tx("Current / age at death")}
              value={e.age}
              onChange={(ev) => updateRow(i, { age: ev.target.value })}
            />
            <label className="flex items-center gap-1.5 text-sm text-slate-600 mt-1">
              <input
                type="checkbox"
                checked={e.is_alive}
                onChange={(ev) => updateRow(i, { is_alive: ev.target.checked })}
              />
              {tx("Living")}
            </label>
            <TextInput
              placeholder={tx("Condition (e.g. Diabetes)")}
              value={e.condition}
              onChange={(ev) => updateRow(i, { condition: ev.target.value })}
            />
            <TextInput
              placeholder={tx("Age at onset")}
              value={e.age_at_onset}
              onChange={(ev) => updateRow(i, { age_at_onset: ev.target.value })}
            />
          </div>
          <button
            onClick={() => removeRow(i)}
            className="text-xs text-red-600 font-semibold"
          >
            {tx("Remove")}
          </button>
        </div>
      ))}
      <button
        onClick={addRow}
        className="text-sm font-semibold text-blue-600 hover:text-blue-700"
      >
        {tx("+ Add family member")}
      </button>
    </div>
  );
}

// ── Step 4: Lifestyle & habits ───────────────────────────────────────────────

function StepLifestyle({
  lifestyle,
  setLifestyle,
}: {
  lifestyle: any;
  setLifestyle: (v: any) => void;
}) {
  const set = (patch: any) => setLifestyle({ ...lifestyle, ...patch });
  return (
    <div className="space-y-4">
      <div>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lifestyle.has_hazardous_hobby}
            onChange={(e) => set({ has_hazardous_hobby: e.target.checked })}
          />
          {tx(
            "I participate in hazardous hobbies (e.g. scuba diving, rock climbing, motor racing, skydiving)",
          )}
        </label>
        {lifestyle.has_hazardous_hobby && (
          <TextArea
            rows={2}
            placeholder={tx("Please give details")}
            value={lifestyle.hazardous_hobby_details}
            onChange={(e) => set({ hazardous_hobby_details: e.target.value })}
          />
        )}
      </div>
      <div>
        <Label>{tx("Occupation hazard level")}</Label>
        <select
          value={lifestyle.occupation_hazard_level}
          onChange={(e) => set({ occupation_hazard_level: e.target.value })}
          className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
        >
          <option>{tx("Low")}</option>
          <option>{tx("Medium")}</option>
          <option>{tx("High")}</option>
        </select>
      </div>
      <div>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lifestyle.frequent_foreign_travel}
            onChange={(e) => set({ frequent_foreign_travel: e.target.checked })}
          />
          {tx("I travel abroad frequently")}
        </label>
        {lifestyle.frequent_foreign_travel && (
          <TextArea
            rows={2}
            placeholder={tx("Countries / frequency")}
            value={lifestyle.foreign_travel_details}
            onChange={(e) => set({ foreign_travel_details: e.target.value })}
          />
        )}
      </div>
      <div>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lifestyle.road_travel_frequent}
            onChange={(e) => set({ road_travel_frequent: e.target.checked })}
          />
          {tx("I travel long distances by road regularly")}
        </label>
        {lifestyle.road_travel_frequent && (
          <div className="mt-2 space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{tx("Road trips per month")}</Label>
                <TextInput
                  type="number"
                  min={0}
                  value={lifestyle.road_trips_per_month}
                  onChange={(e) => set({ road_trips_per_month: e.target.value })}
                />
              </div>
              <div>
                <Label>{tx("Typical trip length (hours)")}</Label>
                <TextInput
                  type="number"
                  min={0}
                  value={lifestyle.road_trip_hours}
                  onChange={(e) => set({ road_trip_hours: e.target.value })}
                />
              </div>
            </div>
            <TextArea
              rows={2}
              placeholder={tx("Routes and vehicle (e.g. motorway, own car, motorcycle, bus)")}
              value={lifestyle.road_travel_details}
              onChange={(e) => set({ road_travel_details: e.target.value })}
            />
          </div>
        )}
      </div>
      <div>
        <Label>{tx("Moving traffic violations (past 3 years)")}</Label>
        <TextInput
          type="number"
          min={0}
          value={lifestyle.moving_violations_past_3_years}
          onChange={(e) =>
            set({ moving_violations_past_3_years: e.target.value })
          }
        />
      </div>
      <label className="flex items-center gap-1.5 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={lifestyle.dui_dwi_history}
          onChange={(e) => set({ dui_dwi_history: e.target.checked })}
        />
        {tx("I have a DUI/DWI history")}
      </label>
      <label className="flex items-center gap-1.5 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={lifestyle.criminal_record}
          onChange={(e) => set({ criminal_record: e.target.checked })}
        />
        {tx("I have a criminal record or pending case")}
      </label>
    </div>
  );
}

// ── Step 5: Existing insurance ───────────────────────────────────────────────

function StepExistingInsurance({
  data,
  setData,
}: {
  data: any;
  setData: (v: any) => void;
}) {
  const set = (patch: any) => setData({ ...data, ...patch });
  const addPolicy = () =>
    set({
      policies: [
        ...data.policies,
        {
          insurer_name: "",
          policy_number: "",
          sum_assured: "",
          status: "Active",
        },
      ],
    });
  const updatePolicy = (i: number, patch: Partial<ExistingPolicy>) =>
    set({
      policies: data.policies.map((p: ExistingPolicy, idx: number) =>
        idx === i ? { ...p, ...patch } : p,
      ),
    });
  const removePolicy = (i: number) =>
    set({ policies: data.policies.filter((_: any, idx: number) => idx !== i) });

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-1.5 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={data.has_existing_policies}
          onChange={(e) => set({ has_existing_policies: e.target.checked })}
        />
        {tx("I have existing life insurance policy/policies with any insurer")}
      </label>
      {data.has_existing_policies && (
        <div className="space-y-2">
          {data.policies.map((p: ExistingPolicy, i: number) => (
            <div
              key={i}
              className="border border-slate-200 rounded-lg p-3 grid grid-cols-2 gap-2"
            >
              <TextInput
                placeholder={tx("Insurer name")}
                value={p.insurer_name}
                onChange={(e) =>
                  updatePolicy(i, { insurer_name: e.target.value })
                }
              />
              <TextInput
                placeholder={tx("Policy number")}
                value={p.policy_number}
                onChange={(e) =>
                  updatePolicy(i, { policy_number: e.target.value })
                }
              />
              <TextInput
                placeholder={tx("Sum assured (PKR)")}
                value={p.sum_assured}
                onChange={(e) =>
                  updatePolicy(i, { sum_assured: e.target.value })
                }
              />
              <select
                value={p.status}
                onChange={(e) =>
                  updatePolicy(i, {
                    status: e.target.value as ExistingPolicy["status"],
                  })
                }
                className="text-sm border border-slate-200 rounded-lg px-3 py-2"
              >
                <option>{tx("Active")}</option>
                <option>{tx("Lapsed")}</option>
                <option>{tx("Surrendered")}</option>
              </select>
              <button
                onClick={() => removePolicy(i)}
                className="col-span-2 text-xs text-red-600 font-semibold text-left"
              >
                {tx("Remove")}
              </button>
            </div>
          ))}
          <button
            onClick={addPolicy}
            className="text-sm font-semibold text-blue-600 hover:text-blue-700"
          >
            {tx("+ Add policy")}
          </button>
        </div>
      )}
      <div>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={data.applied_last_2_years}
            onChange={(e) => set({ applied_last_2_years: e.target.checked })}
          />
          {tx("I applied for life insurance in the last 2 years")}
        </label>
        {data.applied_last_2_years && (
          <label className="flex items-center gap-1.5 text-sm text-slate-700 mt-1.5 ml-5">
            <input
              type="checkbox"
              checked={data.was_declined_or_deferred}
              onChange={(e) =>
                set({ was_declined_or_deferred: e.target.checked })
              }
            />
            {tx("That application was deferred, declined, or rated")}
          </label>
        )}
        {data.was_declined_or_deferred && (
          <TextArea
            rows={2}
            placeholder={tx("Please give details")}
            value={data.declined_details}
            onChange={(e) => set({ declined_details: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

// ── Step 6: Declaration & e-signature ────────────────────────────────────────

function StepDeclaration({
  declaration,
  setDeclaration,
}: {
  declaration: any;
  setDeclaration: (v: any) => void;
}) {
  const set = (patch: any) => setDeclaration({ ...declaration, ...patch });
  const items: { key: string; label: string }[] = [
    {
      key: "confirms_accurate",
      label:
        "I confirm that all information provided is true and complete to the best of my knowledge.",
    },
    {
      key: "authorizes_records_access",
      label:
        "I authorize the insurer to obtain any medical, financial, or other records needed for underwriting.",
    },
    {
      key: "not_signed_blank",
      label:
        "I have not signed a blank form, and I understand all my answers form part of the insurance contract.",
    },
    {
      key: "understood_terms",
      label:
        "I have received and understood the policy benefits, exclusions, and free-look/cooling-off period terms.",
    },
  ];
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {items.map((it) => (
          <label
            key={it.key}
            className="flex items-start gap-2 text-sm text-slate-700"
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!!declaration[it.key]}
              onChange={(e) => set({ [it.key]: e.target.checked })}
            />
            {tx(it.label)}
          </label>
        ))}
      </div>
      <div>
        <Label>
          {tx("Type your full legal name as your electronic signature")}
        </Label>
        <TextInput
          placeholder={tx("Full name")}
          value={declaration.signature_name}
          onChange={(e) => set({ signature_name: e.target.value })}
        />
        <p className="text-[11px] text-slate-400 mt-1">
          {tx(
            "By typing your name and submitting, this constitutes your legal electronic signature.",
          )}
        </p>
      </div>
    </div>
  );
}
