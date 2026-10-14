"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { displayDate } from "@/lib/dateDisplay";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { aiReviewMedicalReports, usableReport, type MedicalExamOrder, type AiReadTest } from "@/app/services/medicalExam";
import api from "@/app/services/api";

async function getArtifactUrl(id: string): Promise<string> {
  const tenantId = localStorage.getItem("tenant_id") ?? "";
  const res = await api.get<{ download_url: string }>(`/tenants/${tenantId}/artifacts/${id}`);
  return res.data.download_url;
}
// The portal's review flow: AI prefills each test; staff check and save values.
const QUALITATIVE_HINTS: Record<string, string> = {
  MER: "Normal / adverse findings",
  ECG: "Normal / abnormal",
  CXR: "Normal / abnormal",
  TMT: "Negative / positive",
  ECHO: "Normal / abnormal",
  URINE_RE: "Normal / abnormal",
  HIV: "Negative / reactive",
  HEPATITIS: "Negative / reactive",
  COTININE: "Negative / positive",
  PSA: "Normal / raised",
  PAP: "Normal / abnormal",
};

type AiTestState = "waiting" | "reading" | "done" | "failed";
const AI_CONCURRENCY = 4;

function AiSpinner({ className = "h-3 w-3" }: Readonly<{ className?: string }>) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function MedicalReportReviewModal({
  order,
  caseId,
  busy,
  onClose,
  onSubmit,
  error,
}: Readonly<{
  order: MedicalExamOrder;
  caseId: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (results: Record<string, string>) => void;
  error?: string | null;
}>) {
  const { t: tx } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = Object.values(values).filter((v) => v.trim() !== "").length;
  const reports = (order.reports ?? []).filter(usableReport);
  const tests = order.required_tests;

  // The AI reads each test from the customer's reports — one request per test,
  // a few at a time — so every field shows its own progress and fills in as
  // soon as its report is read. The underwriter checks and saves to rate them.
  const [aiState, setAiState] = useState<Record<string, AiTestState>>({});
  const [aiRead, setAiRead] = useState<Record<string, AiReadTest>>({});
  const [edited, setEdited] = useState<Set<string>>(new Set());
  // Read inside async AI callbacks, so a value typed mid-read is never overwritten.
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const [justFilled, setJustFilled] = useState<Set<string>>(new Set());
  const readable = tests.filter((t) => reports.some((r) => r.test_code === t.code && r.status === "Accepted"));
  const states = readable.map((t) => aiState[t.code]);
  const aiRunning = states.some((s) => s === "waiting" || s === "reading");
  const aiDone = states.filter((s) => s === "done" || s === "failed").length;
  const aiFlagged = tests.filter((t) => aiRead[t.code]?.readable && aiRead[t.code].abnormal).length;

  const readTest = async (code: string, refresh: boolean) => {
    setAiState((s) => ({ ...s, [code]: "reading" }));
    try {
      const review = await aiReviewMedicalReports(caseId, { testCode: code, refresh });
      const read = review.tests[code];
      setAiRead((s) => ({ ...s, [code]: read }));
      if (read?.readable && read.value) {
        setValues((current) => ((editedRef.current.has(code) || reviewedRef.current.has(code)) && !refresh ? current : { ...current, [code]: read.value as string }));
        setJustFilled((s) => new Set(s).add(code));
        window.setTimeout(() => setJustFilled((s) => { const next = new Set(s); next.delete(code); return next; }), 1500);
      }
      setAiState((s) => ({ ...s, [code]: "done" }));
    } catch {
      setAiState((s) => ({ ...s, [code]: "failed" }));
    }
  };
  const readAll = async (refresh = false) => {
    const queue = readable.map((t) => t.code);
    if (refresh) setEdited(new Set());
    setAiState((s) => ({ ...s, ...Object.fromEntries(queue.map((code) => [code, "waiting" as const])) }));
    const worker = async () => {
      for (let code = queue.shift(); code; code = queue.shift()) await readTest(code, refresh);
    };
    await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, queue.length) }, worker));
  };
  useEffect(() => {
    void readAll();
    // Read once per opening; the server caches each test until its reports change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedCode, setSelectedCode] = useState(tests[0]?.code ?? "");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [mobilePane, setMobilePane] = useState<"document" | "result">("document");
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const reviewedRef = useRef(reviewed);
  reviewedRef.current = reviewed;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dialogRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, tests.findIndex(t => t.code === selectedCode));
  const test = tests[index];
  const files = reports.filter(r => r.test_code === selectedCode);
  const file = files.find(r => r.id === selectedFile) ?? files[0];
  const read = aiRead[selectedCode];
  const state = aiState[selectedCode];
  const pending = state === "waiting" || state === "reading";
  const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(file?.file_name ?? "");
  const isPdf = /\.pdf$/i.test(file?.file_name ?? "");
  const selectTest = (code: string) => { setSelectedCode(code); setSelectedFile(null); };
  const markReviewed = () => {
    setReviewed(current => new Set(current).add(selectedCode));
    if (index < tests.length - 1) selectTest(tests[index + 1].code);
  };
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null); setPreviewError(null);
    if (!file) { setPreviewBusy(false); return; }
    setPreviewBusy(true);
    getArtifactUrl(file.id).then(url => {
      if (cancelled) return;
      if (!url) throw new Error("Missing preview URL");
      setPreviewUrl(url); setPreviewBusy(false);
    }).catch(() => { if (!cancelled) { setPreviewError("The report could not be loaded. Please try again."); setPreviewBusy(false); } });
    return () => { cancelled = true; };
  }, [file?.id, previewVersion]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), iframe, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", keyboard); previous?.focus(); };
  }, []);

  const submit = () => {
    const payload: Record<string, string> = {};
    for (const [code, v] of Object.entries(values)) {
      if (v.trim() !== "") payload[code] = v.trim();
    }
    onSubmit(payload);
  };

  const chip = (code: string) => {
    if (aiState[code] === "reading" || aiState[code] === "waiting") return "Reading report";
    if (reviewed.has(code)) return "Reviewed";
    if (aiState[code] === "failed") return "AI unavailable";
    if (aiRead[code]?.abnormal) return "Needs attention";
    if (values[code]?.trim()) return "Ready to check";
    return "Awaiting result";
  };
  const outline = "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-2 backdrop-blur-md sm:p-5" onClick={() => { if (!busy) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="medical-review-title" tabIndex={-1} onClick={e => e.stopPropagation()} className="flex h-[94dvh] max-h-[940px] w-full max-w-[1440px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none sm:rounded-3xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="hidden h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 sm:flex"><ReviewIcon kind="document" /></span>
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">{tx("AI-assisted review")}</p>
              <h2 id="medical-review-title" className="text-lg font-bold tracking-tight text-slate-900 sm:text-xl">{tx("Review Medical Reports")}</h2>
              <p className="mt-1 text-xs text-slate-500">{tx("Compare each report with its extracted result, then save your review.")}</p>
            </div>
          </div>
          <button type="button" aria-label="Close review" disabled={busy} onClick={onClose} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><ReviewIcon kind="close" /></button>
        </header>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-semibold text-slate-700">{reviewed.size} / {tests.length} {tx("reviewed")}</span>
            <span className="h-1 w-1 rounded-full bg-slate-300" />
            <span className="text-slate-500">{filled} {tx("results filled")}</span>
            {aiFlagged > 0 && <span className="rounded-full bg-amber-100 px-2 py-1 font-semibold text-amber-800">{aiFlagged} {tx("need attention")}</span>}
          </div>
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-[11px] font-medium text-violet-700">
            {aiRunning ? <><AiSpinner />{tx("Reading reports")} {aiDone}/{readable.length}</> : readable.length > 0 ? <>{tx("AI extraction complete")}<button type="button" disabled={busy} onClick={() => void readAll(false)} className="rounded-lg px-2 py-1 hover:bg-violet-100">{tx("Re-read")}</button></> : <span className="text-slate-500">{tx("Enter results from the reports")}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-2 lg:hidden">
          <select aria-label="Select medical test" value={selectedCode} onChange={e => selectTest(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800">{tests.map((t,i) => <option key={t.code} value={t.code}>{i+1}. {t.name}</option>)}</select>
          <button type="button" onClick={() => setMobilePane(mobilePane === "document" ? "result" : "document")} className={outline}>{mobilePane === "document" ? tx("Result") : tx("Document")}</button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_320px] xl:grid-cols-[240px_minmax(0,1fr)_350px]">
          <nav aria-label="Medical tests" className="hidden min-h-0 overflow-y-auto border-r border-slate-100 bg-slate-50/50 p-3 lg:block">
            <p className="px-3 pb-3 pt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{tx("Required tests")} · {tests.length}</p>
            <div className="space-y-1">{tests.map((t,i) => <button key={t.code} type="button" aria-current={selectedCode === t.code ? "step" : undefined} onClick={() => selectTest(t.code)} className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition ${selectedCode === t.code ? "border-blue-200 bg-blue-50 shadow-sm" : "border-transparent hover:border-slate-200 hover:bg-white"}`}>
              <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${reviewed.has(t.code) ? "bg-emerald-100 text-emerald-700" : selectedCode === t.code ? "bg-blue-600 text-white" : "bg-slate-200/70 text-slate-500"}`}>{reviewed.has(t.code) ? "✓" : i+1}</span>
              <span className="min-w-0"><span className="block text-xs font-semibold leading-5 text-slate-800">{t.name}</span><span className={`mt-0.5 flex items-center gap-1 text-[10px] ${aiRead[t.code]?.abnormal ? "text-amber-700" : "text-slate-500"}`}>{aiState[t.code] === "reading" && <AiSpinner className="h-2.5 w-2.5" />}{tx(chip(t.code))}</span></span>
            </button>)}</div>
          </nav>

          <section aria-label="Document preview" className={`${mobilePane === "document" ? "flex" : "hidden"} min-h-0 flex-col bg-slate-100/80 lg:flex`}>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 bg-white px-4 py-3">
              <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{tx("Source document")}</p><p title={file?.file_name} className="mt-1 truncate text-xs font-semibold text-slate-700">{file?.file_name ?? tx("No report uploaded")}</p></div>
              {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className={outline}><ReviewIcon kind="external" small />{tx("Open")}</a>}
              {file && <button type="button" aria-label="Reload document preview" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" onClick={() => setPreviewVersion(v => v+1)}><ReviewIcon kind="refresh" small /></button>}
              {files.length > 1 && <select aria-label="Choose report file" value={file?.id ?? ""} onChange={e => setSelectedFile(e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700">{files.map(r => <option key={r.id} value={r.id}>{r.file_name}</option>)}</select>}
            </div>
            <div className="relative min-h-0 flex-1 overflow-auto p-3 sm:p-4">
              {previewBusy || (file && !previewUrl && !previewError) ? <PreviewMessage icon={<AiSpinner className="h-6 w-6" />} title="Loading document" text="Preparing your report preview…" /> : previewError ? <PreviewMessage icon={<ReviewIcon kind="document" />} title="Preview unavailable" text={previewError}><button type="button" className={outline} onClick={() => setPreviewVersion(v=>v+1)}>Try again</button></PreviewMessage> : !file ? <PreviewMessage icon={<ReviewIcon kind="document" />} title="No report for this test" text="The customer has not uploaded a report for this test yet. You can still enter a result from a report you have received separately." /> : previewUrl && isPdf ? <PreviewMessage icon={<ReviewIcon kind="document" />} title="Medical report" text="Open the PDF to review the original report."><a href={previewUrl} target="_blank" rel="noopener noreferrer" className={outline}>Open report ↗</a></PreviewMessage> : previewUrl && isImage ? <div className="flex min-h-full items-start justify-center"><img src={previewUrl} alt={`Medical report: ${file.file_name}`} onError={() => setPreviewError("This image could not be displayed. Try reloading the preview.")} className="h-auto max-w-full rounded-xl bg-white shadow-sm" /></div> : <PreviewMessage icon={<ReviewIcon kind="document" />} title="Open the original report" text="This file format does not support an inline preview.">{previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className={outline}>Open document</a>}</PreviewMessage>}
            </div>
            <p className="shrink-0 border-t border-slate-200/70 px-4 py-2 text-[10px] text-slate-500">{file?.status !== "Accepted" && file ? tx("This document is still being processed.") : tx("Use the original report to verify the extracted result.")}</p>
          </section>

          <section aria-label="Review result" className={`${mobilePane === "result" ? "flex" : "hidden"} min-h-0 flex-col border-l border-slate-100 bg-white lg:flex`}>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{tx("Test")} {index+1} {tx("of")} {tests.length}</p>
              <h3 className="mt-2 text-lg font-bold leading-6 text-slate-900">{test?.name ?? tx("No required tests")}</h3>
              <span className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${pending ? "bg-violet-50 text-violet-700" : read?.abnormal ? "bg-amber-50 text-amber-800" : reviewed.has(selectedCode) ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{pending && <AiSpinner />}{tx(chip(selectedCode))}</span>
              <div className="mt-6">
                <label htmlFor="medical-review-value" className="block text-xs font-semibold text-slate-700">{tx("Reported result")}</label>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">{tx("Check the value and units against the source document.")}</p>
                <textarea id="medical-review-value" rows={3} disabled={busy || !test} value={values[selectedCode] ?? ""} onChange={e => { const v=e.target.value; setValues(current=>({...current,[selectedCode]:v})); setEdited(current=>new Set(current).add(selectedCode)); setReviewed(current=>{const next=new Set(current);next.delete(selectedCode);return next;}); }} placeholder={pending ? tx("AI is reading this report…") : QUALITATIVE_HINTS[selectedCode] ?? tx("Enter the reported value and units")} className={`mt-3 w-full resize-none rounded-xl border px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-50 disabled:opacity-50 ${justFilled.has(selectedCode) ? "border-violet-400 bg-violet-50/30" : "border-slate-200 bg-slate-50/50"}`} />
                {edited.has(selectedCode) && <p className="mt-1.5 text-[10px] text-slate-500">{tx("Edited by you — your changes are preserved.")}</p>}
              </div>
              <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
                <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500"><ReviewIcon kind="spark" small />{tx("Evidence from the report")}</p>
                <p className="mt-2 break-words text-xs leading-6 text-slate-600">{pending ? tx("Extracting the result and supporting evidence…") : read?.readable ? read.evidence ?? read.value : state === "failed" ? tx("AI could not read this report. Retry or enter the value manually.") : tx("No extracted evidence yet. Enter the result from the original report.")}</p>
                {!pending && files.some(r=>r.status === "Accepted") && <button type="button" disabled={busy} onClick={() => void readTest(selectedCode, false)} className="mt-2 text-[11px] font-semibold text-blue-600 hover:text-blue-800">{tx("Read this test again")}</button>}
              </div>
              {read?.abnormal && <p className="mt-4 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs leading-5 text-amber-800">{tx("AI flagged a value outside the normal range. Verify the finding in the report before saving.")}</p>}
              {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-700">{error}</p>}

              <p className="mt-3 text-[10px] leading-5 text-slate-400">{tx("Unreported tests can stay blank. Their results remain outstanding.")}</p>
            </div>
            <div className="shrink-0 border-t border-slate-100 px-5 py-3"><button type="button" onClick={markReviewed} disabled={busy || pending || !values[selectedCode]?.trim()} className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"><ReviewIcon kind="check" small />{index < tests.length-1 ? tx("Mark reviewed & next") : tx("Mark reviewed")}</button><div className="flex items-center justify-between"><button type="button" className={outline} disabled={index===0} onClick={()=>selectTest(tests[index-1].code)}>← {tx("Previous")}</button><button type="button" className={outline} disabled={index>=tests.length-1} onClick={()=>selectTest(tests[index+1].code)}>{tx("Next")} →</button></div></div>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-white px-4 py-3 sm:px-6">
          <p className="max-w-[55%] text-[11px] leading-5 text-slate-500">{aiRunning ? tx("You can review reports while AI reads the remaining tests.") : tx("Saving rates all filled results against the underwriting manual.")}</p>
          <div className="flex items-center gap-2"><button type="button" disabled={busy} onClick={onClose} className={`${outline} hidden sm:inline-flex`}>{tx("Cancel")}</button><button type="button" onClick={submit} disabled={busy || filled===0 || aiRunning} className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">{busy && <AiSpinner />}{busy ? tx("Saving…") : tx("Save & rate")}</button></div>
        </footer>
      </div>
    </div>
  );
}

function PreviewMessage({icon,title,text,children}: {icon:ReactNode;title:string;text:string;children?:ReactNode}) {
  return <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center"><span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-400 shadow-sm">{icon}</span><h4 className="text-sm font-semibold text-slate-700">{title}</h4><p className="mt-2 max-w-xs text-xs leading-6 text-slate-500">{text}</p>{children && <div className="mt-4">{children}</div>}</div>;
}
function ReviewIcon({kind,small=false}:{kind:"document"|"close"|"external"|"refresh"|"check"|"spark";small?:boolean}) {
  const paths={document:"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h5",close:"m6 6 12 12M6 18 18 6",external:"M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",refresh:"M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6",check:"m5 12 4 4L19 6",spark:"m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"};
  return <svg width={small?16:22} height={small?16:22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
