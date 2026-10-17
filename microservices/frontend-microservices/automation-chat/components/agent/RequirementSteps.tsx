"use client";

import { displayDateTime } from '../../lib/dateDisplay';
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PORTAL_ORIGIN } from "@/lib/portal";
import api from "@/app/services/api";
import { fmtCoverage } from "@/lib/mock-data";
import type { ChecklistItem, RequirementsChecklist } from "@/lib/agent/types";
import { useConfirm } from "@/components/ConfirmDialog";
import { DocumentUploadDialog } from "@/components/agent/DocumentUploadDialog";
import MedicalReportReviewModal from "@/components/agent/MedicalReportReviewModal";
import VerifyEAppModal from "@/components/entities/VerifyEAppModal";
import { IPPModal } from "@/components/entities/IPPModal";
import { getACR, requestACR, waiveACR } from "@/app/services/agentConfidentialReport";
import { getEApplication, inviteEApplication, type EApplication } from "@/app/services/eApplication";
import { runCaseCompliance, clearComplianceCheck } from "@/app/services/cases";
import { getInsuranceHistory, runInsuranceHistory, clearInsuranceHistory, type InsuranceHistory } from "@/app/services/insuranceHistory";
import {
  assessMedicalExam, getMedicalExam, inviteMedicalExam, recordMedicalResult, waiveMedicalExam,
  usableReport, MEDICAL_CLEARED, type MedicalExamOrder,
} from "@/app/services/medicalExam";

// Each underwriting requirement, done right inside the requirements card: the step's button calls the API itself and
// its outcome (a link to wait on, screening results, the findings to clear) is shown where the button was. When the
// step completes the card re-reads the case and the next step opens — nothing is posted to the chat.

/** What a finished step leaves behind in the card, shown on its row afterwards. */
export interface StepResult {
  tone: "ok" | "warn" | "bad";
  title: string;
  lines?: string[];
}

export interface StepProps {
  checklist: RequirementsChecklist;
  item: ChecklistItem;
  /** Re-read the case; the card then shows this step as done and opens the next. */
  changed: () => Promise<void>;
  report: (id: ChecklistItem["id"], result: StepResult | null) => void;
}

const errText = (e: any, fallback: string) => e?.response?.data?.detail ?? e?.message ?? fallback;

// ── small building blocks ───────────────────────────────────────────────────

function Btn({ children, onClick, busy, kind = "primary", disabled }: {
  children: ReactNode; onClick: () => void; busy?: boolean; kind?: "primary" | "secondary" | "warn"; disabled?: boolean;
}) {
  const style =
    kind === "primary" ? "bg-blue-600 text-white shadow-sm hover:bg-blue-700"
    : kind === "warn" ? "bg-amber-500 text-white shadow-sm hover:bg-amber-600"
    : "border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-all active:scale-[0.97] disabled:opacity-60 ${style}`}
    >
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[12px] font-medium text-rose-700">{text}</p> : null;
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-2 text-[12px] font-medium text-slate-500">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      {children}
    </p>
  );
}

function LinkBox({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="mt-3 rounded-xl border border-blue-100 bg-white p-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-600" />
        <button type="button" onClick={copy} className="shrink-0 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 hover:border-blue-200 hover:text-blue-700">
          {copied ? "Copied" : "Copy"}
        </button>
        <a href={url} target="_blank" rel="noreferrer" className="shrink-0 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 hover:border-blue-200 hover:text-blue-700">
          Open
        </a>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2">
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 text-[12px] font-bold text-slate-800">{children}</p>
    </div>
  );
}

const portalModal = (node: ReactNode) => (typeof document === "undefined" ? null : createPortal(node, document.body));

/** Runs an async action with a busy flag and an error line. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e: any) { setError(errText(e, fallback)); } finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

/** Calls `fn` when the chat sees a live event for this case (the card is told by the chat's one event stream), and on a slow poll while `poll`. */
function useLive(caseId: string, fn: () => void, poll: boolean) {
  useEffect(() => {
    const onEvt = (e: Event) => { if ((e as CustomEvent).detail?.case_id === caseId) fn(); };
    window.addEventListener("uw-case-event", onEvt);
    const id = poll ? window.setInterval(fn, 12000) : undefined;
    return () => { window.removeEventListener("uw-case-event", onEvt); if (id) window.clearInterval(id); };
  }, [caseId, fn, poll]);
}

