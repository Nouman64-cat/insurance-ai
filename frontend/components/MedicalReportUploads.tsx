"use client";

import { useEffect, useRef, useState } from "react";
import axios from "axios";

export interface MedicalReport {
  id: string;
  test_code: string;
  file_name: string;
  status: string;
}
interface Props {
  token: string;
  tests: { code: string; name: string; description: string; fasting?: boolean }[];
  reports: MedicalReport[];
  submitted: boolean;
  onChange: (update: { reports: MedicalReport[]; reports_submitted: boolean }) => void;
}
const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL, timeout: 120_000 });
const usable = (report: MedicalReport) => !["Rejected", "Re-submission Requested"].includes(report.status);

export default function MedicalReportUploads({ token, tests, reports, submitted, onChange }: Props) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(7);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setPageSize(width >= 1100 ? 7 : width >= 700 ? 4 : width >= 500 ? 3 : 2);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const pageCount = Math.ceil(tests.length / pageSize);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const [uploading, setUploading] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    const { data } = await api.get(`/public/medical-exam/${token}`);
    onChange({ reports: data.reports ?? [], reports_submitted: !!data.reports_submitted });
  };
  const upload = async (code: string, files: File[]) => {
    if (!files.length) return;
    setUploading(code); setUploadProgress(0); setError(null); setNotice(null);
    let saved = 0;
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error("Each report must be 20 MB or smaller.");
        const form = new FormData(); form.append("test_code", code); form.append("file", file);
        await api.post(`/public/medical-exam/${token}/reports`, form, {
          onUploadProgress: (event) => {
            const portion = event.total ? event.loaded / event.total : 0;
            setUploadProgress(Math.round(((saved + portion) / files.length) * 100));
          },
        });
        saved += 1;
      }
      setNotice(`${saved} ${saved === 1 ? "report" : "reports"} uploaded successfully. Your insurer will review the findings.`);
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Upload failed. Please try again.");
    } finally {
      try { await refresh(); } catch { setError((prev) => prev ?? "Unable to refresh uploaded reports. Please reload the page."); }
      setUploading(null);
    }
  };
  const submit = async () => {
    setSubmitting(true); setError(null); setNotice(null);
    try {
      await api.post(`/public/medical-exam/${token}/complete`);
      onChange({ reports, reports_submitted: true });
      setNotice("Your reports were submitted successfully for medical review.");
      try { await refresh(); } catch { setError("Your reports were submitted, but the latest status could not be refreshed. Please reload the page."); }
    } catch (e: any) { setError(e.response?.data?.detail ?? "Unable to submit reports. Please retry."); }
    finally { setSubmitting(false); }
  };
  const completed = tests.filter((test) => reports.some((r) => r.test_code === test.code && usable(r))).length;
  const ready = tests.length > 0 && completed === tests.length;
  return <section ref={containerRef} aria-label="Medical report uploads" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-slate-900">Your required medical reports</h2>
        <p className="mt-1 text-xs text-slate-500">PDF, JPEG, PNG, TIFF or BMP · 20 MB per file. Attach combined reports to each test they cover.</p>
      </div>
      <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${ready ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{completed} / {tests.length} tests uploaded</span>
    </div>
    <div role="progressbar" aria-label="Tests with uploaded reports" aria-valuemin={0} aria-valuemax={tests.length} aria-valuenow={completed} className="mt-3 h-1 rounded-full bg-slate-100 overflow-hidden">
      <div className="h-full bg-blue-500 transition-all" style={{ width: `${tests.length ? completed / tests.length * 100 : 0}%` }} />
    </div>
    <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${pageSize}, minmax(0, 1fr))` }}>
      {tests.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((test, index) => {
        const files = reports.filter((r) => r.test_code === test.code);
        const attached = files.some(usable);
        const busy = uploading === test.code;
        const rejected = files.some((r) => !usable(r)) && !attached;
        return <article key={test.code} aria-label={test.name} className={`flex min-w-0 flex-col rounded-xl border p-3 ${attached ? "border-emerald-200 bg-emerald-50/30" : rejected ? "border-red-200 bg-red-50/30" : "border-slate-200 bg-slate-50/40"}`}>
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold text-slate-400">TEST {String(currentPage * pageSize + index + 1).padStart(2, "0")}</span>
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${attached ? "bg-emerald-100 text-emerald-700" : "bg-white text-slate-400 border border-slate-200"}`} aria-hidden="true">{attached ? "✓" : "↑"}</span>
          </div>
          <h3 title={test.name} className="mt-2 min-h-[3rem] text-xs font-bold leading-4 text-slate-800 line-clamp-3">{test.name}</h3>
          <p title={test.description} className="mt-1 min-h-[2rem] text-[10px] leading-4 text-slate-500 line-clamp-2">{test.description}</p>
          {test.fasting && <span className="mt-1 text-[9px] font-semibold text-amber-700">Fasting required</span>}
          <div className="mt-auto pt-3">
            <p className={`text-[10px] font-semibold ${rejected ? "text-red-600" : attached ? "text-emerald-700" : "text-slate-400"}`}>{busy ? (uploadProgress === 100 ? "Saving report…" : `Uploading ${uploadProgress}%`) : rejected ? "Please upload a clearer report" : attached ? `${files.filter(usable).length} report${files.filter(usable).length === 1 ? "" : "s"} attached` : "Awaiting report"}</p>
            {files.length > 0 && <details className="mt-1 text-[10px] text-slate-500"><summary className="cursor-pointer">View uploaded files</summary><ul className="mt-1 space-y-1">{files.map((file) => <li key={file.id} title={file.file_name} className="break-words">{file.file_name}<span className="block">{file.status === "Accepted" ? "Processed" : file.status === "Uploaded" ? "Processing" : file.status === "OCR Pending" ? "Saved — processing pending" : file.status}</span></li>)}</ul></details>}
            <label className={`mt-2 flex cursor-pointer items-center justify-center rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors focus-within:ring-2 focus-within:ring-blue-400 ${uploading || submitting ? "pointer-events-none opacity-50" : "hover:bg-blue-100"} ${attached ? "border border-emerald-200 bg-white text-emerald-700" : "border border-blue-200 bg-blue-50 text-blue-700"}`}>
              {busy ? "Uploading…" : attached ? "Add another" : "Upload report"}
              <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.bmp" disabled={!!uploading || submitting}
                aria-label={`Upload ${test.name} report`} className="sr-only"
                onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void upload(test.code, selected); }} />
            </label>
          </div>
        </article>;
      })}
    </div>
    {pageCount > 1 && <nav aria-label="Medical test pages" className="mt-3 flex items-center justify-between gap-3">
      <p className="text-xs text-slate-500">Tests {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, tests.length)} of {tests.length}</p>
      <div className="flex items-center gap-2">
        <button disabled={currentPage === 0 || !!uploading || submitting} onClick={() => setPage(currentPage - 1)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40">Previous</button>
        <span className="text-xs text-slate-400">{currentPage + 1} / {pageCount}</span>
        <button disabled={currentPage + 1 >= pageCount || !!uploading || submitting} onClick={() => setPage(currentPage + 1)} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40">Next tests →</button>
      </div>
    </nav>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</p>}
    {notice && <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">{notice}</p>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
      <p role="status" aria-live="polite" className={`max-w-xl text-xs ${submitted ? "font-semibold text-emerald-700" : "text-slate-500"}`}>{submitted ? "Reports submitted. Your insurer will review them with your health disclosures and habits." : ready ? "All required tests have reports. You can submit them for review." : `${tests.length - completed} tests still need a report before submission.`}</p>
      {!submitted && <button onClick={submit} disabled={submitting || !!uploading || !ready} className="rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">{submitting ? "Submitting…" : "Submit reports for review"}</button>}
    </div>
  </section>;
}
