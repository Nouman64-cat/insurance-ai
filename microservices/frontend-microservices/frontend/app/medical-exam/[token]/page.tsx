"use client";

import { displayDate, displayDateTime } from '../../../lib/dateDisplay';
// Customer report submission, scoped by an expiring examination link.
import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { tx } from "@/lib/i18n/tx";

const publicApi = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL, timeout: 30_000 });
interface Clinic {
  id: string;
  name: string;
  network: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  home_sampling: boolean;
}
interface ExamView {
  status: string;
  customer_name: string;
  customer_city: string | null;
  tests: { code: string; name: string; description: string; fasting: boolean }[];
  preparation_notes: string[];
  clinics: Clinic[];
  slots: string[];
  appointment_at: string | null;
  booked_clinic: Clinic | null;
  expires_at: string | null;
}

export default function MedicalExamPage({ params }: { params: { token: string } }) {
  const [view, setView] = useState<ExamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [city, setCity] = useState("all");
  const [clinicId, setClinicId] = useState("");
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [saving, setSaving] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
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
  const booked = view.status === "Scheduled" || !!view.booked_clinic;
  const days = Array.from(new Set(view.slots.map((s) => s.slice(0, 10))));
  const times = view.slots.filter((s) => s.startsWith(day));
  const book = async () => {
    setSaving(true); setBookError(null);
    try {
      await publicApi.post(`/public/medical-exam/${params.token}/book`, { clinic_id: clinicId, appointment_at: slot });
      const { data } = await publicApi.get<ExamView>(`/public/medical-exam/${params.token}`);
      setView(data);
    } catch (e: any) {
      setBookError(e.response?.data?.detail ?? "Unable to book. Please try again.");
    } finally { setSaving(false); }
  };
  return <div className="min-h-screen bg-slate-50">
    <header className="border-b border-slate-200 bg-white px-6 py-3"><div className="mx-auto max-w-[1440px] flex items-center justify-between">
      <div><span className="block text-sm font-extrabold text-slate-900">{tx("Adamjee Life")}</span><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Health Diagnostics Portal</span></div>
      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-bold text-slate-500">OFFICIAL PORTAL</span>
    </div></header>
    <main className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Medical examination</p>
        <h1 className="mt-1 text-lg font-extrabold text-slate-900">Hi {view.customer_name}, {reviewed ? "your medical examination is complete" : "your medical examination"}</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">Choose an approved lab and a time. The lab's doctor will upload your reports directly — you don't need to upload anything.</p>
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] items-start">
        <div className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-900">Your required tests</h2>
            <ul className="mt-3 space-y-2">{view.tests.map((t) => <li key={t.code} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <p className="text-xs font-bold text-slate-800">{t.name}{t.fasting && <span className="ml-2 text-[10px] font-semibold text-amber-700">Fasting</span>}</p>
              {t.description && <p className="mt-1 text-[11px] text-slate-500">{t.description}</p>}
            </li>)}</ul>
          </section>
          {reviewed ? <section role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">Your insurer has reviewed your medical results. No further action is needed.</section>
          : booked ? <section role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">
              <p className="font-bold">Your appointment is booked</p>
              {view.booked_clinic && <p className="mt-1">{view.booked_clinic.name}{view.booked_clinic.address ? `, ${view.booked_clinic.address}` : ""}</p>}
              {view.appointment_at && <p className="mt-1">{displayDateTime(view.appointment_at)}</p>}
              <p className="mt-2 text-xs">The lab has been notified and its doctor will upload your reports. You don't need to upload anything.</p>
            </section>
          : <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-bold text-slate-900">Choose your lab and time</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="text-[11px] font-semibold text-slate-600">Lab
                  <select value={clinicId} onChange={(e) => setClinicId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal">
                    <option value="">Select a lab…</option>{clinics.map((c) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ""}</option>)}
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-600">Date
                  <select value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal">
                    <option value="">Select a date…</option>{days.map((d) => <option key={d} value={d}>{displayDate(d)}</option>)}
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-600">Time
                  <select value={slot} onChange={(e) => setSlot(e.target.value)} disabled={!day} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal disabled:opacity-50">
                    <option value="">Select a time…</option>{times.map((t) => <option key={t} value={t}>{t.slice(11, 16)}</option>)}
                  </select>
                </label>
              </div>
              {bookError && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{bookError}</p>}
              <button onClick={book} disabled={!clinicId || !slot || saving} className="mt-4 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40">{saving ? "Booking…" : "Confirm booking"}</button>
            </section>}
        </div>
        <aside className="space-y-3">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-900">Approved labs & centres</h2>
            <p className="mt-1 text-[11px] text-slate-500">Please visit one of these approved centres.</p>
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
          {view.expires_at && <p className="px-1 text-[10px] text-slate-400">This link is valid until {displayDate(view.expires_at)}.</p>}
        </aside>
      </div>
    </main>
  </div>;
}