// ── 1 · Documents ───────────────────────────────────────────────────────────

function DocsStep({ checklist, changed, report }: StepProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      {checklist.missingDocs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {checklist.missingDocs.map((d) => (
            <span key={d} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{d}</span>
          ))}
        </div>
      )}
      <div className="mt-3"><Btn onClick={() => setOpen(true)}>Upload documents</Btn></div>
      {open && portalModal(
        <DocumentUploadDialog
          tenantId={checklist.tenantId}
          caseId={checklist.caseId}
          caseNumber={checklist.caseNo}
          documentTypes={checklist.missingDocs}
          onClose={() => setOpen(false)}
          onDone={async (r) => {
            setOpen(false);
            if (r.uploaded.length || r.failed.length) {
              report("docs", {
                tone: r.failed.length ? "warn" : "ok",
                title: r.uploaded.length ? `Uploaded ${r.uploaded.join(", ")}` : "Nothing was uploaded",
                lines: r.failed.map((f) => `${f.type}: ${f.reason}`),
              });
            }
            await changed();
          }}
        />,
      )}
    </div>
  );
}

// ── 2 · E-application ───────────────────────────────────────────────────────

function EAppStep({ checklist, item, changed, report }: StepProps) {
  const { caseId, customerName } = checklist;
  const [eApp, setEApp] = useState<EApplication | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const { busy, error, run } = useAction();

  const seen = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await getEApplication(caseId);
      setEApp(next);
      // The customer finishing it is what the card is waiting on — bring the checklist along.
      if (seen.current !== null && seen.current !== next.status) void changed();
      seen.current = next.status;
    } catch { /* not started yet */ }
  }, [caseId, changed]);

  useEffect(() => { void load(); }, [load]);
  const status = eApp?.status ?? (item.status as string);
  const waiting = status === "Sent" || status === "InProgress";
  useLive(caseId, load, waiting);

  const generate = () => run(async () => {
    const invite = await inviteEApplication(caseId);
    setLink(`${PORTAL_ORIGIN}${invite.link_path}`);
    await load();
    await changed();
  }, "Couldn't create the e-application link.");

  if (status === "Submitted" && eApp) {
    return (
      <div>
        <p className="mt-2 text-[12px] text-slate-600">
          {customerName ?? "The customer"} submitted the questionnaire{eApp.submitted_at ? ` on ${displayDateTime(eApp.submitted_at)}` : ""}. Review the answers, then approve or send it back.
        </p>
        <div className="mt-3"><Btn onClick={() => setVerifying(true)}>Review &amp; verify</Btn></div>
        {verifying && portalModal(
          <VerifyEAppModal
            caseId={caseId}
            customerName={customerName}
            eApp={eApp}
            onClose={() => setVerifying(false)}
            onVerified={async (action) => {
              setVerifying(false);
              report("eapp", action === "approve"
                ? { tone: "ok", title: "E-application verified" }
                : { tone: "warn", title: "Sent back to the customer for changes" });
              await load();
              await changed();
            }}
          />,
        )}
      </div>
    );
  }

  return (
    <div>
      {!waiting && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn onClick={generate} busy={busy}>{status === "Expired" ? "Generate a new link" : "Generate E-App Link"}</Btn>
        </div>
      )}
      {waiting && (
        <>
          {link ? <LinkBox url={link} label="Send this link to the customer" /> : <p className="mt-2 text-[12px] text-slate-600">The link has been sent. Generate a new one if the customer lost it.</p>}
          <Waiting>{status === "InProgress" ? "The customer is filling it in…" : "Waiting for the customer to open the link…"}</Waiting>
          <div className="mt-3"><Btn kind="secondary" onClick={generate} busy={busy}>{link ? "Send a new link" : "Get a fresh link"}</Btn></div>
        </>
      )}
      {status === "Expired" && <p className="mt-2 text-[12px] text-slate-500">The last link has expired.</p>}
      <ErrorLine text={error} />
    </div>
  );
}

