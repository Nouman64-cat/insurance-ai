"use client";
import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { displayDate } from "@/lib/dateDisplay";
import { fmtCoverage } from "@/lib/mock-data";
import { getArtifactUrl } from "@/app/services/artifacts";
import { LinkEmailNote, type LinkDelivery } from "@/components/LinkEmailNote";
import { aiReviewMedicalReports, usableReport, type AiReadTest, type MedicalExamOrder, type LabLink } from "@/app/services/medicalExam";
export function MedicalLabLinkModal({
  order,
  customerName,
  link,
  labLink,
  busy,
  error,
  onGenerate,
  onEnterManually,
  onClose,
}: Readonly<{
  order: MedicalExamOrder;
  customerName?: string;
  link: string | null;
  labLink: LabLink | null;
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
  onEnterManually: () => void;
  onClose: () => void;
}>) {
  const clinic = order.clinic;
  const sentTo = labLink?.emailed_to ?? order.lab_link_sent_to;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
          <h3 className="font-bold text-slate-900 text-sm">{tx("Lab report link")}</h3>
          <p className="text-xs text-slate-500">{customerName ?? "—"}</p>
        </div>
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto text-xs">
          <div className="border border-slate-200 rounded-xl p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{tx("Lab chosen by the customer")}</p>
            <p className="font-bold text-slate-800 text-sm">{clinic?.name ?? "—"}</p>
            {clinic?.address && <p className="text-slate-600">{clinic.address}</p>}
            {clinic?.phone && <p className="text-slate-600">{clinic.phone}</p>}
            <p className="text-slate-600">
              {tx("Email:")} {order.lab_email ?? <span className="text-amber-700">{tx("not on file")}</span>}
            </p>
            <p className="text-slate-600">
              {tx("Appointment:")} {order.appointment_at ? displayDate(order.appointment_at) + " " + order.appointment_at.slice(11, 16) : "—"}
            </p>
          </div>
          <p className="text-slate-600">
            {tx("Tests to upload:")} <span className="font-semibold text-slate-800">{(order.required_tests ?? []).length}</span>
          </p>
          {link ? (
            <div>
              <p className="text-[11px] text-slate-500 mb-1">{tx("Send this link to the lab's doctor — it replaces any earlier lab link:")}</p>
              <div className="flex items-center gap-1.5">
                <input readOnly value={link} onFocus={(e) => e.currentTarget.select()}
                  className="text-[10px] border border-slate-200 rounded px-2 py-1.5 w-full font-mono text-slate-600 bg-white" />
                <button onClick={() => navigator.clipboard.writeText(link)}
                  className="text-[10px] font-bold text-blue-700 px-2.5 py-1.5 bg-blue-50 border border-blue-200/60 rounded shrink-0 hover:bg-blue-100">
                  {tx("Copy")}
                </button>
              </div>
              <p className="mt-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-medium text-slate-600">
                {labLink?.email_status === "sent"
                  ? tx("Link emailed to {0}", { 0: labLink.emailed_to ?? "" })
                  : tx("No email on file for this lab — share the link manually")}
              </p>
            </div>
          ) : (
            <p className="text-slate-600">
              {sentTo
                ? tx("The lab link was emailed to {0}. Generate it again to resend or to get a copyable link.", { 0: sentTo })
                : tx("Generate the link to send to the lab's doctor. They will see the applicant's details and upload the reports.")}
            </p>
          )}
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-700">{error}</p>}
        </div>
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex flex-wrap justify-between items-center gap-2">
          <button onClick={onEnterManually} className="text-xs font-semibold text-slate-600 hover:text-slate-800">
            {tx("Enter results manually")}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onGenerate} disabled={busy}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold">
              {busy ? tx("Working…") : link || sentTo ? tx("Resend / new link") : tx("Generate & send link")}
            </button>
            <button onClick={onClose} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold">
              {tx("Close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MedicalAssessModal({
  order,
  link,
  delivery,
  customerName,
  busy,
  onClose,
  onMarkCompleted,
}: Readonly<{
  order: MedicalExamOrder;
  link: string | null;
  delivery?: LinkDelivery | null;
  customerName?: string;
  busy: boolean;
  onClose: () => void;
  onMarkCompleted: () => void;
}>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div>
            <h3 className="font-bold text-slate-900 text-sm">
              {tx("Medical Requirement — Non-Medical Limit")}
            </h3>
            <p className="text-xs text-slate-500">{customerName ?? "—"}</p>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
              order.status === "NotRequired"
                ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                : "bg-amber-100 text-amber-800 border border-amber-200"
            }`}
          >
            {order.status}
          </span>
        </div>
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto text-xs">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                {tx("Sum at risk")}
              </p>
              <p className="font-bold text-slate-800 mt-0.5">
                {fmtCoverage(order.sum_assured_at_risk)}
              </p>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                {tx("Non-medical limit (age")} {order.applicant_age ?? "—"})
              </p>
              <p className="font-bold text-slate-800 mt-0.5">
                {order.non_medical_limit != null
                  ? fmtCoverage(order.non_medical_limit)
                  : "—"}
              </p>
            </div>
          </div>

          {(order.trigger_reasons ?? []).length > 0 && (
            <div className="space-y-1">
              {order.trigger_reasons.map((r, i) => (
                <p
                  key={i}
                  className="border-l-2 border-amber-400 pl-2.5 py-1 text-[11px] text-amber-800"
                >
                  {r}
                </p>
              ))}
            </div>
          )}

          {order.status === "NotRequired" ? (
            <p className="text-slate-600 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              {tx(
                "This proposal is within the non-medical limit — it can be underwritten on the E-Application alone. No panel examination is needed.",
              )}
            </p>
          ) : (
            <>
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                    {tx("Mandated panel —")}{" "}
                    {(order.required_tests ?? []).length} {tx("tests")}
                  </span>
                  <span className="text-[11px] font-bold text-slate-700 font-mono">
                    {tx("PKR")}{" "}
                    {Math.round(order.estimated_cost ?? 0).toLocaleString()}
                  </span>
                </div>
                <ul className="divide-y divide-slate-50">
                  {(order.required_tests ?? []).map((t) => (
                    <li
                      key={t.code}
                      className="px-3 py-1.5 flex items-center justify-between gap-2"
                    >
                      <div>
                        <p className="font-semibold text-slate-800 text-[11px]">
                          {t.name}
                        </p>
                        <p className="text-[10px] text-slate-400">
                          {t.category}
                        </p>
                      </div>
                      {t.fasting && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 shrink-0">
                          {tx("FASTING")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {link && (
                <div>
                  <p className="text-[11px] text-slate-500 mb-1">
                    {tx(
                      "The customer's link — they choose a lab and time. The lab's doctor then uploads the reports:",
                    )}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <input
                      readOnly
                      value={link}
                      onFocus={(e) => e.currentTarget.select()}
                      className="text-[10px] border border-slate-200 rounded px-2 py-1.5 w-full font-mono text-slate-600 bg-white"
                    />
                    <button
                      onClick={() => navigator.clipboard.writeText(link)}
                      className="text-[10px] font-bold text-blue-700 px-2.5 py-1.5 bg-blue-50 border border-blue-200/60 rounded shrink-0 hover:bg-blue-100"
                    >
                      {tx("Copy")}
                    </button>
                  </div>
                  <LinkEmailNote delivery={delivery} />
                </div>
              )}
            </>
          )}
        </div>
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex flex-wrap justify-between items-center gap-2">
          <div className="flex items-center gap-3">
            {order.status !== "NotRequired" && order.status !== "Completed" && (
              <button
                onClick={onMarkCompleted}
                disabled={busy}
                className="text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shadow-2xs"
              >
                {busy ? tx("Completing…") : tx("✓ Mark Examination Completed")}
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold"
          >
            {tx("Close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Medical results entry — one field per mandated test, keyed by the test code
// the panel lab reports against. Numeric panels (FBS, HbA1c, lipids) take the
// reported value; qualitative ones (ECG, X-ray, serology) take the lab's own
// wording. The rating happens server-side against the underwriting manual, so
// this form deliberately does no interpretation of its own.
// ─────────────────────────────────────────────────────────────────────────────

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

export function MedicalReportsModal({
  order,
  busy,
  onClose,
  onConfirm,
}: Readonly<{ order: MedicalExamOrder; busy: boolean; onClose: () => void; onConfirm: () => void }>) {
  const reports = (order.reports ?? []).filter((r) => r.status !== "Re-submission Requested");
  const rows = order.required_tests.map((t) => ({ test: t, files: reports.filter((r) => r.test_code === t.code) }));
  const received = rows.filter((r) => r.files.length > 0).length;
  const complete = rows.length > 0 && received === rows.length;
  const pct = rows.length ? Math.round((received / rows.length) * 100) : 0;

  const open = async (artifactId: string) => {
    const tab = window.open("", "_blank");
    try {
      const url = await getArtifactUrl(artifactId);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    } catch {
      tab?.close();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-blue-600 px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-white/80">{tx("Medical examination")}</p>
          <h2 className="text-lg font-bold text-white">{tx("Customer's medical reports")}</h2>
          <p className="mt-0.5 text-xs text-white/80">{tx("Check that every report has been uploaded. They are read during the underwriting run.")}</p>
        </div>

        <div className="border-b border-slate-100 px-6 py-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-slate-800">{tx("{0} of {1} uploaded", { 0: received, 1: rows.length })}</span>
            <span className="text-slate-500">{pct}%</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-2 rounded-full bg-blue-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto px-6">
          {rows.map(({ test, files }) => (
            <li key={test.code} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{test.name}</p>
                {files.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {files.map((f) => (
                      <button key={f.id} type="button" onClick={() => void open(f.id)} title={f.file_name}
                        className="max-w-full truncate rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100">
                        {f.file_name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-0.5 text-xs text-slate-500">{tx("Not uploaded yet")}</p>
                )}
              </div>
              <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${files.length > 0 ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-600"}`}>
                {files.length > 0 ? tx("Uploaded") : tx("Missing")}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-40">{tx("Cancel")}</button>
          <button
            onClick={onConfirm}
            disabled={busy || !complete}
            title={complete ? undefined : tx("Every report must be uploaded first")}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? tx("Confirming…") : tx("Confirm reports received")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MedicalResultModal({
  order,
  caseId,
  busy,
  onClose,
  onSubmit,
}: Readonly<{
  order: MedicalExamOrder;
  caseId: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (results: Record<string, string>) => void;
}>) {
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
  const aiStarted = states.some(Boolean);
  const aiDone = states.filter((s) => s === "done" || s === "failed").length;
  const aiFilled = tests.filter((t) => aiRead[t.code]?.readable).length;
  const aiFlagged = tests.filter((t) => aiRead[t.code]?.readable && aiRead[t.code].abnormal).length;
  const aiManual = tests.length - aiFilled;
  const nowReading = tests.filter((t) => aiState[t.code] === "reading").map((t) => t.name);

  const readTest = async (code: string, refresh: boolean) => {
    setAiState((s) => ({ ...s, [code]: "reading" }));
    try {
      const review = await aiReviewMedicalReports(caseId, { testCode: code, refresh });
      const read = review.tests[code];
      setAiRead((s) => ({ ...s, [code]: read }));
      if (read?.readable && read.value) {
        setValues((current) => (editedRef.current.has(code) && !refresh ? current : { ...current, [code]: read.value as string }));
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

  const [openError, setOpenError] = useState<string | null>(null);
  const openReport = async (artifactId: string) => {
    setOpenError(null);
    // Open the tab synchronously so the popup blocker allows it, then point it at the signed link.
    const tab = window.open("", "_blank");
    try {
      const url = await getArtifactUrl(artifactId);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    } catch {
      tab?.close();
      setOpenError(tx("Could not open the report. Please try again."));
    }
  };

  const submit = () => {
    const payload: Record<string, string> = {};
    for (const [code, v] of Object.entries(values)) {
      if (v.trim() !== "") payload[code] = v.trim();
    }
    onSubmit(payload);
  };

  const fieldBadge = (code: string) => {
    const state = aiState[code];
    const read = aiRead[code];
    if (state === "waiting")
      return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-slate-500">{tx("Queued for AI")}</span>;
    if (state === "reading")
      return <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-blue-700"><AiSpinner className="h-2.5 w-2.5" />{tx("AI reading…")}</span>;
    if (state === "failed")
      return <button type="button" onClick={() => void readTest(code, true)} className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-slate-700 hover:bg-slate-200">{tx("AI failed · Retry")}</button>;
    if (state === "done" && edited.has(code))
      return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-slate-600">{tx("Edited by you")}</span>;
    if (state === "done" && read?.readable)
      return <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal ${read.abnormal ? "bg-blue-100 text-blue-800" : "bg-blue-600 text-white"}`}>{read.abnormal ? "⚠ " + tx("AI · outside range") : "✨ " + tx("AI-filled")}</span>;
    if (state === "done")
      return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-slate-500">{tx("Enter manually")}</span>;
    return null;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-blue-600 px-5 py-3">
          <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">
            {readable.length > 0 ? "✨ " + tx("AI-assisted review") : tx("Panel Clinic Report")}
          </p>
          <h2 className="text-white text-lg font-bold">
            {tx("Record Medical Results")}
          </h2>
          <p className="text-white/80 text-xs">
            {order.reports_submitted
              ? tx("Reports submitted by the customer")
              : (order.clinic?.name ?? tx("Panel clinic"))}
            {order.completed_at
              ? " " +
                tx("· reported {0}", {
                  0: displayDate(order.completed_at),
                })
              : ""}
          </p>
        </div>

        {readable.length > 0 && (
          <div
            role="status"
            aria-live="polite"
            className={`border-b px-5 py-3 ${aiRunning ? "border-blue-100 bg-blue-50" : "border-slate-100 bg-slate-50"}`}
          >
            {aiRunning || !aiStarted ? (
              <>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2 font-semibold text-blue-800">
                    <AiSpinner className="h-3.5 w-3.5" />
                    {tx("AI is reading the customer's reports")}
                  </span>
                  <span className="font-mono text-[11px] text-blue-700">
                    {aiDone} / {readable.length}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${Math.max(4, (aiDone / readable.length) * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 truncate text-[10px] text-blue-700/80">
                  {nowReading.length > 0
                    ? tx("Now reading: {0}", { 0: nowReading.join(", ") })
                    : tx("Starting…")}{" "}
                  · {tx("values appear in each field as they are read")}
                </p>
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-slate-800">✨ {tx("AI review complete")}</span>
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    {tx("{0} filled", { 0: aiFilled })}
                  </span>
                  {aiFlagged > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                      ⚠ {tx("{0} outside normal range", { 0: aiFlagged })}
                    </span>
                  )}
                  {aiManual > 0 && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                      {tx("{0} to enter manually", { 0: aiManual })}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => void readAll(true)}
                  className="text-[11px] font-semibold text-blue-700 hover:text-blue-900"
                >
                  ↻ {tx("Re-read all")}
                </button>
                <p className="w-full text-[10px] text-slate-500">
                  {tx("Check the values against the reports, then Save & rate.")}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {tests.map((t) => {
            const state = aiState[t.code];
            const read = aiRead[t.code];
            const pending = state === "waiting" || state === "reading";
            return (
              <div key={t.code}>
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={`med-result-${t.code}`}
                    className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5"
                  >
                    {t.name}
                    <span className="text-[9px] font-mono text-slate-400 normal-case">
                      {t.code}
                    </span>
                  </label>
                  {fieldBadge(t.code)}
                </div>
                {reports.some((r) => r.test_code === t.code) && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {reports
                      .filter((r) => r.test_code === t.code)
                      .map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => void openReport(r.id)}
                          title={r.file_name}
                          className="max-w-full truncate rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                        >
                          📄 {r.file_name}
                          {r.status !== "Accepted" && (
                            <span className="ml-1 text-blue-700">
                              ({tx("processing")})
                            </span>
                          )}
                        </button>
                      ))}
                  </div>
                )}
                <div className="relative mt-1">
                  <input
                    id={`med-result-${t.code}`}
                    value={values[t.code] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setValues((s) => ({ ...s, [t.code]: value }));
                      setEdited((s) => new Set(s).add(t.code));
                    }}
                    placeholder={
                      state === "reading"
                        ? tx("AI is reading this report…")
                        : state === "waiting"
                          ? tx("Waiting for AI…")
                          : (QUALITATIVE_HINTS[t.code] ?? tx("Reported value"))
                    }
                    className={`w-full text-sm border rounded-lg px-3 py-2 transition-all duration-500 ${
                      pending
                        ? "border-blue-200 bg-blue-50/60 animate-pulse pr-9"
                        : justFilled.has(t.code)
                          ? "border-blue-400 bg-blue-50 ring-2 ring-blue-200"
                          : read?.readable && read.abnormal && !edited.has(t.code)
                            ? "border-blue-300 bg-blue-50/50"
                            : "border-slate-200"
                    }`}
                  />
                  {state === "reading" && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500">
                      <AiSpinner className="h-4 w-4" />
                    </span>
                  )}
                </div>
                {state === "done" && read && (
                  <p
                    title={read.evidence ?? undefined}
                    className={`mt-1 line-clamp-2 text-[10px] ${!read.readable ? "text-slate-400" : read.abnormal ? "text-blue-700" : "text-slate-500"}`}
                  >
                    {!read.readable
                      ? tx("AI could not find this result in the report — enter it manually.")
                      : `${tx("From the report")}: “${read.evidence ?? read.value}”`}
                  </p>
                )}
              </div>
            );
          })}
          {openError && (
            <p role="alert" className="text-[11px] text-slate-700">
              {openError}
            </p>
          )}
          {!aiRunning && filled === 0 && (
            <p role="status" className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              {tx("Save is available once at least one result is filled in. The AI could not read any value from the reports yet, so type the results in manually.")}
            </p>
          )}
          <p className="text-[11px] text-slate-400 pt-1">
            {tx(
              "Leave a test blank if the lab has not reported it yet — it will be listed as outstanding rather than rated. Values are graded against the underwriting manual on save.",
            )}
          </p>
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500 font-medium">
            {aiRunning ? (
              <>
                <AiSpinner className="h-3 w-3 text-blue-500" />
                {tx("AI reading {0} of {1}…", { 0: Math.min(aiDone + 1, readable.length), 1: readable.length })}
              </>
            ) : (
              <>
                {filled} {tx("of")} {tests.length} {tx("filled")}
              </>
            )}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700"
            >
              {tx("Cancel")}
            </button>
            <button
              onClick={submit}
              disabled={busy || filled === 0 || aiRunning}
              title={aiRunning ? tx("Wait for the AI to finish reading the reports") : filled === 0 ? tx("Enter at least one result to save") : undefined}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40"
            >
              {busy ? tx("Saving…") : tx("Save & rate")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
