"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";

type Document = { id: string; name: string; type: string; status: string; processing_stalled?: boolean; scope: string; tampered?: boolean; ocr_text?: string | null; extracted?: unknown };
type Props = {
  medical: boolean; documents: Document[]; tests: { code: string; name: string }[]; disabled: boolean;
  /** Financial only: the document types this plan asks for, shown as cards. */
  requiredDocuments?: { type: string; received: boolean }[];
  /** Documents the application as a whole still needs; uploadable ones get a card with an upload. */
  applicationDocuments?: { type: string; reason: string; canUpload: boolean; owner: string | null; tag?: string }[];
  onUploadFile: (file: File, type: string, testCode: string, progress: (value: number) => void) => Promise<void>;
  /** DEMO ONLY: files an accepted placeholder for each outstanding document. */
  onMarkAllUploaded?: (items: { document_type: string; test_code: string }[]) => Promise<void>;
  onRetry?: (id: string) => Promise<void>;
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
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const retryable = (d: Document) => d.status === "Processing Failed" || Boolean(d.processing_stalled);
  const retry = async (id: string) => {
    if (!p.onRetry || locked || retrying) return;
    setRetrying(id); setRetryError("");
    try { await p.onRetry(id); }
    catch (error: any) { setRetryError(error?.response?.data?.detail ?? "Could not retry. Please try again shortly."); }
    finally { setRetrying(null); }
  };
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
  const requiredDocuments = p.medical ? [] : p.requiredDocuments ?? [];
  const required = requiredDocuments.map(d => d.type);
  const unlinked = p.documents.filter(d => !p.tests.some(test => d.type === `Medical Report: ${test.code}`) && !required.includes(d.type) && !appDocs.some(a => a.type === d.type));
  type Row = { key: string; title: string; hint: string; files: Document[]; done: boolean; checking: boolean; unreadable: boolean; active: boolean; canUpload: boolean; note: string | null; testCode: string; cardType: string; tag: string | null };
  const isActive = (match: (item: QueuedFile) => boolean) => queue.some(item => match(item) && item.match !== "none" && item.match !== "reading" && item.status !== "failed");
  const rows: Row[] = [
    ...appDocs.map((doc): Row => {
      const files = p.documents.filter(d => d.type === doc.type);
      const checking = files.some(d => isProcessing(d.status) && !d.processing_stalled);
      const unreadable = !checking && files.some(d => d.status === "Re-submission Requested");
      return { key: `app:${doc.type}`, title: doc.type, done: false, checking, unreadable, files, canUpload: doc.canUpload, tag: doc.tag ?? "Application", testCode: "", cardType: doc.type,
        active: isActive(i => i.type === doc.type),
        hint: checking ? "Uploaded — we're reading it now. This usually takes a few seconds and updates by itself." : files.some(retryable) ? "The document reader could not finish. Your file is saved — retry reading it." : unreadable ? "The file couldn't be read clearly. Upload a sharper scan or the original PDF." : doc.reason,
        note: doc.canUpload ? null : doc.owner === "medical" ? "Collected by medical underwriting" : doc.owner === "financial" ? "Collected by financial underwriting" : "Collected by pre-underwriting" };
    }),
    ...(p.medical ? p.tests.map((test): Row => {
      const files = p.documents.filter(d => d.type === `Medical Report: ${test.code}`);
      return { key: `test:${test.code}`, title: test.name, done: files.length > 0, checking: false, unreadable: false, files, canUpload: true, note: null, tag: null, testCode: test.code, cardType: "",
        active: isActive(i => i.testCode === test.code), hint: "Attach the results for this examination." };
    }) : required.map((type): Row => {
      const files = p.documents.filter(d => d.type === type);
      return { key: `req:${type}`, title: type, done: requiredDocuments.some(d => d.type === type && d.received), checking: files.some(d => isProcessing(d.status) && !d.processing_stalled), unreadable: files.some(d => d.status === "Re-submission Requested"), files, canUpload: true, note: null, tag: null, testCode: type, cardType: "",
        active: isActive(i => i.type === type), hint: "Requested from the customer, or upload it here." };
    })),
  ];
  const pending = rows.filter(r => !r.done);
  const [marking, setMarking] = useState(false);
  const [dialog, setDialog] = useState(false);
  // Medical results can only be recorded from real reports: at least 3 (or all of them, if fewer are ordered) must be actual
  // uploads. The rest can be waived. Demo placeholders don't count.
  const realReports = p.medical ? new Set(p.documents.filter(d => d.type.startsWith("Medical Report: ") && !/\((demo|waived)\)/i.test(d.name)).map(d => d.type)).size : 0;
  const minReal = p.medical ? Math.min(3, p.tests.length) : 0;
  const canMark = realReports >= minReal;
  const [markError, setMarkError] = useState("");
  const markable = pending.filter(r => r.canUpload && !r.checking && !r.active);
  const markAll = async () => {
    if (!p.onMarkAllUploaded || !markable.length || !canMark) return;
    setMarking(true); setMarkError("");
    try { await p.onMarkAllUploaded(markable.map(r => ({ document_type: p.medical && r.testCode ? "Medical Report" : r.cardType || r.testCode, test_code: p.medical ? r.testCode : "" }))); }
    catch (error: any) { setMarkError(error?.response?.data?.detail ?? error?.message ?? tx("Could not mark as uploaded.")); }
    finally { setMarking(false); setDialog(false); }
  };
  const receivedCount = rows.filter(r => r.done).length;
  const pct = rows.length ? Math.round((receivedCount / rows.length) * 100) : 0;
  const complete = rows.filter(r => r.done);
  const renderRow = (r: Row) => {
    const failed = !r.checking && r.files.some(retryable);
    const badge = r.active ? ["Uploading…", "bg-blue-50 text-blue-700"] : r.done ? ["Received", "bg-emerald-50 text-emerald-700"] : r.checking ? ["Checking…", "bg-blue-50 text-blue-700"] : failed ? ["Reading interrupted", "bg-amber-50 text-amber-800"] : r.unreadable ? ["Couldn't be read", "bg-rose-50 text-rose-700"] : ["Outstanding", "bg-amber-50 text-amber-800"];
    const busyRow = r.active || (!r.done && r.checking);
    return <li key={r.key} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${r.done ? "bg-emerald-50 text-emerald-600" : r.unreadable ? "bg-rose-50 text-rose-600" : busyRow ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-500"}`}>{busyRow ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" /> : <Icon kind={r.done ? "check" : "file"} className="h-4 w-4" />}</span>
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold text-slate-900">{tx(r.title)}</h4>{r.tag && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">{tx(r.tag)}</span>}</div>
        <p className="mt-0.5 text-xs leading-5 text-slate-500">{r.note ? tx(r.note) : tx(r.done ? failed ? "Received from your existing upload. Text extraction was interrupted; retry reading the saved file." : r.checking ? "Received from your existing upload. Text extraction is still in progress." : "Received from your existing upload." : failed ? "The document reader could not finish. Your file is saved — retry reading it." : r.hint)}</p>
        {r.files.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5">{r.files.map(d => <li key={d.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 py-1 pe-2.5 ps-2.5 text-xs"><button onClick={() => p.onOpen(d.id)} className="max-w-52 truncate font-medium text-blue-700 hover:underline" title={d.name}>{d.name}</button><span className={d.tampered || d.status === "Re-submission Requested" ? "text-rose-600" : "text-slate-400"}>{d.tampered ? tx("Authenticity review needed") : tx(retryable(d) ? "Reading interrupted" : isProcessing(d.status) ? "Reading…" : d.status)}</span>{retryable(d) && p.onRetry && <button disabled={locked || retrying !== null} onClick={() => void retry(d.id)} className="font-semibold text-blue-700 hover:underline disabled:opacity-40">{tx(retrying === d.id ? "Retrying…" : "Retry reading")}</button>}</li>)}</ul>}
      </div>
      <div className="flex shrink-0 items-center gap-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${badge[1]}`}>{tx(badge[0])}</span>
        {r.canUpload && !r.checking && <button disabled={locked || r.active} onClick={() => {pickerTest.current = r.testCode; pickerType.current = r.cardType; input.current?.click();}} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:opacity-40 ${r.done ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50" : "bg-blue-600 text-white hover:bg-blue-700"}`}><Icon kind="upload" className="h-3.5 w-3.5" />{tx(r.unreadable ? "Upload a clearer copy" : r.done ? "Add another" : "Upload")}</button>}
      </div>
    </li>;
  };
  const checklist = rows.length > 0 && <section aria-label={tx("Required documents")} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    {pending.length > 0 && <><div className="flex items-center justify-between border-b border-amber-100 bg-amber-50/60 px-5 py-2.5"><h3 className="text-xs font-semibold uppercase tracking-wide text-amber-800">{tx("Needs action")}</h3><span className="text-xs font-medium text-amber-800">{pending.length} {tx("outstanding")}</span></div><ul className="divide-y divide-slate-100">{pending.map(renderRow)}</ul></>}
    {complete.length > 0 && <><div className={`flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-2.5 ${pending.length ? "border-t" : ""}`}><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx("Received")}</h3><span className="text-xs text-slate-400">{complete.length}</span></div><ul className="divide-y divide-slate-100">{complete.map(renderRow)}</ul></>}
  </section>;
  return <div className="relative space-y-5" onDragOver={e => {e.preventDefault(); if (!locked) setDragging(true);}} onDragLeave={e => {if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);}} onDrop={e => {e.preventDefault(); setDragging(false); if (!locked) addFiles(Array.from(e.dataTransfer.files));}}>
    {retryError && <p role="alert" className="text-sm text-rose-600">{tx(retryError)}</p>}
    {dragging && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-400 bg-blue-50/90 text-sm font-semibold text-blue-700">{tx("Drop files to upload — each is matched to its report")}</div>}
    <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-blue-600">{tx(p.medical ? "Clinical evidence" : "Financial evidence")}</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{tx(p.medical ? "Medical reports" : "Documents")}</h2><p className="mt-1 text-sm text-slate-500">{tx("Drag files anywhere on this page, or use Bulk upload — each file is matched and filed automatically.")} <span className="text-xs text-slate-400">PDF, JPG, PNG, TIFF, BMP, HEIC</span></p></div>
        <div className="flex flex-wrap items-center gap-2"><button disabled={locked} onClick={() => {pickerTest.current = ""; pickerType.current = ""; input.current?.click();}} className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"><Icon kind="upload" />{tx("Bulk upload")}</button> {p.onMarkAllUploaded && markable.length > 0 && <button disabled={locked} onClick={() => {setMarkError(""); setDialog(true);}} className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{tx("Mark as uploaded")}</button>}</div></div>
      {markError && <p role="alert" className="mt-2 text-xs text-red-600">{markError}</p>}
      {rows.length > 0 && <div className="mt-4"><div className="mb-1.5 flex items-center justify-between text-xs"><span className="font-medium text-slate-700">{receivedCount} {tx("of")} {rows.length} {tx("received")}</span><span className="tabular-nums text-slate-400">{pct}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className={`h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`} style={{width: `${pct}%`}} /></div></div>}
    </header>
    <input ref={input} type="file" multiple disabled={locked} aria-label={tx("Select reports")} accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp,.heic" className="sr-only" onChange={e => {addFiles(Array.from(e.target.files ?? []), pickerTest.current, pickerType.current); pickerTest.current = ""; pickerType.current = ""; e.target.value="";}} />
    {(reading > 0 || uploading > 0) && <p role="status" className="flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />{reading > 0 ? `${tx("Matching")} ${reading} ${tx(reading === 1 ? "file" : "files")}…` : `${tx("Uploading")} ${uploading} ${tx(uploading === 1 ? "file" : "files")}… ${busy ? `${progress}%` : ""}`}</p>}
    {checklist}
    {attention.length > 0 && <section className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm" aria-label={tx("Files that need a choice")}><div className="border-b border-amber-100 bg-amber-50 px-5 py-3"><h3 className="text-sm font-semibold text-amber-900">{tx(p.medical ? "Choose the test for these files" : "Choose the document type for these files")} · {attention.length}</h3><p className="mt-0.5 text-xs text-amber-800">{tx("They couldn't be matched automatically, or didn't upload.")}</p></div><ul className="divide-y divide-slate-100">{attention.map(item => <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-3"><span className="rounded-lg bg-slate-50 p-2 text-blue-600"><Icon kind="file" /></span><div className="min-w-0 flex-1 basis-40"><p className="truncate text-sm font-medium text-slate-800">{item.file.name}</p>{item.error ? <p role="alert" className="mt-0.5 text-xs text-red-600">{item.error}</p> : <p className="mt-0.5 text-xs text-slate-400" title={item.reason ?? undefined}>{tx("Couldn't tell which it is")}</p>}</div>{p.medical ? <select aria-label={`${tx("Test for")} ${item.file.name}`} value={item.testCode} onChange={e => update(item.id,{testCode:e.target.value, match:"manual"})} className="max-w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs sm:w-60"><option value="">{tx("General supporting report")}</option>{p.tests.map(test => <option key={test.code} value={test.code}>{test.name}</option>)}</select> : <select aria-label={`${tx("Type for")} ${item.file.name}`} value={item.type} onChange={e => update(item.id,{type:e.target.value, match:"manual"})} className="rounded-lg border p-2 text-xs">{types.map(type => <option key={type}>{type}</option>)}</select>}<button disabled={locked} onClick={() => uploadItems([{...item, status: "ready"}])} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{tx(item.status === "failed" ? "Retry" : "Upload")}</button><button aria-label={`${tx("Remove")} ${item.file.name}`} onClick={() => setQueue(current => current.filter(row => row.id !== item.id))} className="rounded-lg px-2 py-1 text-xl text-slate-400">×</button></li>)}</ul></section>}
    {p.medical && !p.tests.length && !appDocs.length && <p className="rounded-xl bg-white p-5 text-sm text-slate-500">{tx("Required report cards appear after medical requirements are assessed. You can still upload supporting reports.")}</p>}
    {!p.medical && !required.length && <p className="rounded-xl bg-white p-5 text-sm text-slate-500">{tx("This plan doesn't require financial documents. You can still upload supporting income evidence.")}</p>}
    {unlinked.length > 0 && <section><h3 className="mb-4 text-sm font-semibold text-slate-800">{tx(p.medical ? "Other uploaded documents" : "Uploaded documents")}</h3><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{unlinked.map(d => <article key={d.id} className="rounded-xl border bg-white p-4"><button onClick={() => p.onOpen(d.id)} className="text-left text-sm font-semibold text-blue-700">{d.name} ↗</button><p className="mt-2 text-xs text-slate-500">{d.type} · {tx(retryable(d) ? "Reading interrupted" : d.status)}</p>{retryable(d) && p.onRetry && <button disabled={locked || retrying !== null} onClick={() => void retry(d.id)} className="mt-2 text-xs font-semibold text-blue-700 disabled:opacity-40">{tx(retrying === d.id ? "Retrying…" : "Retry reading")}</button>}{d.tampered && <p className="mt-2 text-xs text-red-600">{tx("Authenticity review needed")}</p>}</article>)}</div></section>}
    {dialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => !marking && setDialog(false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="waive-title" onClick={e => e.stopPropagation()} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 id="waive-title" className="text-lg font-semibold text-slate-900">{tx("Mark as uploaded")}</h3>
        <p className="mt-1 text-sm text-slate-500">{tx(p.medical ? "Medical results can only be recorded from real reports. Upload a few, then mark the rest as uploaded." : "Mark the remaining documents as uploaded so this review can continue.")}</p>
        <ol className="mt-5 space-y-3">
          {p.medical && <li className={`rounded-xl border p-4 ${canMark ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200"}`}>
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-slate-900">{tx("1. Upload at least")} {minReal} {tx("reports")}</p><p className="mt-0.5 text-xs text-slate-500">{realReports} {tx("of")} {minReal} {tx("uploaded")}</p></div>
              {canMark ? <span className="text-xs font-semibold text-emerald-700">✓ {tx("Done")}</span> : <button onClick={() => {pickerTest.current = ""; pickerType.current = ""; input.current?.click();}} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"><Icon kind="upload" className="h-3.5 w-3.5" />{tx("Upload reports")}</button>}</div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all ${canMark ? "bg-emerald-500" : "bg-blue-500"}`} style={{width: `${minReal ? Math.min(100, Math.round(realReports / minReal * 100)) : 100}%`}} /></div>
          </li>}
          <li className={`rounded-xl border p-4 ${canMark ? "border-slate-200" : "border-slate-100 opacity-60"}`}>
            <p className="text-sm font-semibold text-slate-900">{p.medical ? "2. " : ""}{tx("Mark the remaining")} {markable.length} {tx(markable.length === 1 ? "document" : "documents")} {tx("as uploaded")}</p>
            <p className="mt-0.5 text-xs text-slate-500">{tx("They are filed as accepted placeholders marked “demo”. Demo only.")}</p>
          </li>
        </ol>
        {(queue.length > 0 || busy) && <p role="status" className="mt-3 text-xs text-blue-700">{tx("Uploading…")} {busy ? `${progress}%` : ""}</p>}
        {markError && <p role="alert" className="mt-3 text-xs text-red-600">{markError}</p>}
        <div className="mt-6 flex justify-end gap-2"><button disabled={marking} onClick={() => setDialog(false)} className="px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900">{tx("Cancel")}</button><button disabled={!canMark || marking} onClick={() => void markAll()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{marking ? tx("Saving…") : tx("Mark as uploaded")}</button></div>
      </div>
    </div>}
    {p.disabled && <p className="text-xs text-amber-700">{tx("Uploads are available when this review is assigned to you and open for changes.")}</p>}
  </div>;
}
