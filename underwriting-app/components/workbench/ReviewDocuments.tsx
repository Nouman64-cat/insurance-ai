"use client";

import { useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";

type Document = { id: string; name: string; type: string; status: string; scope: string; tampered?: boolean; ocr_text?: string | null; extracted?: unknown };
type Props = {
  medical: boolean; documents: Document[]; tests: { code: string; name: string }[]; disabled: boolean;
  /** Financial only: the document types this plan asks for, shown as cards. */
  requiredTypes?: string[];
  /** Documents the application as a whole still needs; uploadable ones get a card with an upload. */
  applicationDocuments?: { type: string; reason: string; canUpload: boolean; owner: string | null }[];
  onUploadFile: (file: File, type: string, testCode: string, progress: (value: number) => void) => Promise<void>;
  onUploaded: () => void; onOpen: (id: string) => void;
  /** Reads the files and names the matching test code (medical) or document type (financial) for each, or null. */
  onClassify?: (files: File[]) => Promise<({ match: string | null; reason?: string | null })[]>;
};
/** How a queued file got its test / type: read from its content, guessed from its name, chosen by hand, still reading, or unknown. */
type MatchSource = "content" | "filename" | "manual" | "reading" | "none";
type QueuedFile = {id: number; file: File; type: string; testCode: string; status: "ready" | "uploading" | "done" | "failed"; error?: string; match: MatchSource; reason?: string | null};

// Words in a file name, and the words a matching test's name or code contains.
const MEDICAL_HINTS: [RegExp, string[]][] = [
  [/\b(cbc|blood count|ha?emogram)\b/, ["cbc", "blood count", "haemogram", "hemogram"]],
  [/\b(lipid|cholesterol|triglycerides?)\b/, ["lipid", "cholesterol"]],
  [/\b(ecg|ekg|electrocardiogram)\b/, ["ecg", "ekg", "electrocardiogram"]],
  [/\b(x ?ray|cxr|chest)\b/, ["x-ray", "xray", "chest", "cxr"]],
  [/\b(hba1c|a1c|glycated)\b/, ["hba1c", "a1c", "glycated"]],
  [/\b(fbs|rbs|sugar|glucose)\b/, ["sugar", "glucose", "fbs", "rbs"]],
  [/\b(urine|urinalysis|ure|r ?e urine)\b/, ["urine", "urinalysis"]],
  [/\b(lft|liver)\b/, ["liver", "lft"]],
  [/\b(rft|renal|kidney|creatinine)\b/, ["renal", "kidney", "creatinine", "rft"]],
  [/\bhiv\b/, ["hiv"]],
  [/\b(hbsag|hep ?b|hepatitis b)\b/, ["hbsag", "hbs", "hepatitis b"]],
  [/\b(hcv|anti hcv|hep ?c|hepatitis c)\b/, ["hcv", "hepatitis c"]],
  [/\b(tmt|stress|treadmill|exercise)\b/, ["stress", "tmt", "treadmill", "exercise"]],
  [/\b(echo|echocardiogra\w*)\b/, ["echo"]],
  [/\bpsa\b/, ["psa", "prostate"]],
];
const FINANCIAL_HINTS: [RegExp, string][] = [
  [/\b(salary|pay ?slip|payslip|pay ?stub)\b/, "Salary Slip"],
  [/\b(bank|statement|account)\b/, "Bank Statement"],
  [/\b(tax|fbr|return|itr|wealth)\b/, "Tax Return"],
  [/\b(certificate|employment letter|noc)\b/, "Income Certificate"],
  [/\b(balance sheet|financials?|audited|p ?l|profit)\b/, "Financial Statement"],
  [/\b(income|earning)\b/, "Proof of Income"],
];
const GENERIC_WORDS = new Set(["test", "tests", "profile", "report", "reports", "examination", "exam", "resting", "serum", "panel", "screen", "screening", "with", "and", "full", "complete", "routine"]);

/** A guess from the file name alone: the one required test (or type) it clearly names, else nothing. */
function guessFromName(name: string, medical: boolean, tests: { code: string; name: string }[]): string | null {
  const words = ` ${name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, " ")} `;
  if (!medical) return FINANCIAL_HINTS.find(([pattern]) => pattern.test(words))?.[1] ?? null;
  const keywords = MEDICAL_HINTS.filter(([pattern]) => pattern.test(words)).flatMap(([, keys]) => keys);
  const hits = tests.filter((test) => {
    const haystack = `${test.name} ${test.code}`.toLowerCase();
    if (keywords.some((k) => haystack.includes(k))) return true;
    return haystack.split(/[^a-z0-9]+/).some((w) => w.length >= 4 && !GENERIC_WORDS.has(w) && words.includes(` ${w} `));
  });
  return hits.length === 1 ? hits[0].code : null;
}
function Icon({ kind, className = "h-5 w-5" }: { kind: "upload" | "file" | "arrow" | "check"; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "upload" ? <><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4" /></> : kind === "arrow" ? <path d="M7 17 17 7M7 7h10v10" /> : kind === "check" ? <path d="m5 12 4 4L19 6" /> : <><path d="M14 3H5v18h14V8Z" /><path d="M14 3v6h5M8 13h8M8 17h5" /></>}</svg>;
}
/** Stored but not yet read by OCR: it can't meet a requirement until it is accepted. */
export const isProcessing = (status: string) => status === "Uploaded" || status === "Processing";

export default function ReviewDocuments(p: Props) {
  const input = useRef<HTMLInputElement>(null);
  const pickerTest = useRef("");
  const pickerType = useRef("");
  const nextId = useRef(0);
  // Files being matched or uploaded, and the few that need a choice (no match found) or a retry (upload failed).
  // Uploaded files leave the queue: they show on their report card.
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const locked = p.disabled;
  const appDocs = p.applicationDocuments ?? [];
  const types = Array.from(new Set([...(p.medical ? ["Medical Report", "X-Ray", "MRI Scan", "Lab Report", "ECG", "Blood Test"] : ["Salary Slip", "Bank Statement", "Tax Return", "Income Certificate", "Financial Statement", "Proof of Income"]), ...appDocs.filter(d => d.canUpload).map(d => d.type)]));
  const update = (id: number, patch: Partial<QueuedFile>) => setQueue(current => current.map(item => item.id === id ? {...item, ...patch} : item));

  /** Upload these files one after another (batches queue up behind each other); each leaves the queue when stored. */
  const uploadItems = (items: QueuedFile[]) => {
    if (!items.length) return;
    chain.current = chain.current.then(async () => {
      setBusy(true);
      for (const item of items) {
        update(item.id, {status: "uploading", error: undefined}); setProgress(0);
        try {
          await p.onUploadFile(item.file, item.type, item.testCode, setProgress);
          setQueue(current => current.filter(row => row.id !== item.id));
        } catch (error: any) {
          update(item.id, {status: "failed", error: error?.response?.data?.detail ?? error?.message ?? "Upload failed"});
        }
      }
      setBusy(false);
      p.onUploaded();
    });
  };

  const addFiles = (files: File[], testCode = "", cardType = "") => {
    if (!files.length || p.disabled) return;
    // Added from a report card: that card's test, uploaded straight away. Otherwise each file is matched — a quick
    // guess from its name, then what the reader finds in its content — and uploaded onto its card; a file nothing
    // matched waits for the underwriter to choose.
    const fromCard = Boolean(testCode || cardType);
    const items: QueuedFile[] = files.map(file => {
      const guess = fromCard ? null : guessFromName(file.name, p.medical, p.tests);
      return {
        id: ++nextId.current, file, status: "ready",
        // A financial card passes its document type in place of a test code.
        type: cardType || (!p.medical && fromCard ? testCode : !p.medical && guess ? guess : p.medical ? "Medical Report" : "Salary Slip"),
        testCode: cardType || !p.medical ? "" : fromCard ? testCode : guess ?? "",
        match: fromCard ? "manual" : p.onClassify ? "reading" : guess ? "filename" : "none",
      };
    });
    setQueue(current => [...current, ...items]);
    if (fromCard || !p.onClassify) {
      uploadItems(items.filter(item => item.match !== "none"));
      return;
    }
    const settle = (results: ({ match: string | null; reason?: string | null } | undefined)[]) => {
      const settled = items.map((item, index) => {
        const found = results[index]?.match ?? null;
        if (found) return {...item, match: "content" as const, reason: results[index]?.reason, ...(p.medical ? {testCode: found} : {type: found})};
        const guessed = guessFromName(item.file.name, p.medical, p.tests);
        return {...item, match: (guessed ? "filename" : "none") as MatchSource, reason: results[index]?.reason};
      });
      setQueue(current => current.map(row => settled.find(s => s.id === row.id) ?? row));
      uploadItems(settled.filter(item => item.match !== "none"));
    };
    p.onClassify(files).then(settle).catch(() => settle([]));
  };

  const reading = queue.filter(item => item.match === "reading").length;
  const uploading = queue.filter(item => item.status === "uploading" || (item.status === "ready" && item.match !== "none" && item.match !== "reading")).length;
  const attention = queue.filter(item => item.status === "failed" || (item.status === "ready" && item.match === "none"));
  const required = p.medical ? [] : p.requiredTypes ?? [];
  const unlinked = p.documents.filter(d => !p.tests.some(test => d.type === `Medical Report: ${test.code}`) && !required.includes(d.type) && !appDocs.some(a => a.type === d.type));
  const appSection = appDocs.length > 0 && <section aria-label={tx("Needed for the application")} className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-sm font-semibold text-slate-900">{tx("Still needed for the application")}</h3><p className="mt-0.5 text-xs text-slate-500">{tx("The application stays in Pending documents until these are in.")}</p></div><p className="text-xs font-semibold text-amber-800">{appDocs.length} {tx("outstanding")}</p></div>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{appDocs.map(doc => {
      const active = queue.some(item => item.type === doc.type && item.match !== "none" && item.match !== "reading" && item.status !== "failed");
      // A file of this type is in but not accepted yet: it is being read, or it could not be read.
      const files = p.documents.filter(d => d.type === doc.type);
      const checking = files.some(d => isProcessing(d.status));
      const unreadable = !checking && files.some(d => d.status === "Re-submission Requested");
      const badge = active ? ["Uploading…", "bg-blue-50 text-blue-700"] : checking ? ["Checking document…", "bg-blue-50 text-blue-700"] : unreadable ? ["Couldn't be read", "bg-rose-50 text-rose-700"] : ["Outstanding", "bg-amber-50 text-amber-800"];
      return <article key={doc.type} className={`flex flex-col rounded-2xl border bg-white p-5 shadow-sm ${active || checking ? "border-blue-300 ring-2 ring-blue-50" : unreadable ? "border-rose-200" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-2"><span className={`rounded-xl p-3 ${checking ? "bg-blue-50 text-blue-600" : unreadable ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-600"}`}><Icon kind="file" className="h-6 w-6" /></span><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge[1]}`}>{(active || checking) && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />}{tx(badge[0])}</span></div>
        <h4 className="mt-5 text-base font-semibold leading-6 text-slate-900">{tx(doc.type)}</h4>
        <p className="mt-1 text-xs leading-5 text-slate-500">{checking ? tx("Uploaded — we're reading it now. This usually takes a few seconds and updates by itself.") : unreadable ? tx("The file couldn't be read clearly. Upload a sharper scan or the original PDF.") : doc.reason}</p>
        {files.length > 0 && <div className="mt-3 space-y-1.5">{files.map(d => <button key={d.id} onClick={() => p.onOpen(d.id)} className="flex w-full items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-left text-xs"><span className="truncate font-medium text-blue-700">{d.name} ↗</span><span className={d.status === "Re-submission Requested" ? "text-rose-600" : "text-slate-400"}>{tx(isProcessing(d.status) ? "Reading…" : d.status)}</span></button>)}</div>}
        <div className="mt-auto pt-5">{checking ? null : doc.canUpload
          ? <button disabled={locked} onClick={() => {pickerTest.current = ""; pickerType.current = doc.type; input.current?.click();}} className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition disabled:opacity-40 ${active ? "bg-blue-600 text-white" : "bg-blue-600 text-white hover:bg-blue-700"}`}>{active ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon kind="upload" className="h-4 w-4" />}{tx(active ? "Uploading…" : unreadable ? "Upload a clearer copy" : "Upload document")}</button>
          : <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-center text-xs text-slate-500">{tx(doc.owner === "medical" ? "Collected by medical underwriting" : doc.owner === "financial" ? "Collected by financial underwriting" : "Collected by pre-underwriting")}</p>}</div>
      </article>;
    })}</div>
  </section>;
  return <div className="space-y-6">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-blue-600">{tx(p.medical ? "Clinical evidence" : "Financial evidence")}</p><h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{tx(p.medical ? "Medical reports" : "Documents")}</h2><p className="mt-2 text-sm text-slate-500">{tx(p.medical ? "Upload from a report card, or select several files at once — each is matched to its test and filed on its card." : "Select several files at once — each is matched to its document type and filed.")}</p></div><button disabled={locked} onClick={() => {pickerTest.current = ""; input.current?.click();}} className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"><Icon kind="upload" />{tx("Bulk upload")}</button></header>
    <input ref={input} type="file" multiple disabled={locked} aria-label={tx("Select reports")} accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp,.heic" className="sr-only" onChange={e => {addFiles(Array.from(e.target.files ?? []), pickerTest.current, pickerType.current); pickerTest.current = ""; pickerType.current = ""; e.target.value="";}} />
    <div onDragOver={e => {e.preventDefault();if (!locked) setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={e => {e.preventDefault();setDragging(false);if (!locked) addFiles(Array.from(e.dataTransfer.files));}} className={`rounded-xl border border-dashed px-5 py-4 text-center text-sm ${dragging ? "border-blue-400 bg-blue-50 text-blue-700" : "border-slate-300 text-slate-500"}`}>{tx("Drop multiple reports here, or use Bulk upload.")} <span className="text-xs text-slate-400">PDF, JPG, PNG, TIFF, BMP, HEIC</span></div>
    {(reading > 0 || uploading > 0) && <p role="status" className="flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />{reading > 0 ? `${tx("Matching")} ${reading} ${tx(reading === 1 ? "file" : "files")}…` : `${tx("Uploading")} ${uploading} ${tx(uploading === 1 ? "file" : "files")}… ${busy ? `${progress}%` : ""}`}</p>}
    {appSection}
    {attention.length > 0 && <section className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm" aria-label={tx("Files that need a choice")}><div className="border-b border-amber-100 bg-amber-50 px-5 py-3"><h3 className="text-sm font-semibold text-amber-900">{tx(p.medical ? "Choose the test for these files" : "Choose the document type for these files")} · {attention.length}</h3><p className="mt-0.5 text-xs text-amber-800">{tx("They couldn't be matched automatically, or didn't upload.")}</p></div><ul className="divide-y divide-slate-100">{attention.map(item => <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-3"><span className="rounded-lg bg-slate-50 p-2 text-blue-600"><Icon kind="file" /></span><div className="min-w-0 flex-1 basis-40"><p className="truncate text-sm font-medium text-slate-800">{item.file.name}</p>{item.error ? <p role="alert" className="mt-0.5 text-xs text-red-600">{item.error}</p> : <p className="mt-0.5 text-xs text-slate-400" title={item.reason ?? undefined}>{tx("Couldn't tell which it is")}</p>}</div>{p.medical ? <select aria-label={`${tx("Test for")} ${item.file.name}`} value={item.testCode} onChange={e => update(item.id,{testCode:e.target.value, match:"manual"})} className="max-w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs sm:w-60"><option value="">{tx("General supporting report")}</option>{p.tests.map(test => <option key={test.code} value={test.code}>{test.name}</option>)}</select> : <select aria-label={`${tx("Type for")} ${item.file.name}`} value={item.type} onChange={e => update(item.id,{type:e.target.value, match:"manual"})} className="rounded-lg border p-2 text-xs">{types.map(type => <option key={type}>{type}</option>)}</select>}<button disabled={locked} onClick={() => uploadItems([{...item, status: "ready"}])} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{tx(item.status === "failed" ? "Retry" : "Upload")}</button><button aria-label={`${tx("Remove")} ${item.file.name}`} onClick={() => setQueue(current => current.filter(row => row.id !== item.id))} className="rounded-lg px-2 py-1 text-xl text-slate-400">×</button></li>)}</ul></section>}
    {p.medical && p.tests.length > 0 && <section aria-label={tx("Required reports")}>
      <div className="mb-4 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">{tx("Required reports")}</h3><p className="text-xs text-slate-400">{p.tests.length} {tx("examination tests")}</p></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{p.tests.map((test, index) => {
        const reports = p.documents.filter(d => d.type === `Medical Report: ${test.code}`);
        const active = queue.some(item => item.testCode === test.code && item.match !== "none" && item.match !== "reading" && item.status !== "failed");
        return <article key={test.code} className={`flex min-h-64 flex-col rounded-2xl border bg-white p-5 shadow-sm transition ${active ? "border-blue-400 ring-2 ring-blue-100" : "border-slate-200 hover:border-blue-200"}`}>
          <div className="flex items-start justify-between gap-2"><span className={`rounded-xl p-3 ${reports.length ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}><Icon kind={reports.length ? "check" : "file"} className="h-6 w-6" /></span><span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${reports.length ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{tx(reports.length ? "Uploaded" : "Awaiting report")}</span></div>
          <p className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{tx("Required report")} {String(index + 1).padStart(2, "0")}</p>
          <h4 className="mt-1 text-base font-semibold leading-6 text-slate-900">{test.name}</h4>
          <p className="mb-5 mt-2 text-xs text-slate-400">{reports.length ? `${reports.length} ${tx("files attached")}` : tx("Attach the results for this examination.")}</p>
          <div className="mt-auto space-y-2">{reports.map(report => <details key={report.id} className="rounded-lg bg-slate-50 p-2 text-xs"><summary className="cursor-pointer truncate text-slate-600">{report.name}</summary><button onClick={() => p.onOpen(report.id)} className="my-2 font-semibold text-blue-600">{tx("Open report")} ↗</button><p className="text-slate-500">{report.status}</p>{report.tampered && <p className="text-red-600">{tx("Authenticity review needed")}</p>}{Boolean(report.ocr_text || report.extracted) && <p className="mt-2 whitespace-pre-wrap break-words text-slate-500">{report.ocr_text || JSON.stringify(report.extracted, null, 2)}</p>}</details>)}<button disabled={locked} onClick={() => {pickerTest.current = test.code; input.current?.click();}} className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition disabled:opacity-40 ${active ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"}`}>{active ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon kind="upload" className="h-4 w-4" />}{tx(active ? "Uploading…" : reports.length ? "Add another file" : "Upload report")}</button></div>
        </article>;
      })}</div>
    </section>}
    {p.medical && !p.tests.length && <p className="rounded-xl bg-white p-5 text-sm text-slate-500">{tx("Required report cards appear after medical requirements are assessed. You can still upload supporting reports.")}</p>}
    {required.length > 0 && <section aria-label={tx("Required documents")}>
      <div className="mb-4 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">{tx("Required by this plan")}</h3><p className="text-xs text-slate-400">{required.filter(t => p.documents.some(d => d.type === t)).length}/{required.length} {tx("received")}</p></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{required.map(type => {
        const files = p.documents.filter(d => d.type === type);
        const active = queue.some(item => item.type === type && item.match !== "none" && item.match !== "reading" && item.status !== "failed");
        return <article key={type} className={`flex flex-col rounded-2xl border bg-white p-5 shadow-sm transition ${active ? "border-blue-400 ring-2 ring-blue-100" : "border-slate-200 hover:border-blue-200"}`}>
          <div className="flex items-start justify-between gap-2"><span className={`rounded-xl p-3 ${files.length ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}><Icon kind={files.length ? "check" : "file"} className="h-6 w-6" /></span><span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${files.length ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{tx(files.length ? "Received" : "Awaiting document")}</span></div>
          <h4 className="mt-5 text-base font-semibold leading-6 text-slate-900">{tx(type)}</h4>
          <p className="mb-5 mt-1 text-xs text-slate-400">{files.length ? `${files.length} ${tx("files attached")}` : tx("Requested from the customer, or upload it here.")}</p>
          <div className="mt-auto space-y-2">{files.map(d => <div key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs"><button onClick={() => p.onOpen(d.id)} className="truncate text-left font-medium text-blue-700">{d.name} ↗</button><span className={d.tampered ? "text-red-600" : "text-slate-400"}>{d.tampered ? tx("Authenticity review") : d.status}</span></div>)}<button disabled={locked} onClick={() => {pickerTest.current = type; input.current?.click();}} className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition disabled:opacity-40 ${active ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"}`}>{active ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon kind="upload" className="h-4 w-4" />}{tx(active ? "Uploading…" : files.length ? "Add another file" : "Upload document")}</button></div>
        </article>;
      })}</div>
    </section>}
    {!p.medical && !required.length && <p className="rounded-xl bg-white p-5 text-sm text-slate-500">{tx("This plan doesn't require financial documents. You can still upload supporting income evidence.")}</p>}
    {unlinked.length > 0 && <section><h3 className="mb-4 text-sm font-semibold text-slate-800">{tx(p.medical ? "Other uploaded documents" : "Uploaded documents")}</h3><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{unlinked.map(d => <article key={d.id} className="rounded-xl border bg-white p-4"><button onClick={() => p.onOpen(d.id)} className="text-left text-sm font-semibold text-blue-700">{d.name} ↗</button><p className="mt-2 text-xs text-slate-500">{d.type} · {d.status}</p>{d.tampered && <p className="mt-2 text-xs text-red-600">{tx("Authenticity review needed")}</p>}</article>)}</div></section>}
    {p.disabled && <p className="text-xs text-amber-700">{tx("Uploads are available when this review is assigned to you and open for changes.")}</p>}
  </div>;
}
