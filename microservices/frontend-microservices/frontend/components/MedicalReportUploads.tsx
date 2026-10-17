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
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.tif,.tiff,.bmp";
const BULK_CONCURRENCY = 3;
interface QueuedFile {
  id: string;
  file: File;
  state: "queued" | "reading" | "matched" | "unmatched" | "failed";
  codes: string[];
  choice: string;
  error?: string;
}

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
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [signName, setSignName] = useState("");
  const [license, setLicense] = useState("");
  const [dragging, setDragging] = useState(false);
  const bulkBusy = queue.some((item) => item.state === "queued" || item.state === "reading");
  const testName = (code: string) => tests.find((test) => test.code === code)?.name ?? code;
  const patchItem = (id: string, update: Partial<QueuedFile>) => setQueue((items) => items.map((item) => item.id === id ? { ...item, ...update } : item));
  const refresh = async () => {
    const { data } = await api.get(`/public/medical-lab/${token}`);
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
        await api.post(`/public/medical-lab/${token}/reports`, form, {
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
  // Bulk path: the server reads each report and attaches it to every required
  // test it covers; files it cannot identify wait for the customer to choose.
  const uploadBulk = async (files: File[]) => {
    if (!files.length) return;
    setError(null); setNotice(null);
    const items: QueuedFile[] = files.map((file, index) => ({ id: `${Date.now()}-${index}-${file.name}`, file, codes: [], choice: "",
      state: file.size > 20 * 1024 * 1024 ? "failed" : "queued", error: file.size > 20 * 1024 * 1024 ? "Larger than 20 MB" : undefined }));
    setQueue((current) => [...current.filter((item) => item.state !== "matched"), ...items]);
    const pending = items.filter((item) => item.state === "queued");
    const worker = async () => {
      for (let item = pending.shift(); item; item = pending.shift()) {
        patchItem(item.id, { state: "reading" });
        try {
          const form = new FormData(); form.append("file", item.file);
          const { data } = await api.post(`/public/medical-lab/${token}/reports/auto`, form);
          patchItem(item.id, data.test_codes.length ? { state: "matched", codes: data.test_codes } : { state: "unmatched" });
        } catch (e: any) {
          patchItem(item.id, { state: "failed", error: e.response?.data?.detail ?? "Upload failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, pending.length) }, worker));
    try { await refresh(); } catch { setError("Unable to refresh uploaded reports. Please reload the page."); }
  };
  const assign = async (item: QueuedFile) => {
    if (!item.choice) return;
    patchItem(item.id, { state: "reading", error: undefined });
    try {
      const form = new FormData(); form.append("test_code", item.choice); form.append("file", item.file);
      await api.post(`/public/medical-lab/${token}/reports`, form);
      patchItem(item.id, { state: "matched", codes: [item.choice] });
      await refresh();
    } catch (e: any) {
      patchItem(item.id, { state: "unmatched", error: e.response?.data?.detail ?? "Upload failed. Please try again." });
    }
  };
  const submit = async () => {
    setSubmitting(true); setError(null); setNotice(null);
    try {
      await api.post(`/public/medical-lab/${token}/complete`, { signature_name: signName.trim(), license_no: license.trim() || null });
      onChange({ reports, reports_submitted: true });
      setNotice("Reports submitted successfully for medical review.");
      try { await refresh(); } catch { setError("Reports were submitted, but the latest status could not be refreshed. Please reload the page."); }
    } catch (e: any) { setError(e.response?.data?.detail ?? "Unable to submit reports. Please retry."); }
    finally { setSubmitting(false); }
  };
  const completed = tests.filter((test) => reports.some((r) => r.test_code === test.code && usable(r))).length;
  const ready = tests.length > 0 && completed === tests.length;
  const signed = signName.trim().length >= 3;
  return <section ref={containerRef} aria-label="Medical report uploads" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-slate-900">Required medical reports</h2>
        <p className="mt-1 text-xs text-slate-500">PDF, JPEG, PNG, TIFF or BMP · 20 MB per file.</p>
      </div>
      <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${ready ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{completed} / {tests.length} tests uploaded</span>
    </div>
    <div role="progressbar" aria-label="Tests with uploaded reports" aria-valuemin={0} aria-valuemax={tests.length} aria-valuenow={completed} className="mt-3 h-1 rounded-full bg-slate-100 overflow-hidden">
      <div className="h-full bg-blue-500 transition-all" style={{ width: `${tests.length ? completed / tests.length * 100 : 0}%` }} />
    </div>
    {!submitted && <label onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (!uploading && !submitting) void uploadBulk(Array.from(event.dataTransfer.files)); }}
      className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors focus-within:ring-2 focus-within:ring-blue-400 ${dragging ? "border-blue-400 bg-blue-50" : "border-blue-200 bg-blue-50/40 hover:bg-blue-50"} ${uploading || submitting ? "pointer-events-none opacity-50" : ""}`}>
      <span className="text-sm font-bold text-blue-700">{bulkBusy ? "Reading reports…" : "Upload all reports at once"}</span>
      <span className="mt-1 text-[11px] text-slate-500">Drop files here or click to choose. We'll recognise which test each report is for — combined lab reports are attached to every test they cover.</span>
      <input type="file" multiple accept={ACCEPT} disabled={!!uploading || submitting} aria-label="Upload all medical reports" className="sr-only"
        onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void uploadBulk(selected); }} />
    </label>}
    {queue.length > 0 && <div className="mt-3 rounded-xl border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <p className="text-xs font-semibold text-slate-700">{queue.filter((item) => item.state === "matched").length} of {queue.length} files sorted{queue.some((item) => item.state === "unmatched") ? " · choose a test for the files we couldn't identify" : ""}</p>
        {!bulkBusy && <button onClick={() => setQueue((items) => items.filter((item) => item.state === "unmatched"))} className="text-[11px] font-semibold text-slate-500 hover:text-slate-700">Clear</button>}
      </div>
      <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">{queue.map((item) => <li key={item.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]">
        <span title={item.file.name} className="min-w-0 flex-1 truncate font-medium text-slate-700">{item.file.name}</span>
        {item.state === "queued" && <span className="text-slate-400">Waiting…</span>}
        {item.state === "reading" && <span className="text-blue-600">Reading report…</span>}
        {item.state === "matched" && <span className="text-emerald-700">✓ {item.codes.map(testName).join(", ")}</span>}
        {item.state === "failed" && <span className="text-red-600">{item.error}</span>}
        {item.state === "unmatched" && <span className="flex flex-wrap items-center gap-2">
          <span className="text-amber-700">{item.error ?? "Couldn't identify this report"}</span>
          <select value={item.choice} onChange={(event) => patchItem(item.id, { choice: event.target.value })} aria-label={`Choose the test for ${item.file.name}`} className="rounded-md border border-slate-200 bg-white p-1 text-[11px]">
            <option value="">Select test…</option>{tests.map((test) => <option key={test.code} value={test.code}>{test.name}</option>)}
          </select>
          <button onClick={() => void assign(item)} disabled={!item.choice} className="rounded-md bg-blue-600 px-2 py-1 font-semibold text-white disabled:opacity-40">Attach</button>
          <button onClick={() => setQueue((items) => items.filter((other) => other.id !== item.id))} className="text-slate-400 hover:text-slate-600">Skip</button>
        </span>}
      </li>)}</ul>
    </div>}
    <p className="mt-4 text-[11px] font-semibold text-slate-500">Or upload to a specific test</p>
    <div className="mt-2 grid gap-3" style={{ gridTemplateColumns: `repeat(${pageSize}, minmax(0, 1fr))` }}>
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
            <label className={`mt-2 flex cursor-pointer items-center justify-center rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors focus-within:ring-2 focus-within:ring-blue-400 ${uploading || submitting || bulkBusy ? "pointer-events-none opacity-50" : "hover:bg-blue-100"} ${attached ? "border border-emerald-200 bg-white text-emerald-700" : "border border-blue-200 bg-blue-50 text-blue-700"}`}>
              {busy ? "Uploading…" : attached ? "Add another" : "Upload report"}
              <input type="file" multiple accept={ACCEPT} disabled={!!uploading || submitting || bulkBusy}
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
    {!submitted && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
      <p className="text-xs font-bold text-slate-800">Examining doctor's e-signature</p>
      <p className="mt-0.5 text-[11px] text-slate-500">By signing, I confirm these reports are genuine and belong to the applicant named above.</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] font-semibold text-slate-600">Doctor's full name (typed as signature)
          <input value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Dr. Full Name" className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal" />
        </label>
        <label className="text-[11px] font-semibold text-slate-600">PMDC / licence no. (optional)
          <input value={license} onChange={(e) => setLicense(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal" />
        </label>
      </div>
    </div>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
      <p role="status" aria-live="polite" className={`max-w-xl text-xs ${submitted ? "font-semibold text-emerald-700" : "text-slate-500"}`}>{submitted ? "Reports submitted. The insurer will review them." : ready ? (signed ? "All required tests have reports. You can submit them for review." : "Sign above to submit the reports.") : `${tests.length - completed} tests still need a report before submission.`}</p>
      {!submitted && <button onClick={submit} disabled={submitting || !!uploading || bulkBusy || !ready || !signed} className="rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">{submitting ? "Submitting…" : "Submit reports for review"}</button>}
    </div>
  </section>;
}
