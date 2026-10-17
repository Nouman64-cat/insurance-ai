"use client";

import { displayDate, displayDateTime } from "../../../lib/dateDisplay";
// Lab/doctor report upload, scoped by an expiring link issued when the customer booked this lab.
import { useEffect, useState } from "react";
import axios from "axios";
import MedicalReportUploads, { type MedicalReport } from "@/components/MedicalReportUploads";

const publicApi = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL, timeout: 30_000 });
interface LabView {
  status: string;
  lab_name: string;
  case_number: string | null;
  applicant: { name: string; cnic: string | null; age: number | null; gender: string | null };
  appointment_at: string | null;
  home_sampling: boolean;
  tests: { code: string; name: string; description: string; fasting: boolean }[];
  fasting_required: boolean;
  reports: MedicalReport[];
  reports_submitted: boolean;
  expires_at: string | null;
}

export default function MedicalLabPage({ params }: { params: { token: string } }) {
  const [view, setView] = useState<LabView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await publicApi.get<LabView>(`/public/medical-lab/${params.token}`);
        if (active) setView(data);
      } catch (e: any) {
        if (active) setError(e.response?.data?.detail ?? "Unable to load this examination. Please try again.");
      }
    })();
    return () => { active = false; };
  }, [params.token]);
  if (error || !view) return <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6"><div role={error ? "alert" : "status"} className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600">{error ?? "Loading…"}</div></div>;
  const closed = ["Completed", "Waived"].includes(view.status);
  const detail = (label: string, value: string | number | null) => <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-0.5 text-sm text-slate-800">{value ?? "—"}</p></div>;
  return <div className="min-h-screen bg-slate-50">
    <header className="border-b border-slate-200 bg-white px-6 py-3"><div className="mx-auto max-w-[1440px] flex items-center justify-between">
      <div><span className="block text-sm font-extrabold text-slate-900">{view.lab_name}</span><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Medical report upload</span></div>
      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-bold text-slate-500">OFFICIAL PORTAL</span>
    </div></header>
    <main className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Applicant</p>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {detail("Name", view.applicant.name)}
          {detail("CNIC", view.applicant.cnic)}
          {detail("Age", view.applicant.age)}
          {detail("Gender", view.applicant.gender)}
          {detail("Application", view.case_number)}
          {detail("Appointment", view.appointment_at ? displayDateTime(view.appointment_at) : null)}
          {detail("Sampling", view.home_sampling ? "Home sampling" : "At the centre")}
          {view.fasting_required && detail("Preparation", "Fasting required")}
        </div>
      </section>
      {closed
        ? <section role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">This examination has been closed. No further uploads are needed.</section>
        : <MedicalReportUploads token={params.token} tests={view.tests} reports={view.reports ?? []} submitted={!!view.reports_submitted}
            onChange={(update) => setView((current) => current ? { ...current, ...update } : current)} />}
      {view.expires_at && <p className="px-1 text-[10px] text-slate-400">This link is valid until {displayDate(view.expires_at)}.</p>}
    </main>
  </div>;
}
