"use client";

// Public medical-examination booking — no login. Reached via a tokenized link
// an underwriter/agent generates from a case once the non-medical limit grid
// mandates physical diagnostics (see /case/[id] "Medical Examination").
//
// Deliberately does NOT use app/services/api.ts — that shared instance
// redirects to /login on 401 and attaches whatever staff JWT happens to be in
// this browser's localStorage, neither of which is correct for a customer
// booking their own appointment. Same reasoning as the public E-Application.

import { useEffect, useMemo, useState } from "react";
import axios from "axios";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

const publicApi = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

type LoadState = "loading" | "ready" | "not_found" | "expired" | "booked" | "done" | "error";

interface Test {
  code: string;
  name: string;
  category: string;
  fasting: boolean;
  description: string;
}

interface Clinic {
  id: string;
  code: string;
  name: string;
  network: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  home_sampling: boolean;
  turnaround_hours: number;
}

interface ExamView {
  status: string;
  customer_name: string;
  customer_city: string | null;
  product_name: string | null;
  coverage_amount: number | null;
  tests: Test[];
  fasting_required: boolean;
  preparation_notes: string[];
  cost_borne_by_insurer: boolean;
  clinics: Clinic[];
  slots: string[];
  appointment_at: string | null;
  booked_clinic: Clinic | null;
  home_sampling: boolean;
  expires_at: string | null;
}

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });

function CenteredMessage({
  title, body, tone = "neutral",
}: Readonly<{ title: string; body?: string; tone?: "neutral" | "error" | "success" }>) {
  const ring =
    tone === "error" ? "border-red-200 bg-red-50"
      : tone === "success" ? "border-emerald-200 bg-emerald-50"
      : "border-slate-200 bg-white";
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className={`max-w-md w-full rounded-2xl border p-8 text-center shadow-sm ${ring}`}>
        <h1 className="text-lg font-bold text-slate-800">{title}</h1>
        {body && <p className="text-sm text-slate-500 mt-2 leading-relaxed">{body}</p>}
      </div>
    </div>
  );
}

