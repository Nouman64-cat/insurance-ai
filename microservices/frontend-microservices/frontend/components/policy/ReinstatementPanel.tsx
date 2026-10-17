"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { fmtPKR } from "@/app/services/policies";
import {
  getReinstatement, openReinstatement, recalculateReinstatementArrears, submitReinstatementDeclaration,
  rerunReinstatementAssessment, receiveReinstatementEvidence, reinstatementEvidenceUrl, decideReinstatement,
  respondReinstatementTerms, payReinstatement, restoreReinstatement, withdrawReinstatement,
  reinstatementConfirmationUrl, sendReinstatementConfirmation,
  type ReinstatementOverview, type ReinstatementCase, type ReinstatementDecisionKind,
  type ReinstatementEvidence, type ReinstatementStep,
} from "@/app/services/postIssuance";
import { tx } from "@/lib/i18n/tx";
import { btnPrimary, btnGhost, btnDanger, inputCls, fmtDate, fmtDateTime, Chip, Stat, KV, CheckList } from "@/components/policy/panelKit";

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — Reinstatement. Revives a lapsed policy through a case that carries its
// own workflow, evidence, arrears, underwriting decision, payment and audit trail.
// The nine accordion rows below mirror services/reinstatement_engine.STEPS.
// ─────────────────────────────────────────────────────────────────────────────

const UNDERWRITING_ROLES = ["SuperAdmin", "Admin", "Underwriter"];
const READ_ONLY_ROLES = ["Agent", "Viewer"];
const PAY_CHANNELS = ["JazzCash", "Easypaisa", "Card", "BankTransfer", "Manual (offline)"];
const SIGNATURE_METHODS: { value: string; label: string }[] = [
  { value: "Wet", label: "Wet signature (paper form)" },
  { value: "ESign", label: "E-signature" },
  { value: "Portal", label: "Customer portal" },
];

