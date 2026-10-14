"use client";

// Customer report submission, scoped by an expiring examination link.
import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import MedicalReportUploads, { type MedicalReport } from "@/components/MedicalReportUploads";
import { tx } from "@/lib/i18n/tx";

const publicApi = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL, timeout: 30_000 });
interface Clinic {
  id: string;
  name: string;
  network: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
}
interface ExamView {
  status: string;
  customer_name: string;
  customer_city: string | null;
  tests: { code: string; name: string; description: string; fasting: boolean }[];
  reports: MedicalReport[];
  reports_submitted: boolean;
  preparation_notes: string[];
  clinics: Clinic[];
  expires_at: string | null;
}

export default function MedicalExamPage({ params }: { params: { token: string } }) {
  const [view, setView] = useState<ExamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [city, setCity] = useState("all");
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await publicApi.get<ExamView>(`/public/medical-exam/${params.token}`);
        if (!active) return;
        setView(data);
        if (data.customer_city && data.clinics.some((clinic) => clinic.city === data.customer_city)) setCity(data.customer_city);
      } catch (e: any) {
        if (active) setError(e.response?.data?.detail ?? "Unable to load your medical examination. Please try again.");
      }
    })();
    return () => { active = false; };
  }, [params.token]);
  const cities = useMemo(() => Array.from(new Set((view?.clinics ?? []).map((clinic) => clinic.city).filter(Boolean) as string[])).sort(), [view]);
  const clinics = (view?.clinics ?? []).filter((clinic) => city === "all" || clinic.city === city);
  if (error || !view) return <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6"><div role={error ? "alert" : "status"} className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600">{error ?? "Loading your medical examination…"}</div></div>;
  const reviewed = view.status === "Completed";
  return <div className="min-h-screen bg-slate-50">
    <header className="border-b border-slate-200 bg-white px-6 py-3"><div className="mx-auto max-w-[1440px] flex items-center justify-between">
      <div><span className="block text-sm font-extrabold text-slate-900">{tx("Adamjee Life")}</span><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Health Diagnostics Portal</span></div>
      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-bold text-slate-500">OFFICIAL PORTAL</span>
    </div></header>
    <main className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Medical examination & reports</p>
        <h1 className="mt-1 text-lg font-extrabold text-slate-900">Hi {view.customer_name}, {reviewed ? "your medical examination is complete" : "upload your medical reports"}</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">Complete the required tests at an approved lab or centre listed here, then upload your results for medical review. Contact the centre directly for visiting arrangements.</p>
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] items-start">
        {reviewed ? <section role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">Your insurer has reviewed your medical results. No further report uploads are needed at this time.</section> :
          <MedicalReportUploads token={params.token} tests={view.tests} reports={view.reports ?? []} submitted={!!view.reports_submitted}
            onChange={(update) => setView((current) => current ? { ...current, ...update } : current)} />}
        <aside className="space-y-3">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-900">Approved labs & centres</h2>
            <p className="mt-1 text-[11px] text-slate-500">Only reports from approved centres should be submitted.</p>
            <label className="mt-3 block text-[11px] font-semibold text-slate-600">City
              <select value={city} onChange={(event) => setCity(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal" aria-label="Filter approved centres by city">
                <option value="all">All cities</option>{cities.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <ul className="mt-3 max-h-[340px] overflow-y-auto space-y-2">
              {clinics.map((clinic) => <li key={clinic.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <h3 className="text-xs font-bold text-slate-800">{clinic.name}</h3>
                {clinic.address && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{clinic.address}</p>}
                {clinic.city && <p className="mt-1 text-[10px] font-semibold text-slate-500">{clinic.city}</p>}
                {clinic.phone && <a href={`tel:${clinic.phone}`} className="mt-1 inline-block text-[11px] font-semibold text-blue-600">{clinic.phone}</a>}
              </li>)}
            </ul>
            {!clinics.length && <p role="status" className="mt-3 text-xs text-slate-500">No approved centres are listed for this city. Contact your agent for help.</p>}
          </section>
          <details className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
            <summary className="cursor-pointer text-xs font-bold text-slate-800">Preparing for your tests</summary>
            <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-slate-600">{view.preparation_notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
          </details>
          {view.expires_at && <p className="px-1 text-[10px] text-slate-400">This report link is valid until {new Date(view.expires_at).toLocaleDateString()}.</p>}
        </aside>
      </div>
    </main>
  </div>;
}