// ── 3 · Agent's Confidential Report ─────────────────────────────────────────

function AcrStep({ checklist, item, changed, report }: StepProps) {
  // The report is the agent's own, filed from the agent app, so there is no form here: this step asks for it and waits —
  // or an underwriter waives it, with a reason, when the report isn't coming.
  const [asked, setAsked] = useState<{ text: string } | null>(null);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const waiver = useAction();
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try { setRequestedAt((await getACR(checklist.caseId)).requested_at ?? null); } catch { /* none yet */ }
  }, [checklist.caseId]);
  useEffect(() => { void load(); }, [load]);
  useLive(checklist.caseId, () => { void load(); void changed(); }, true);

  const ask = () => run(async () => {
    const r = await requestACR(checklist.caseId);
    const who = r.recipient?.name ?? "the agent";
    setAsked({
      text: r.self_request ? "You are the agent on this case: file the report from the agent app."
        : r.already_requested ? `Already requested from ${who}.` : `Asked ${who} to file the report from the agent app.`,
    });
    await load();
  }, "Couldn't send the request.");

  const waive = () => waiver.run(async () => {
    await waiveACR(checklist.caseId, reason.trim());
    report("acr", { tone: "warn", title: "ACR waived", lines: [`Reason: ${reason.trim()}`, "Recorded against your name. If the agent files the report later, it is still kept."] });
    setWaiving(false);
    await changed();
  }, "Couldn't waive the ACR.");

  return (
    <div>
      <Waiting>
        {item.status === "Draft" ? "The agent has started the report in the app…" : "Waiting for the agent to submit the report from the agent app…"}
      </Waiting>
      {asked && <p className="mt-2 rounded-lg bg-blue-50 px-2.5 py-1.5 text-[12px] font-medium text-blue-800">{asked.text}</p>}
      {waiving ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-[12px] font-semibold text-amber-900">Waive the Agent's Confidential Report</p>
          <p className="mt-0.5 text-[12px] text-amber-800">Use this only when the report isn't coming. Your reason and name are recorded.</p>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} autoFocus
            placeholder="Why is the ACR being waived? e.g. Agent has left; the applicant was verified in branch."
            className="mt-2 w-full rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-[13px] text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-100" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Btn kind="warn" onClick={waive} busy={waiver.busy} disabled={reason.trim().length < 5}>Waive ACR</Btn>
            <Btn kind="secondary" onClick={() => { setWaiving(false); waiver.setError(null); }}>Cancel</Btn>
            {reason.trim().length < 5 && <span className="text-[11px] text-amber-700">At least 5 characters.</span>}
          </div>
          <ErrorLine text={waiver.error} />
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn kind="secondary" onClick={ask} busy={busy}>{requestedAt || asked ? "Remind agent" : "Request from agent"}</Btn>
          <Btn kind="secondary" onClick={() => setWaiving(true)}>Waive ACR</Btn>
        </div>
      )}
      <ErrorLine text={error} />
    </div>
  );
}

// ── 4 · PEP & sanctions ─────────────────────────────────────────────────────

const toneChip = (s: string) =>
  s === "Passed" || s === "Clear" || s === "Cleared" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
  : s === "Flagged" ? "border-amber-200 bg-amber-50 text-amber-700"
  : "border-rose-200 bg-rose-50 text-rose-700";