const REC_TONE: Record<string, { label: string; cls: string }> = {
  StraightThrough: { label: "Straight-through", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  Review: { label: "Underwriter review", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  EvidenceRequired: { label: "Evidence required", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  Refer: { label: "Refer", cls: "bg-red-50 text-red-700 border-red-200" },
};

const CASE_TONE: Record<string, string> = {
  Open: "bg-blue-50 text-blue-700 border-blue-200",
  EvidenceRequested: "bg-amber-50 text-amber-700 border-amber-200",
  TermsOffered: "bg-amber-50 text-amber-700 border-amber-200",
  Approved: "bg-blue-50 text-blue-700 border-blue-200",
  Reinstated: "bg-blue-100 text-blue-800 border-blue-300",
  Declined: "bg-red-50 text-red-700 border-red-200",
  Withdrawn: "bg-slate-100 text-slate-600 border-slate-300",
};

function StateDot({ step }: Readonly<{ step: ReinstatementStep }>) {
  if (step.state === "done") {
    return (
      <span className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-white flex-shrink-0">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      </span>
    );
  }
  const cls = step.state === "current" ? "border-2 border-blue-600 text-blue-700 bg-white"
    : step.state === "closed" ? "bg-slate-100 text-slate-400 border border-slate-200" : "bg-slate-100 text-slate-500 border border-slate-200";
  return <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold flex-shrink-0 ${cls}`}>{step.n}</span>;
}

function StepCard({
  step, open, onToggle, children,
}: Readonly<{ step: ReinstatementStep; open: boolean; onToggle: () => void; children: React.ReactNode }>) {
  const detailCls = step.state === "current" ? "text-blue-600" : "text-slate-400";
  return (
    <div className={`rounded-xl border bg-white overflow-hidden ${step.state === "current" ? "border-blue-300" : "border-slate-200"}`}>
      <button onClick={onToggle} aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
        <StateDot step={step} />
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-bold ${step.state === "pending" || step.state === "closed" ? "text-slate-500" : "text-slate-800"}`}>{tx(step.title)}</span>
          <span className={`block text-[11px] truncate ${detailCls}`}>{step.detail}</span>
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && <div className="px-4 pb-4 pt-3 border-t border-slate-100">{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ReinstatementPanel({
  policyId, onChanged,
}: Readonly<{ policyId: string; onChanged: () => Promise<void> }>) {
  const { notify } = useNotify();
  const [ov, setOv] = useState<ReinstatementOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") setRole(localStorage.getItem("user_role"));
  }, []);

  const load = useCallback(async () => {
    try {
      setOv(await getReinstatement(policyId));
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? e?.message ?? tx("Failed to load reinstatement data."));
    }
  }, [policyId]);
  useEffect(() => { load(); }, [load]);

  const kase = ov?.case ?? null;
  const currentKey = kase?.workflow.find((s) => s.state === "current")?.key ?? null;
  // Follow the workflow: whenever the current step changes, open it.
  useEffect(() => { if (currentKey) setOpenStep(currentKey); }, [currentKey, kase?.id]);

  const readOnly = !!role && READ_ONLY_ROLES.includes(role);
  const canDecide = !!role && UNDERWRITING_ROLES.includes(role);
  const locked = busy || readOnly;

  const run = async (fn: () => Promise<ReinstatementOverview | unknown>, success: string, syncPage = false): Promise<boolean> => {
    setBusy(true); setErr(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "eligibility" in (res as object)) setOv(res as ReinstatementOverview);
      else await load();
      if (syncPage) await onChanged();
      notify(success, true);
      return true;
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setErr(typeof detail === "string" ? detail : e?.message ?? tx("Action failed."));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!ov) {
    return err
      ? <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>
      : <p className="text-xs text-slate-400 italic">{tx("Loading reinstatement data…")}</p>;
  }

  const el = ov.eligibility;
  const closed = !!kase && !kase.is_open;

  return (
    <div className="space-y-4">
      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 flex justify-between gap-3">
          <span>{err}</span>
          <button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">×</button>
        </div>
      )}
      {readOnly && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          {tx("🔒 Your role has read-only access to reinstatement cases.")}
        </div>
      )}

      {/* Headline numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={tx("Policy status")} value={ov.policy.status}
          tone={ov.policy.status === "Lapsed" ? "bad" : undefined} hint={ov.policy.product_name} />
        <Stat label={tx("Lapsed on")} value={fmtDate(el.lapse_date)}
          hint={el.days_lapsed != null ? `${el.days_lapsed} ${tx("day(s) ago")}` : undefined} />
        <Stat label={tx("Window closes")} value={fmtDate(el.window_ends_on)}
          tone={el.window_days_left != null && el.window_days_left < 30 ? "warn" : undefined}
          hint={el.window_days_left != null ? `${Math.max(el.window_days_left, 0)} ${tx("day(s) left")} · ${el.window_days}${tx("-day window")}` : undefined} />
        <Stat label={tx("To restore cover")} value={kase ? fmtPKR(kase.payment.realized_at ? kase.payment.amount : kase.arrears?.total ?? 0) : "—"}
          tone="accent" hint={kase ? tx("Arrears + authorised charges") : tx("Calculated when a case is opened")} />
      </div>

      {/* No case: eligibility outcome + the request form */}
      {!kase && (
        <NoCase ov={ov} locked={locked} onOpen={(body) => run(() => openReinstatement(policyId, body), tx("Reinstatement case opened."))} />
      )}

      {/* Case header */}
      {kase && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold font-mono text-slate-700 bg-white px-2.5 py-1 rounded-md border border-slate-200">{kase.case_no}</span>
            <Chip cls={CASE_TONE[kase.status] ?? CASE_TONE.Open}>{tx(kase.status)}</Chip>
            <span className="text-[11px] text-slate-500">{tx("Opened")} {fmtDate(kase.created_at)}</span>
            {ov.resumed && <Chip cls="bg-amber-50 text-amber-700 border-amber-200">{tx("Resumed existing case")}</Chip>}
          </div>
          {kase.is_open && !readOnly && (
            <button disabled={busy} onClick={() => setWithdrawOpen((v) => !v)} className={btnDanger}>{tx("Withdraw case")}</button>
          )}
        </div>
      )}

      {withdrawOpen && kase?.is_open && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-4 space-y-2">
          <p className="text-xs text-red-700 font-semibold">
            {tx("Withdrawing closes this case.")}{kase.payment.realized_at ? ` ${tx("The")} ${fmtPKR(kase.payment.amount)} ${tx("held against it will be refunded in full.")}` : ""}
          </p>
          <textarea value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} rows={2}
            placeholder={tx("Reason (optional)")} className={inputCls} />
          <div className="flex gap-2">
            <button disabled={locked} className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
              onClick={() => run(() => withdrawReinstatement(policyId, kase.id, { reason: withdrawReason || undefined }), tx("Reinstatement case withdrawn."))
                .then((ok) => { if (ok) { setWithdrawOpen(false); setWithdrawReason(""); } })}>{tx("Confirm withdrawal")}</button>
            <button className={btnGhost} onClick={() => setWithdrawOpen(false)}>{tx("Keep case")}</button>
          </div>
        </div>
      )}

      {closed && kase && (kase.status === "Declined" || kase.status === "Withdrawn") && (
        <div className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-xs text-slate-600">
          <b>{tx(kase.status)}.</b> {kase.closed_reason}
          {el.eligible && <span className="block mt-1 text-slate-500">{tx("The policy is still lapsed — a new request can be opened below.")}</span>}
        </div>
      )}

      {/* The nine steps */}
      {kase && (
        <div className="space-y-2">
          {kase.workflow.map((step) => (
            <StepCard key={step.key} step={step} open={openStep === step.key}
              onToggle={() => setOpenStep(openStep === step.key ? null : step.key)}>
              <StepBody step={step.key} ov={ov} kase={kase} policyId={policyId} locked={locked}
                canDecide={canDecide} run={run} />
            </StepCard>
          ))}
        </div>
      )}

      {/* A new request after a closed case on a still-lapsed policy */}
      {closed && el.eligible && (
        <NoCase ov={ov} locked={locked} onOpen={(body) => run(() => openReinstatement(policyId, body), tx("Reinstatement case opened."))} />
      )}

      {kase && kase.timeline.length > 0 && <Timeline items={kase.timeline} />}

      {ov.history.length > 1 && (
        <div className="rounded-xl border border-slate-200 bg-white">
          <p className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">{tx("Reinstatement history")}</p>
          <div className="divide-y divide-slate-100">
            {ov.history.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                <span className="font-mono font-semibold text-slate-700">{h.case_no}</span>
                <span className="text-slate-500 flex-1 truncate">{fmtDate(h.created_at)}{h.closed_reason ? ` · ${h.closed_reason}` : ""}</span>
                <span className="tabular-nums text-slate-600">{fmtPKR(h.total_payable)}</span>
                <Chip cls={CASE_TONE[h.status] ?? CASE_TONE.Open}>{tx(h.status)}</Chip>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Eligibility outcome + request form (no open case) ────────────────────────

function NoCase({
  ov, locked, onOpen,
}: Readonly<{ ov: ReinstatementOverview; locked: boolean; onOpen: (b: { applicant_name?: string; applicant_relationship: string; request_channel: string; reason?: string }) => void }>) {
  const el = ov.eligibility;
  const [form, setForm] = useState({
    applicant_name: ov.policy.customer_name ?? "", applicant_relationship: "Policyholder", request_channel: "Branch", reason: "",
  });

  const banner = {
    eligible: "border-blue-200 bg-blue-50 text-blue-800",
    not_required: "border-slate-200 bg-slate-50 text-slate-700",
    use_collection: "border-amber-200 bg-amber-50 text-amber-800",
    blocked: "border-red-200 bg-red-50 text-red-800",
    resume: "border-amber-200 bg-amber-50 text-amber-800",
  }[el.outcome];

  return (
    <div className="space-y-3">
      <div className={`rounded-xl border px-4 py-3 text-sm ${banner}`}>
        <p className="font-bold">{{
          eligible: tx("Eligible for reinstatement"), not_required: tx("No reinstatement required"),
          use_collection: tx("Use premium collection instead"), blocked: tx("Reinstatement not available"), resume: tx("Case already open"),
        }[el.outcome]}</p>
        <p className="text-xs mt-1 opacity-90">{el.message}</p>
      </div>

      {el.checks.length > 0 && el.outcome !== "not_required" && <CheckList checks={el.checks} />}

      {el.eligible && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <p className="text-sm font-bold text-slate-800">{tx("Register a reinstatement request")}</p>
          <p className="text-[11px] text-slate-500">
            {tx("Paying the overdue premium does not reinstate the policy by itself — the request goes through a health declaration and an underwriting decision. The original policy number and history are kept.")}
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-500">{tx("Applicant")}</label>
              <input value={form.applicant_name} onChange={(e) => setForm({ ...form, applicant_name: e.target.value })} className={`${inputCls} mt-1`} />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500">{tx("Applying as")}</label>
              <select value={form.applicant_relationship} onChange={(e) => setForm({ ...form, applicant_relationship: e.target.value })} className={`${inputCls} mt-1`}>
                {ov.options.relationships.map((r) => <option key={r} value={r}>{tx(r)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500">{tx("Request channel")}</label>
              <select value={form.request_channel} onChange={(e) => setForm({ ...form, request_channel: e.target.value })} className={`${inputCls} mt-1`}>
                {ov.options.channels.map((c) => <option key={c} value={c}>{tx(c)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500">{tx("Reason for lapse (optional)")}</label>
              <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={`${inputCls} mt-1`}
                placeholder={tx("e.g. missed payment while travelling")} />
            </div>
          </div>
          <button disabled={locked || !form.applicant_name.trim()} className={btnPrimary}
            onClick={() => onOpen({ ...form, applicant_name: form.applicant_name.trim(), reason: form.reason.trim() || undefined })}>
            {tx("Start reinstatement")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Step bodies ──────────────────────────────────────────────────────────────

type Run = (fn: () => Promise<unknown>, success: string, syncPage?: boolean) => Promise<boolean>;

function StepBody({
  step, ov, kase, policyId, locked, canDecide, run,
}: Readonly<{ step: string; ov: ReinstatementOverview; kase: ReinstatementCase; policyId: string; locked: boolean; canDecide: boolean; run: Run }>) {
  switch (step) {
    case "detect":
      return kase.eligibility
        ? <div className="space-y-2">
          <CheckList checks={kase.eligibility.checks} />
          <p className="text-[11px] text-slate-400">{tx("Evaluated when the case was opened")} · {fmtDateTime(kase.eligibility.evaluated_at)}</p>
        </div>
        : <p className="text-xs text-slate-400 italic">{tx("No eligibility snapshot on record.")}</p>;
    case "request":
      return (
        <div className="grid sm:grid-cols-3 gap-4">
          <KV label={tx("Case")} value={<span className="font-mono">{kase.case_no}</span>} />
          <KV label={tx("Applicant")} value={kase.applicant_name} />
          <KV label={tx("Applying as")} value={kase.applicant_relationship} />
          <KV label={tx("Channel")} value={kase.request_channel} />
          <KV label={tx("Registered by")} value={kase.requested_by} />
          <KV label={tx("Registered")} value={fmtDateTime(kase.created_at)} />
          <div className="sm:col-span-3"><KV label={tx("Reason for lapse")} value={kase.reason} /></div>
        </div>
      );
    case "arrears":
      return <ArrearsStep kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "declaration":
      return <DeclarationStep ov={ov} kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "assessment":
      return <AssessmentStep kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "decision":
      return <DecisionStep kase={kase} policyId={policyId} locked={locked} canDecide={canDecide} run={run} />;
    case "payment":
      return <PaymentStep kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "restore":
      return <RestoreStep kase={kase} policyId={policyId} locked={locked} run={run} />;
    default:
      return <ConfirmationStep kase={kase} policyId={policyId} locked={locked} run={run} />;
  }
}

function ArrearsStep({ kase, policyId, locked, run }: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  const a = kase.arrears;
  if (!a) return <p className="text-xs text-slate-400 italic">{tx("Arrears have not been calculated.")}</p>;
  const frozen = !!kase.payment.realized_at || !kase.is_open;
  return (
    <div className="space-y-3">
      {a.lines.length === 0 ? (
        <p className="text-xs text-slate-500">{tx("No unpaid premiums are outstanding.")}</p>
      ) : (
        <div className="rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
                <th className="text-left font-semibold px-3 py-2">{tx("Instalment")}</th>
                <th className="text-left font-semibold px-3 py-2">{tx("Due")}</th>
                <th className="text-right font-semibold px-3 py-2">{tx("Days overdue")}</th>
                <th className="text-right font-semibold px-3 py-2">{tx("Premium")}</th>
                <th className="text-right font-semibold px-3 py-2">{tx("Surcharge")}</th>
                {a.interest > 0 && <th className="text-right font-semibold px-3 py-2">{tx("Interest")}</th>}
                <th className="text-right font-semibold px-3 py-2">{tx("Total")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {a.lines.map((l) => (
                <tr key={l.schedule_id}>
                  <td className="px-3 py-2 font-semibold">#{l.installment_no}</td>
                  <td className="px-3 py-2">{fmtDate(l.due_date)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.days_overdue}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPKR(l.premium)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPKR(l.surcharge)}</td>
                  {a.interest > 0 && <td className="px-3 py-2 text-right tabular-nums">{fmtPKR(l.interest)}</td>}
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtPKR(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 text-xs space-y-1 max-w-sm ml-auto">
        <Row k={tx("Overdue premiums")} v={fmtPKR(a.premiums)} />
        <Row k={tx("Late-payment surcharge")} v={fmtPKR(a.surcharges)} />
        {a.interest > 0 && <Row k={tx("Interest")} v={fmtPKR(a.interest)} />}
        {a.fee > 0 && <Row k={tx("Reinstatement fee")} v={fmtPKR(a.fee)} />}
        <div className="border-t border-slate-200 pt-1.5 mt-1.5"><Row k={tx("Total payable")} v={fmtPKR(a.total)} strong /></div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-slate-400">
          {tx("Priced as of")} {fmtDate(a.as_of)}{frozen ? ` · ${tx("frozen")}` : ""}
        </p>
        {!frozen && (
          <button disabled={locked} className={btnGhost}
            onClick={() => run(() => recalculateReinstatementArrears(policyId, kase.id), tx("Arrears recalculated."))}>
            {tx("Recalculate to today")}
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, strong }: Readonly<{ k: string; v: string; strong?: boolean }>) {
  return (
    <div className="flex justify-between gap-6">
      <span className={strong ? "font-bold text-slate-800" : "text-slate-500"}>{k}</span>
      <span className={`tabular-nums ${strong ? "font-bold text-slate-900" : "text-slate-700"}`}>{v}</span>
    </div>
  );
}

// ── Step 4: declaration + evidence ───────────────────────────────────────────

function DeclarationStep({
  ov, kase, policyId, locked, run,
}: Readonly<{ ov: ReinstatementOverview; kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  const qs = ov.declaration_questions;
  const editable = kase.is_open && !["TermsOffered", "Approved"].includes(kase.status);
  const [editing, setEditing] = useState(!kase.declaration);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, string>>({});
  const [signedBy, setSignedBy] = useState(kase.applicant_name ?? "");
  const [method, setMethod] = useState("Wet");
  const [confirm, setConfirm] = useState(false);

  const complete = qs.every((q) => q.key in answers);
  const missingDetail = qs.some((q) => answers[q.key] === q.adverse_if && q.needs_details && !(details[q.key] ?? "").trim());

  return (
    <div className="space-y-4">
      {kase.declaration && !editing ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-600">
              {tx("Signed by")} <b>{kase.declaration_signed_by}</b> · {fmtDateTime(kase.declaration_signed_at)} · {kase.declaration.signature_method}
            </p>
            {editable && !locked && <button className={btnGhost} onClick={() => setEditing(true)}>{tx("Re-record declaration")}</button>}
          </div>
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {qs.map((q) => {
              const yes = kase.declaration!.answers[q.key];
              const adverse = yes === q.adverse_if;
              return (
                <div key={q.key} className="flex items-start justify-between gap-4 px-3 py-2">
                  <div>
                    <p className="text-xs text-slate-700">{q.text}</p>
                    {kase.declaration!.details[q.key] && <p className="text-[11px] text-slate-500 mt-0.5">“{kase.declaration!.details[q.key]}”</p>}
                  </div>
                  <Chip cls={adverse ? "bg-red-50 text-red-700 border-red-200" : "bg-slate-50 text-slate-600 border-slate-200"}>{yes ? tx("Yes") : tx("No")}</Chip>
                </div>
              );
            })}
          </div>
        </div>
      ) : editable ? (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-500">{tx("Declaration of Good Health / Risk Evaluation Form — answer every statement as the applicant confirms it.")}</p>
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {qs.map((q) => {
              const a = answers[q.key];
              const adverse = a !== undefined && a === q.adverse_if;
              return (
                <div key={q.key} className="px-3 py-2.5 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <p className="text-xs text-slate-700">{q.text}</p>
                    <div className="flex gap-1.5 flex-shrink-0">
                      {[true, false].map((val) => (
                        <button key={String(val)} onClick={() => setAnswers({ ...answers, [q.key]: val })}
                          className={`px-3 py-1 rounded-md text-[11px] font-semibold border ${a === val ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                          {val ? tx("Yes") : tx("No")}
                        </button>
                      ))}
                    </div>
                  </div>
                  {adverse && q.needs_details && (
                    <input value={details[q.key] ?? ""} onChange={(e) => setDetails({ ...details, [q.key]: e.target.value })}
                      placeholder={tx("Give details (required)")} className={inputCls} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-500">{tx("Signed by")}</label>
              <input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} className={`${inputCls} mt-1`} />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500">{tx("Signature method")}</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inputCls} mt-1`}>
                {SIGNATURE_METHODS.map((m) => <option key={m.value} value={m.value}>{tx(m.label)}</option>)}
              </select>
            </div>
          </div>
          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
            {tx("I confirm the applicant has signed this declaration and understands that misstatement or non-disclosure may void the policy.")}
          </label>
          <div className="flex gap-2">
            <button disabled={locked || !complete || missingDetail || !confirm || !signedBy.trim()} className={btnPrimary}
              onClick={() => run(
                () => submitReinstatementDeclaration(policyId, kase.id, { answers, details, signed_by: signedBy.trim(), signature_method: method, confirm_signed: confirm }),
                tx("Declaration recorded and assessed."),
              ).then((ok) => { if (ok) setEditing(false); })}>
              {tx("Record signed declaration")}
            </button>
            {kase.declaration && <button className={btnGhost} onClick={() => setEditing(false)}>{tx("Cancel")}</button>}
          </div>
          {!complete && <p className="text-[11px] text-amber-600">{tx("Answer every statement to continue.")}</p>}
          {complete && missingDetail && <p className="text-[11px] text-amber-600">{tx("Add details for each adverse answer.")}</p>}
        </div>
      ) : (
        <p className="text-xs text-slate-400 italic">{tx("The declaration is locked once an underwriting decision has been made.")}</p>
      )}

      <EvidenceList kase={kase} policyId={policyId} locked={locked} run={run} />
    </div>
  );
}

function EvidenceList({ kase, policyId, locked, run }: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  const editable = kase.is_open && !["TermsOffered", "Approved"].includes(kase.status);
  if (kase.evidence.length === 0) {
    return <p className="text-[11px] text-slate-400">{tx("No supporting documents requested. Underwriting can add requests with its decision.")}</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Supporting documents")}</p>
      <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
        {kase.evidence.map((e) => (
          <EvidenceRow key={e.key} e={e} policyId={policyId} caseId={kase.id} editable={editable} locked={locked} run={run} />
        ))}
      </div>
    </div>
  );
}

function EvidenceRow({
  e, policyId, caseId, editable, locked, run,
}: Readonly<{ e: ReinstatementEvidence; policyId: string; caseId: string; editable: boolean; locked: boolean; run: Run }>) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const received = e.status === "Received";
  return (
    <div className="px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-700">{e.label}</p>
          {e.reason && <p className="text-[11px] text-slate-500">{e.reason}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Chip cls={e.required ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-50 text-slate-500 border-slate-200"}>{e.required ? tx("Required") : tx("If needed")}</Chip>
          <Chip cls={received ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200"}>{received ? tx("Received") : tx("Requested")}</Chip>
        </div>
      </div>
      {received ? (
        <p className="text-[11px] text-slate-500">
          {fmtDateTime(e.received_at)}
          {e.has_file && <> · <a className="text-blue-600 hover:underline" target="_blank" rel="noreferrer"
            href={reinstatementEvidenceUrl(policyId, caseId, e.key)}>{e.file_name ?? tx("View file")}</a></>}
          {e.note ? ` · ${e.note}` : ""}
        </p>
      ) : editable && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(ev) => setFile(ev.target.files?.[0] ?? null)}
            className="text-[11px] text-slate-500 max-w-[220px]" />
          <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder={tx("Note (e.g. verified in person)")} className={`${inputCls} flex-1 min-w-[160px]`} />
          <button disabled={locked || (!file && !note.trim())} className={btnGhost}
            onClick={() => run(() => receiveReinstatementEvidence(policyId, caseId, e.key, { file, note: note.trim() || undefined }), tx("Document recorded as received."))}>
            {tx("Mark received")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Step 5: assessment ───────────────────────────────────────────────────────

function AssessmentStep({ kase, policyId, locked, run }: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  const a = kase.assessment;
  if (!a) return <p className="text-xs text-slate-400 italic">{tx("The assessment runs once the signed declaration is recorded.")}</p>;
  const rec = REC_TONE[a.recommendation] ?? REC_TONE.Review;
  const m = a.metrics;
  const canRerun = kase.is_open && !["TermsOffered", "Approved"].includes(kase.status);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Chip cls={rec.cls}>{tx(rec.label)}</Chip>
        <p className="text-xs text-slate-600 flex-1 min-w-[200px]">{a.summary}</p>
        {canRerun && <button disabled={locked} className={btnGhost} onClick={() => run(() => rerunReinstatementAssessment(policyId, kase.id), tx("Assessment re-run."))}>{tx("Re-run")}</button>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KV label={tx("Lapse duration")} value={m.lapse_days != null ? `${m.lapse_days} ${tx("days")}` : "—"} />
        <KV label={tx("Applicant age")} value={m.age != null ? String(m.age) : tx("Unknown")} />
        <KV label={tx("Sum assured")} value={fmtPKR(m.sum_assured)} />
        <KV label={tx("Non-medical limit")} value={<span className={m.over_non_medical_limit ? "text-amber-600" : ""}>{fmtPKR(m.non_medical_limit)}</span>} />
      </div>
      {a.flags.length === 0 ? (
        <p className="text-xs text-slate-500">{tx("No risk flags raised.")}</p>
      ) : (
        <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
          {a.flags.map((f) => (
            <div key={f.code} className="flex items-start gap-2.5 px-3 py-2">
              <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${f.severity === "high" ? "bg-red-500" : f.severity === "medium" ? "bg-amber-500" : "bg-slate-400"}`} />
              <p className="text-xs text-slate-700">{f.message}</p>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-slate-400">{tx("A recommendation for the underwriter — it never approves or declines on its own.")}</p>
    </div>
  );
}

// ── Step 6: decision ─────────────────────────────────────────────────────────

const DECISIONS: { value: ReinstatementDecisionKind; label: string; hint: string }[] = [
  { value: "Approve", label: "Approve", hint: "Reinstate on the original terms" },
  { value: "ApproveWithTerms", label: "Offer revised terms", hint: "Loading and/or exclusion — the customer must accept" },
  { value: "RequestEvidence", label: "Request more evidence", hint: "Hold the case until documents arrive" },
  { value: "Decline", label: "Decline", hint: "Close the case — the policy stays lapsed" },
];

function DecisionStep({
  kase, policyId, locked, canDecide, run,
}: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; canDecide: boolean; run: Run }>) {
  const [choice, setChoice] = useState<ReinstatementDecisionKind>("Approve");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState("");
  const [excl, setExcl] = useState("");
  const [asks, setAsks] = useState<string[]>([""]);

  const blocker = useMemo(() => {
    if (!kase.is_open) return tx("This case is closed.");
    if (kase.payment.realized_at) return tx("Funds have been received — the decision can no longer be changed.");
    if (choice !== "Decline" && choice !== "RequestEvidence") {
      if (!kase.declaration_signed_at) return tx("Record the signed declaration first.");
      if (!kase.conditions.evidence) return tx("Required evidence is still outstanding.");
    }
    if (choice === "ApproveWithTerms" && !(Number(loading) > 0 || excl.trim())) return tx("Enter a loading and/or an exclusion.");
    if (choice !== "Approve" && !notes.trim()) return tx("Notes are required for this decision.");
    if (choice === "RequestEvidence" && !asks.some((a) => a.trim())) return tx("List at least one document.");
    if (choice === "Approve" && kase.assessment?.recommendation === "Refer" && !notes.trim()) return tx("The assessment recommends referral — record your rationale.");
    return null;
  }, [kase, choice, notes, loading, excl, asks]);

  return (
    <div className="space-y-4">
      {kase.decision && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 space-y-1">
          <p className="text-xs text-slate-700">
            <b>{tx(DECISIONS.find((d) => d.value === kase.decision)?.label ?? kase.decision)}</b>
            {" · "}{kase.decided_by} · {fmtDateTime(kase.decided_at)}
          </p>
          {kase.decision_notes && <p className="text-[11px] text-slate-500">{kase.decision_notes}</p>}
        </div>
      )}

      {kase.is_open && !kase.payment.realized_at && (canDecide ? (
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Record underwriting decision")}</p>
          <div className="grid sm:grid-cols-2 gap-2">
            {DECISIONS.map((d) => (
              <button key={d.value} onClick={() => setChoice(d.value)}
                className={`text-left rounded-lg border px-3 py-2 ${choice === d.value ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                <span className={`block text-xs font-bold ${choice === d.value ? "text-blue-800" : "text-slate-700"}`}>{tx(d.label)}</span>
                <span className="block text-[11px] text-slate-500">{tx(d.hint)}</span>
              </button>
            ))}
          </div>

          {choice === "ApproveWithTerms" && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-slate-500">{tx("Premium loading (%)")}</label>
                <input type="number" min={0} value={loading} onChange={(e) => setLoading(e.target.value)} className={`${inputCls} mt-1`} />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-500">{tx("Exclusion (optional)")}</label>
                <input value={excl} onChange={(e) => setExcl(e.target.value)} className={`${inputCls} mt-1`} placeholder={tx("e.g. No cover for hazardous sports")} />
              </div>
            </div>
          )}

          {choice === "RequestEvidence" && (
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-slate-500">{tx("Documents required")}</label>
              {asks.map((a, i) => (
                <div key={i} className="flex gap-2">
                  <input value={a} onChange={(e) => setAsks(asks.map((x, j) => (j === i ? e.target.value : x)))} className={inputCls}
                    placeholder={tx("e.g. Cardiologist report")} />
                  {asks.length > 1 && <button className="text-slate-300 hover:text-red-500 px-1" onClick={() => setAsks(asks.filter((_, j) => j !== i))}>×</button>}
                </div>
              ))}
              <button className="text-[11px] text-blue-600 font-semibold" onClick={() => setAsks([...asks, ""])}>{tx("+ Add document")}</button>
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold text-slate-500">{tx("Notes")}{choice === "Approve" ? ` (${tx("optional")})` : ""}</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} mt-1`} />
          </div>

          <div className="flex items-center gap-3">
            <button disabled={locked || !!blocker} className={choice === "Decline" ? "px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40" : btnPrimary}
              onClick={() => run(
                () => decideReinstatement(policyId, kase.id, {
                  decision: choice, notes: notes.trim() || undefined,
                  loading_pct: choice === "ApproveWithTerms" && Number(loading) > 0 ? Number(loading) : undefined,
                  exclusions: choice === "ApproveWithTerms" ? excl.trim() || undefined : undefined,
                  evidence: choice === "RequestEvidence" ? asks.filter((a) => a.trim()).map((label) => ({ label: label.trim() })) : undefined,
                }),
                tx("Underwriting decision recorded."),
              ).then((ok) => { if (ok) { setNotes(""); setLoading(""); setExcl(""); setAsks([""]); } })}>
              {tx("Record decision")}
            </button>
            {blocker && <p className="text-[11px] text-amber-600">{blocker}</p>}
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500">{tx("Only an Underwriter or Admin can record the underwriting decision.")}</p>
      ))}

      {kase.decision_history.length > 1 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">{tx("Decision history")}</p>
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {[...kase.decision_history].reverse().map((h, i) => (
              <div key={i} className="px-3 py-2 text-xs text-slate-600">
                <b className="text-slate-700">{tx(DECISIONS.find((d) => d.value === h.decision)?.label ?? h.decision)}</b> · {h.by} · {fmtDateTime(h.at)}
                {h.notes && <span className="block text-[11px] text-slate-500">{h.notes}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 7: conditions + payment ─────────────────────────────────────────────

function PaymentStep({ kase, policyId, locked, run }: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  const [channel, setChannel] = useState(PAY_CHANNELS[0]);
  const [reference, setReference] = useState("");
  const c = kase.conditions;
  const manual = channel.startsWith("Manual");
  const paid = !!kase.payment.realized_at;
  const items: [string, boolean][] = [
    [tx("Signed health declaration"), c.declaration], [tx("Required evidence received"), c.evidence],
    [tx("Underwriting approval"), c.decision], [tx("Revised terms accepted (if any)"), c.terms],
    [tx("Funds realised in full"), c.payment],
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
        {items.map(([label, ok]) => (
          <div key={label} className="flex items-center gap-3 px-3 py-2">
            <span className={ok ? "text-blue-600" : "text-slate-300"}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </span>
            <span className={`text-xs ${ok ? "text-slate-700 font-semibold" : "text-slate-400"}`}>{label}</span>
          </div>
        ))}
      </div>

      {kase.status === "TermsOffered" && kase.terms && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
          <p className="text-sm font-bold text-amber-800">{tx("Revised terms awaiting the customer's response")}</p>
          <div className="grid sm:grid-cols-3 gap-4">
            <KV label={tx("Loading")} value={kase.terms.loading_pct ? `${kase.terms.loading_pct}%` : "—"} />
            <KV label={tx("Extra premium")} value={kase.terms.additional_annual_premium ? `+${fmtPKR(kase.terms.additional_annual_premium)}${tx("/yr")}` : "—"} />
            <KV label={tx("New annual premium")} value={kase.terms.new_annual_premium ? fmtPKR(kase.terms.new_annual_premium) : "—"} />
            <div className="sm:col-span-3"><KV label={tx("Exclusion")} value={kase.terms.exclusions} /></div>
          </div>
          <div className="flex gap-2">
            <button disabled={locked} className={btnPrimary}
              onClick={() => run(() => respondReinstatementTerms(policyId, kase.id, { accepted: true }), tx("Revised terms accepted."))}>{tx("Customer accepts")}</button>
            <button disabled={locked} className={btnDanger}
              onClick={() => { if (confirm(tx("Rejecting the revised terms closes this case. Continue?"))) run(() => respondReinstatementTerms(policyId, kase.id, { accepted: false }), tx("Revised terms rejected — case closed.")); }}>
              {tx("Customer rejects")}
            </button>
          </div>
        </div>
      )}
      {kase.terms && kase.terms_response === "Accepted" && (
        <p className="text-[11px] text-slate-500">{tx("Revised terms accepted")} {fmtDateTime(kase.terms_responded_at)} · {kase.terms_responded_by}</p>
      )}

      {paid ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 grid sm:grid-cols-4 gap-4">
          <KV label={tx("Received")} value={fmtPKR(kase.payment.amount)} />
          <KV label={tx("Method")} value={kase.payment.method} />
          <KV label={tx("Reference")} value={<span className="font-mono text-xs">{kase.payment.reference}</span>} />
          <KV label={tx("Realised")} value={fmtDateTime(kase.payment.realized_at)} />
          <p className="sm:col-span-4 text-[11px] text-slate-500">
            {kase.status === "Reinstated"
              ? tx("Applied to the premium ledger when cover was restored.")
              : tx("Held against this case — posted to the premium ledger only when cover is restored.")}
          </p>
        </div>
      ) : kase.status === "Approved" && kase.is_open ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <p className="text-xs text-slate-600">{tx("Amount to collect")}: <b className="text-slate-900 tabular-nums">{fmtPKR(kase.arrears?.total ?? kase.total_payable)}</b>
            <span className="text-slate-400"> · {tx("re-priced to today when you collect")}</span></p>
          <div className="grid sm:grid-cols-2 gap-3">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputCls}>
              {PAY_CHANNELS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {manual && <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={tx("Receipt / reference no.")} className={inputCls} />}
          </div>
          <button disabled={locked} className={btnPrimary}
            onClick={() => run(() => payReinstatement(policyId, kase.id, manual ? { manual: true, reference: reference || undefined } : { method: channel }), tx("Payment received."))}>
            {tx("Collect payment")}
          </button>
        </div>
      ) : (
        kase.is_open && <p className="text-xs text-slate-400 italic">{tx("Payment opens once underwriting approves and any revised terms are accepted.")}</p>
      )}
    </div>
  );
}

// ── Step 8: restore ──────────────────────────────────────────────────────────

function RestoreStep({ kase, policyId, locked, run }: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  if (kase.status === "Reinstated") {
    return (
      <div className="space-y-2">
        <div className="grid sm:grid-cols-3 gap-4">
          <KV label={tx("Lapsed on")} value={fmtDate(kase.lapse_date)} />
          <KV label={tx("Cover restored (effective)")} value={fmtDate(kase.effective_date)} />
          <KV label={tx("Restored at")} value={fmtDateTime(kase.reinstated_at)} />
        </div>
        <p className="text-[11px] text-slate-500">{tx("No cover was in force between the lapse date and the effective date.")}</p>
        {kase.receipts.length > 0 && (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {kase.receipts.map((r) => (
              <div key={r.receipt_no} className="flex justify-between px-3 py-2 text-xs text-slate-600">
                <span>{r.receipt_no} · {tx("instalment")} #{r.installment_no}</span>
                <span className="tabular-nums font-semibold">{fmtPKR(r.total)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        {tx("Restoring cover moves the policy from Lapsed to Active, settles the arrears in the premium ledger, issues receipts and records a new policy version. Cover is effective from today.")}
      </p>
      {kase.restore_blockers.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 space-y-0.5">
          {kase.restore_blockers.map((b) => <p key={b}>{b}</p>)}
        </div>
      )}
      <button disabled={locked || !kase.can_restore} className={btnPrimary}
        onClick={() => { if (confirm(tx("Restore cover on this policy now?"))) run(() => restoreReinstatement(policyId, kase.id), tx("Cover restored — policy is Active."), true); }}>
        {tx("Restore cover")}
      </button>
      {!kase.can_restore && kase.is_open && <p className="text-[11px] text-slate-400">{tx("Complete the conditions in the previous step to enable this.")}</p>}
    </div>
  );
}

// ── Step 9: confirmation ─────────────────────────────────────────────────────

function ConfirmationStep({ kase, policyId, locked, run }: Readonly<{ kase: ReinstatementCase; policyId: string; locked: boolean; run: Run }>) {
  if (kase.status !== "Reinstated") {
    return <p className="text-xs text-slate-400 italic">{tx("The confirmation is issued once cover has been restored.")}</p>;
  }
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-3 gap-4">
        <KV label={tx("Generated")} value={fmtDateTime(kase.confirmation.generated_at)} />
        <KV label={tx("Sent to customer")} value={kase.confirmation.sent_at ? `${fmtDateTime(kase.confirmation.sent_at)} · ${kase.confirmation.sent_to}` : tx("Not sent")} />
        <KV label={tx("Audit record")} value={tx("Retained — see timeline below")} />
      </div>
      <div className="flex gap-2">
        <a href={reinstatementConfirmationUrl(policyId, kase.id)} target="_blank" rel="noreferrer"
          className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white">{tx("Download confirmation (PDF)")}</a>
        <button disabled={locked} className={btnGhost}
          onClick={() => run(async () => {
            const r = await sendReinstatementConfirmation(policyId, kase.id);
            if (!r.delivered) throw new Error(tx("The email could not be delivered (mail provider not configured or rejected it)."));
          }, tx("Confirmation emailed to the customer."))}>
          {tx("Email to customer")}
        </button>
      </div>
    </div>
  );
}

// ── Audit timeline ───────────────────────────────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  ReinstatementRequested: "Request registered", ReinstatementArrearsCalculated: "Arrears calculated",
  ReinstatementDeclarationReceived: "Declaration received", ReinstatementAssessed: "Underwriting assessment run",
  ReinstatementEvidenceReceived: "Evidence received", ReinstatementDecision: "Underwriting decision",
  ReinstatementTermsAccepted: "Revised terms accepted", ReinstatementTermsRejected: "Revised terms rejected",
  ReinstatementPaymentReceived: "Payment received", ReinstatementPaymentFailed: "Payment failed",
  PolicyReinstated: "Cover restored", ReinstatementConfirmationIssued: "Confirmation issued",
  ReinstatementConfirmationSent: "Confirmation sent", ReinstatementWithdrawn: "Case withdrawn",
};

function Timeline({ items }: Readonly<{ items: ReinstatementCase["timeline"] }>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 text-left">
        <span className="text-sm font-bold text-slate-800">{tx("Audit trail")} <span className="ml-1 text-[10px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">{items.length}</span></span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <ol className="px-4 pb-4 pt-3 border-t border-slate-100 space-y-3">
          {items.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${/Failed|Rejected|Withdrawn/.test(e.event_type) ? "bg-red-500" : e.event_type === "PolicyReinstated" ? "bg-blue-600" : "bg-slate-400"}`} />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-700">
                  {tx(EVENT_LABEL[e.event_type] ?? e.event_type)}
                  {e.from_status && e.to_status && <span className="ml-2 text-[11px] font-medium text-slate-500">{e.from_status} → {e.to_status}</span>}
                </p>
                <p className="text-[11px] text-slate-400">{fmtDateTime(e.at)} · {e.actor ?? "system"}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