export default function MedicalExamBookingPage({ params }: { params: { token: string } }) {
  const { token } = params;

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [view, setView] = useState<ExamView | null>(null);

  const [clinicId, setClinicId] = useState<string>("");
  const [slot, setSlot] = useState<string>("");
  const [homeSampling, setHomeSampling] = useState(false);
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await publicApi.get<ExamView>(`/public/medical-exam/${token}`);
        setView(res.data);
        if (res.data.customer_city) setCityFilter(res.data.customer_city);
        if (res.data.status === "Completed") {
          setLoadState("done");
        } else if (res.data.status === "Scheduled") {
          setLoadState("booked");
        } else {
          setLoadState("ready");
        }
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 410) setLoadState("expired");
        else if (status === 404) setLoadState("not_found");
        else setLoadState("error");
        setErrorMsg(e?.response?.data?.detail ?? "Something went wrong loading your appointment page.");
      }
    })();
  }, [token]);

  const cities = useMemo(() => {
    const set = new Set((view?.clinics ?? []).map((c) => c.city).filter(Boolean) as string[]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [view]);

  const visibleClinics = useMemo(() => {
    const all = view?.clinics ?? [];
    return cityFilter === "all" ? all : all.filter((c) => c.city === cityFilter);
  }, [view, cityFilter]);

  const selectedClinic = visibleClinics.find((c) => c.id === clinicId) ?? null;

  // Group the offered slots by day so the customer picks a date, then a time —
  // a flat list of 90 timestamps is unusable on a phone.
  const slotsByDay = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const s of view?.slots ?? []) {
      const day = s.slice(0, 10);
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day)!.push(s);
    }
    return Array.from(grouped.entries());
  }, [view]);

  const [selectedDay, setSelectedDay] = useState<string>("");

  const [completing, setCompleting] = useState(false);
  const [completeErr, setCompleteErr] = useState<string | null>(null);

  const completeExam = async () => {
    setCompleting(true);
    setCompleteErr(null);
    try {
      await publicApi.post(`/public/medical-exam/${token}/complete`);
      setView((v) => (v ? { ...v, status: "Completed" } : v));
      setLoadState("done");
    } catch (e: any) {
      setCompleteErr(e?.response?.data?.detail ?? "Failed to mark examination as completed.");
    } finally {
      setCompleting(false);
    }
  };

  const book = async () => {
    if (!clinicId || !slot) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const res = await publicApi.post(`/public/medical-exam/${token}/book`, {
        clinic_id: clinicId,
        appointment_at: slot,
        home_sampling: homeSampling,
      });
      setView((v) => v ? {
        ...v,
        status: "Scheduled",
        appointment_at: res.data.appointment_at,
        booked_clinic: res.data.clinic,
        home_sampling: res.data.home_sampling,
      } : v);
      setLoadState("booked");
    } catch (e: any) {
      setSubmitErr(e?.response?.data?.detail ?? "We couldn't confirm that appointment. Please try another slot.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadState === "loading") return <CenteredMessage title="Loading your appointment page…" />;
  if (loadState === "not_found" || loadState === "error") {
    return (
      <CenteredMessage
        title="We couldn't find this appointment"
        body={errorMsg ?? "The link may be invalid. Please contact your agent for a new one."}
        tone="error"
      />
    );
  }
  if (loadState === "expired") {
    return (
      <CenteredMessage
        title="This booking link has expired"
        body="Please contact your agent or the branch to have a new link sent to you."
        tone="error"
      />
    );
  }
  if (loadState === "done") {
    return (
      <CenteredMessage
        title="Your medical examination is complete"
        body="Your insurer has received the results. No further action is needed from you at this time."
        tone="success"
      />
    );
  }

  if (!view) return <CenteredMessage title="Loading…" />;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Brand Header for External Applicants */}
      <header className="bg-white border-b border-slate-200/80 px-6 py-4 sticky top-0 z-10 shadow-2xs">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-sm shadow-xs">
              🛡️
            </div>
            <div>
              <span className="font-extrabold text-slate-900 text-sm tracking-tight block">Adamjee Life</span>
              <span className="text-[10px] font-semibold text-slate-500 block uppercase tracking-wider">Health Diagnostics Portal</span>
            </div>
          </div>
          <span className="text-[10px] font-bold text-slate-500 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-full uppercase tracking-wider">
            Official Portal
          </span>
        </div>
      </header>

      <main className="flex-1 py-8 px-4">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-2xs">
            <p className="text-[11px] font-extrabold uppercase tracking-wider text-blue-600">
              Life Insurance — Health Examination Booking
            </p>
            <h1 className="text-xl font-extrabold text-slate-900 mt-1">
              Hi {view.customer_name || "there"}, let's book your health checkup
            </h1>
            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
              Your proposed insurance cover requires a short medical examination before policy issuance.
              This examination is arranged and <strong className="text-slate-700">fully paid for by the insurer</strong> — there is no fee for you to pay.
            </p>
          </div>

        {/* Already booked */}
        {loadState === "booked" && view.booked_clinic && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/90 p-5 shadow-xs">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                Appointment confirmed
              </p>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                Scheduled at Clinic
              </span>
            </div>
            <h2 className="text-base font-bold text-slate-800 mt-2">{view.booked_clinic.name}</h2>
            <p className="text-sm text-slate-600 mt-0.5">{view.booked_clinic.address}</p>
            {view.booked_clinic.phone && (
              <p className="text-xs text-slate-500 mt-0.5">Tel: {view.booked_clinic.phone}</p>
            )}
            <p className="text-sm font-semibold text-slate-800 mt-3">
              {view.appointment_at ? `${fmtDay(view.appointment_at)} at ${fmtTime(view.appointment_at)}` : "—"}
            </p>
            {view.home_sampling && (
              <p className="text-xs text-emerald-700 font-medium mt-1">
                A phlebotomist will visit you at home for sample collection.
              </p>
            )}

            {completeErr && (
              <p className="mt-3 text-xs text-red-600 font-semibold bg-red-50 border border-red-200 rounded-lg p-2.5">
                {completeErr}
              </p>
            )}

            <div className="mt-5 pt-4 border-t border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <button
                onClick={() => setLoadState("ready")}
                className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 underline underline-offset-2"
              >
                Change my appointment
              </button>

              <button
                onClick={completeExam}
                disabled={completing}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs rounded-xl shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {completing ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Updating Status…</span>
                  </>
                ) : (
                  <>
                    <span>✓</span>
                    <span>Mark Examination as Completed (Done)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}


        {/* Tests */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold text-slate-800">
            Tests requested ({view.tests.length})
          </h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {view.tests.map((t) => (
              <li key={t.code} className="py-2 flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{t.name}</p>
                  <p className="text-xs text-slate-500 leading-relaxed">{t.description}</p>
                </div>
                {t.fasting && (
                  <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                    FASTING
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Preparation */}
        <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-5">
          <h2 className="text-sm font-bold text-slate-800">How to prepare</h2>
          <ul className="mt-2 space-y-1.5">
            {view.preparation_notes.map((n, i) => (
              <li key={i} className="text-xs text-slate-600 leading-relaxed flex gap-2">
                <span className="text-blue-500 font-bold shrink-0">•</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>

        {loadState === "ready" && (
          <>
            {/* Clinic */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-bold text-slate-800">Choose a collection centre</h2>
                <select
                  value={cityFilter}
                  onChange={(e) => { setCityFilter(e.target.value); setClinicId(""); }}
                  className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600"
                >
                  <option value="all">All cities</option>
                  {cities.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div className="mt-3 space-y-2">
                {visibleClinics.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No panel centre listed in that city — switch to "All cities" to see the full panel.
                  </p>
                ) : visibleClinics.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setClinicId(c.id); if (!c.home_sampling) setHomeSampling(false); }}
                    className={`w-full text-left rounded-xl border px-3.5 py-3 transition-all ${
                      clinicId === c.id
                        ? "border-blue-400 bg-blue-50/60 ring-1 ring-blue-500/20"
                        : "border-slate-200 hover:border-slate-300 bg-white"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{c.name}</p>
                        <p className="text-xs text-slate-500 truncate">{c.address}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {c.city} · results in ~{c.turnaround_hours}h
                          {c.phone ? ` · ${c.phone}` : ""}
                        </p>
                      </div>
                      {c.home_sampling && (
                        <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                          HOME VISIT
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>

              {selectedClinic?.home_sampling && (
                <label className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={homeSampling}
                    onChange={(e) => setHomeSampling(e.target.checked)}
                    className="rounded text-blue-600 focus:ring-blue-500"
                  />
                  Collect my samples at home instead of at the centre
                </label>
              )}
            </div>

            {/* Slot */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-bold text-slate-800">Pick a date and time</h2>
              {view.fasting_required && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
                  Your tests require fasting, so only morning appointments are offered — a fasting
                  sample cannot be drawn in the afternoon.
                </p>
              )}

              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {slotsByDay.map(([day]) => (
                  <button
                    key={day}
                    onClick={() => { setSelectedDay(day); setSlot(""); }}
                    className={`shrink-0 px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${
                      selectedDay === day
                        ? "border-blue-400 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {fmtDay(`${day}T09:00:00`)}
                  </button>
                ))}
              </div>

              {selectedDay && (
                <div className="mt-3 grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {(slotsByDay.find(([d]) => d === selectedDay)?.[1] ?? []).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSlot(s)}
                      className={`px-2 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                        slot === s
                          ? "border-blue-400 bg-blue-600 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {fmtTime(s)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {submitErr && (
              <p className="text-xs text-red-600 font-semibold bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {submitErr}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 pb-8">
              <p className="text-[11px] text-slate-400">
                {view.expires_at && `This link is valid until ${new Date(view.expires_at).toLocaleDateString()}.`}
              </p>
              <button
                onClick={book}
                disabled={!clinicId || !slot || submitting}
                className="px-5 py-2.5 rounded-xl text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Confirming…" : "Confirm appointment"}
              </button>
            </div>
          </>
        )}
        </div>
      </main>
    </div>
  );
}