function PepStep({ checklist, item, changed, report }: StepProps) {
  const [res, setRes] = useState<any>(null);
  const { busy, error, run } = useAction();
  const forced = useAction();
  const [confirm, confirmDialog] = useConfirm();

  const screen = () => run(async () => {
    const out = await runCaseCompliance(checklist.tenantId, checklist.caseId);
    setRes(out);
    if (out.overall_status === "Passed") {
      report("pep", { tone: "ok", title: "Screening passed", lines: (out.checks ?? []).map((c: any) => `${c.check_type}: ${c.status}`) });
    }
    await changed();
  }, "Screening failed.");

  const proceedAnyway = async () => {
    const ok = await confirm({
      title: "Proceed past the flagged screening result?",
      message: "This is recorded against your name.",
      confirmLabel: "Proceed anyway",
      tone: "warn",
    });
    if (!ok) return;
    void forced.run(async () => {
      for (const c of (res?.checks ?? []).filter((x: any) => x.status === "Flagged")) await clearComplianceCheck(checklist.tenantId, c.id);
      report("pep", { tone: "warn", title: "Flagged result cleared to proceed" });
      setRes(null);
      await changed();
    }, "Couldn't clear the flagged result.");
  };

  return (
    <div>
      {res && res.overall_status !== "Passed" && (
        <div className="mt-3 space-y-2">
          {(res.checks ?? []).map((c: any) => (
            <div key={c.id || c.check_type} className="rounded-xl border border-slate-200 bg-white p-2.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">{c.check_type} check</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${toneChip(c.status)}`}>{c.status}</span>
              </div>
              {c.details && (
                <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-600">
                  {c.details.note && <p className="font-medium text-slate-700">{c.details.note}</p>}
                  {c.details.list && <p>List: {c.details.list}</p>}
                  {(c.details.reasons ?? []).map((r: string, i: number) => <p key={i}>{r}</p>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!res && item.state === "issue" && <p className="mt-2 text-[12px] text-slate-600">An earlier screening was flagged. Run it again to review the results here and decide whether to proceed.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn onClick={screen} busy={busy} kind={res ? "secondary" : "primary"}>{res ? "Run screening again" : "Run PEP Check"}</Btn>
        {res?.overall_status === "Flagged" && <Btn kind="warn" onClick={proceedAnyway} busy={forced.busy}>Proceed anyway</Btn>}
      </div>
      <ErrorLine text={error ?? forced.error} />
      {confirmDialog}
    </div>
  );
}

// ── 5 · Initial premium ─────────────────────────────────────────────────────

function IppStep({ checklist, item, changed, report }: StepProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="mt-3"><Btn onClick={() => setOpen(true)}>{item.status === "Initiated" ? "Resume payment" : "Collect Premium"}</Btn></div>
      {open && portalModal(
        <IPPModal
          caseId={checklist.caseId}
          customerName={checklist.customerName}
          onClose={() => setOpen(false)}
          onConfirmed={async () => {
            setOpen(false);
            report("ipp", { tone: "ok", title: "Initial premium collected" });
            await changed();
          }}
        />,
      )}
    </div>
  );
}

// ── 6 · Insurance history ───────────────────────────────────────────────────

function HistoryResult({ h }: { h: InsuranceHistory }) {
  const policies = [...(h.internal_policies ?? []), ...(h.external_policies ?? [])];
  return (
    <div className="mt-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Aggregate cover">{fmtCoverage(h.aggregate_sum_assured)}</Stat>
        <Stat label="Human Life Value cap">
          {h.hlv_limit != null ? fmtCoverage(h.hlv_limit) : "Unknown — no income"}
          {h.hlv_ratio != null && <span className={`ml-1.5 font-mono text-[10px] ${h.hlv_ratio > 1 ? "text-rose-600" : "text-emerald-600"}`}>{h.hlv_ratio}×</span>}
        </Stat>
        <Stat label="This insurer, in force">{fmtCoverage(h.internal_inforce_sum_assured)}</Stat>
        <Stat label="Other insurers, declared">{fmtCoverage(h.external_declared_sum_assured)}</Stat>
      </div>
      {(h.findings ?? []).length > 0 && (
        <div className="space-y-1">
          {h.findings.map((f, i) => (
            <p key={i} className={`border-l-2 py-0.5 pl-2.5 text-[12px] ${f.severity === "critical" ? "border-rose-400 text-rose-800" : f.severity === "warning" ? "border-amber-400 text-amber-800" : "border-slate-300 text-slate-600"}`}>{f.message}</p>
          ))}
        </div>
      )}
      {policies.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-wider text-slate-400">
              <tr><th className="px-2 py-1.5 text-left">Insurer</th><th className="px-2 py-1.5 text-right">Sum assured</th><th className="px-2 py-1.5 text-left">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {policies.map((p, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5 font-medium text-slate-700">{p.insurer}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-700">{fmtCoverage(p.sum_assured)}</td>
                  <td className="px-2 py-1.5 text-slate-500">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Cases whose history check has already been started on its own, so a re-render or a remount never starts it twice.
const autoStarted = new Set<string>();

function HistoryStep({ checklist, item, changed, report }: StepProps) {
  const { caseId } = checklist;
  const [h, setH] = useState<InsuranceHistory | null>(null);
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  const clearing = useAction();

  // Reopened on a flagged case: show what was found.
  useEffect(() => {
    if (item.status === "NotStarted") return;
    getInsuranceHistory(caseId).then(setH).catch(() => undefined);
  }, [caseId, item.status]);

  const check = () => run(async () => {
    const out = await runInsuranceHistory(caseId);
    setH(out);
    if (out.status === "Clear") report("history", { tone: "ok", title: "Insurance history is clear", lines: [`Aggregate cover ${fmtCoverage(out.aggregate_sum_assured)}`] });
    await changed();
  }, "Insurance history check failed.");

  const clearIt = () => clearing.run(async () => {
    await clearInsuranceHistory(caseId, note.trim());
    report("history", { tone: "warn", title: "Findings cleared by you", lines: [note.trim()] });
    await changed();
  }, "Couldn't clear the findings.");

  // It needs nothing from the user, so it runs the moment it becomes the step to do (right after the premium is in).
  // Once per case: if it fails, the button below is the way to try again.
  useEffect(() => {
    if (item.status !== "NotStarted" || autoStarted.has(caseId)) return;
    autoStarted.add(caseId);
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, item.status]);

  const flagged = h && h.status !== "Clear";
  return (
    <div>
      {busy && <Waiting>Checking this applicant's insurance history…</Waiting>}
      {flagged && <HistoryResult h={h} />}
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn onClick={check} busy={busy} kind={flagged ? "secondary" : "primary"}>{flagged ? "Run the check again" : error ? "Try again" : "Run History Check"}</Btn>
      </div>
      {flagged && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 p-2.5">
          <p className="text-[12px] font-semibold text-amber-900">Clear these findings to move on</p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why is it acceptable? (kept on the record)"
            className="mt-1.5 w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 focus:border-amber-400 focus:outline-none"
          />
          <div className="mt-2"><Btn kind="warn" onClick={clearIt} busy={clearing.busy} disabled={note.trim().length < 3}>Clear findings</Btn></div>
        </div>
      )}
      <ErrorLine text={error ?? clearing.error} />
    </div>
  );
}

// ── 7 · Medical ─────────────────────────────────────────────────────────────

function MedicalStep({ checklist, item, changed, report }: StepProps) {
  const { caseId } = checklist;
  const [order, setOrder] = useState<MedicalExamOrder | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const more = useAction();

  const seen = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await getMedicalExam(caseId);
      setOrder(next);
      if (seen.current !== null && seen.current !== next.status) void changed();
      seen.current = next.status;
    } catch { /* not assessed yet */ }
  }, [caseId, changed]);
  useEffect(() => { if (item.status !== "NotAssessed") void load(); }, [item.status, load]);
  const live = item.status === "Invited" || item.status === "Scheduled" || item.status === "Required";
  useLive(caseId, load, live);

  const assess = () => run(async () => {
    const out = await assessMedicalExam(caseId);
    setOrder(out);
    if (out.status === "NotRequired") {
      report("medical", { tone: "ok", title: "No medical examination required", lines: out.non_medical_limit != null ? [`Within the non-medical limit of ${fmtCoverage(out.non_medical_limit)}`] : undefined });
    } else {
      const invite = await inviteMedicalExam(caseId);
      setLink(`${PORTAL_ORIGIN}${invite.link_path}`);
    }
    await changed();
  }, "Medical assessment failed.");

  const freshLink = () => more.run(async () => {
    const invite = await inviteMedicalExam(caseId);
    setLink(`${PORTAL_ORIGIN}${invite.link_path}`);
    await load();
  }, "Couldn't create the report upload link.");

  const saveReview = (results: Record<string, string>) => more.run(async () => {
    const reviewed = await recordMedicalResult(caseId, { results, reported_by: "Underwriter" });
    setOrder(reviewed);
    setReviewing(false);
    report("medical", {
      tone: reviewed.uninsurable ? "bad" : reviewed.abnormal_findings?.length ? "warn" : "ok",
      title: reviewed.status === "Completed" ? "Medical reports reviewed" : "Medical review saved — outstanding tests remain",
      lines: [reviewed.outcome ? `Outcome: ${reviewed.outcome}` : "Reviewed values recorded.",
        ...(reviewed.abnormal_findings ?? []).map(f => f.finding)],
    });
    await changed();
  }, "Couldn't save the medical review.");

  const waive = () => more.run(async () => {
    await waiveMedicalExam(caseId, reason.trim());
    report("medical", { tone: "warn", title: "Examination waived", lines: [reason.trim()] });
    await changed();
  }, "Couldn't waive the examination.");

  if (item.status === "NotAssessed" || !order) {
    return (
      <div>
        <div className="mt-3"><Btn onClick={assess} busy={busy}>Assess Medical</Btn></div>
        <ErrorLine text={error} />
      </div>
    );
  }

  const reports = (order.reports ?? []).filter(usableReport);
  const coveredTests = new Set(reports.map(r => r.test_code)).size;
  const medicalDone = MEDICAL_CLEARED.has(order.status);
  return (
    <div>
      {order.trigger_reasons?.length > 0 && <p className="mt-2 text-[12px] text-slate-600">{order.trigger_reasons.join(" · ")}</p>}
      {order.required_tests?.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <ul className="max-h-44 divide-y divide-slate-50 overflow-y-auto text-[12px]">
            {order.required_tests.map((t) => (
              <li key={t.code} className="flex items-center justify-between px-2.5 py-1.5">
                <span className="text-slate-700">{t.name}{t.fasting && <span className="ml-1.5 text-[10px] text-slate-400">fasting</span>}</span>
                <span className="font-mono text-slate-500">PKR {Math.round(t.cost).toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-slate-100 bg-slate-50 px-2.5 py-1.5 text-right text-[11px] font-semibold text-slate-700">Estimated: PKR {Math.round(order.estimated_cost).toLocaleString()}</p>
        </div>
      )}
      {link && <LinkBox url={link} label="Report upload link for the customer" />}
      {order.appointment_at && <p className="mt-2 text-[12px] font-medium text-slate-700">Booked: {displayDateTime(order.appointment_at)}{order.clinic ? ` · ${order.clinic.name}` : ""}</p>}
      {!medicalDone && <Waiting>{order.reports_submitted ? "Reports submitted — ready for review." : reports.length ? `Reports uploaded for ${coveredTests} of ${order.required_tests.length} required tests.` : "Waiting for the customer to upload their medical reports…"}</Waiting>}
      {medicalDone && <p role="status" className="mt-2 text-xs font-medium text-emerald-700">{order.status === "Completed" ? "Medical results reviewed and rated." : order.status === "Waived" ? "Medical examination waived." : "No medical examination required."}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {!medicalDone && !link && <Btn kind="secondary" onClick={freshLink} busy={more.busy}>Get report upload link</Btn>}
        {(reports.length > 0 || order.status === "Scheduled") && <Btn onClick={() => { more.setError(null); setReviewing(true); }} busy={more.busy}>Review Reports</Btn>}
        {!medicalDone && <Btn kind="secondary" onClick={() => setWaiving((w) => !w)}>Waive</Btn>}
      </div>
      {waiving && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 p-2.5">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason for waiving the examination (kept on the record)"
            className="w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 focus:border-amber-400 focus:outline-none"
          />
          <div className="mt-2"><Btn kind="warn" onClick={waive} busy={more.busy} disabled={reason.trim().length < 3}>Waive examination</Btn></div>
        </div>
      )}
      <ErrorLine text={error ?? more.error} />
      {reviewing && portalModal(<MedicalReportReviewModal order={order} caseId={caseId} busy={more.busy} error={more.error} onClose={() => { if (!more.busy) setReviewing(false); }} onSubmit={saveReview} />)}
    </div>
  );
}

// ── Specialist reviews · medical and financial ──────────────────────────────

type Underwriter = { id: string; full_name: string; role: string; tracks: string[] };
type TrackReview = { status: string; submitted: boolean; reviewer: string | null; note: string | null };

/** One specialist review: assign its underwriter, then wait for them to record it in their own workspace. */
function ReviewStep({ checklist, item, changed, report }: StepProps) {
  const track = item.id === "medical_review" ? "medical" : "financial";
  const [review, setReview] = useState<TrackReview | null>(null);
  const [people, setPeople] = useState<Underwriter[]>([]);
  const [pick, setPick] = useState("");
  const { busy, error, run } = useAction();
  const root = `/tenants/${checklist.tenantId}`;

  const load = useCallback(async () => {
    try { setReview((await api.get(`${root}/cases/${checklist.caseId}/underwriting-tracks`)).data[track]); } catch { /* keep what is shown */ }
  }, [root, checklist.caseId, track]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!review || review.reviewer) return;
    api.get(`${root}/underwriting/underwriters`).then((r) => {
      // The track's own specialists first; general underwriters can take either review.
      const eligible = (r.data as Underwriter[]).filter((u) => u.tracks.includes(track))
        .sort((a, b) => Number(a.role === "Underwriter") - Number(b.role === "Underwriter"));
      setPeople(eligible);
      setPick((current) => current || eligible[0]?.id || "");
    }).catch(() => setPeople([]));
  }, [review, root, track]);
  // Their review arrives as a live case event (and on a slow poll while waiting).
  useLive(checklist.caseId, () => { void load().then(() => changed()); }, Boolean(review?.reviewer && !review.submitted));

  const assign = () => run(async () => {
    await api.put(`${root}/cases/${checklist.caseId}/underwriting-tracks/${track}`, { assigned_user_id: pick });
    const who = people.find((u) => u.id === pick)?.full_name ?? "the underwriter";
    report(item.id, { tone: "ok", title: `Assigned to ${who}`, lines: [`They'll see it in their ${track} review queue.`] });
    await load();
    await changed();
  }, "Couldn't assign the review.");

  if (!review) return <Waiting>Loading the {track} review…</Waiting>;
  if (!review.reviewer) {
    return (
      <div className="mt-3">
        {people.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <select value={pick} onChange={(e) => setPick(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13px] text-slate-800">
              {people.map((u) => <option key={u.id} value={u.id}>{u.full_name} · {u.role}</option>)}
            </select>
            <Btn onClick={assign} busy={busy} disabled={!pick}>Assign {track} underwriter</Btn>
          </div>
        ) : (
          <p className="text-[12px] text-amber-700">No active user can take the {track} review. Add a {track === "medical" ? "Medical" : "Financial"} Underwriter first.</p>
        )}
        <ErrorLine text={error} />
      </div>
    );
  }
  return (
    <div>
      <Waiting>
        {review.reviewer} is doing the {track} review ({review.status === "IN_REVIEW" ? "in review" : "not started"}) —
        {track === "medical" ? " medical e-application, examination reports and AI medical underwriting." : " financial e-application, insurance history, income documents and AI financial underwriting."}
      </Waiting>
      <p className="mt-1 text-[12px] text-slate-400">This updates by itself when they record their review.</p>
    </div>
  );
}

export function RequirementStep(props: StepProps) {
  switch (props.item.id) {
    case "docs": return <DocsStep {...props} />;
    case "eapp": return <EAppStep {...props} />;
    case "acr": return <AcrStep {...props} />;
    case "pep": return <PepStep {...props} />;
    case "ipp": return <IppStep {...props} />;
    case "history": return <HistoryStep {...props} />;
    case "medical": return <MedicalStep {...props} />;
    case "medical_review":
    case "financial_review": return <ReviewStep {...props} />;
  }
}
