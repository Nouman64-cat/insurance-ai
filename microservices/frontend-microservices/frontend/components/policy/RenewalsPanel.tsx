"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { fmtPKR } from "@/app/services/policies";
import {
  getRenewals, openRenewal, sendRenewalNotice, renewalNoticeUrl, reevaluateRenewalRisk, decideRenewalRisk,
  captureRenewalAcceptance, payRenewal, reconcileRenewal, completeRenewal, cancelRenewal,
  renewalConfirmationUrl, sendRenewalConfirmation,
  type RenewalOverview, type RenewalCase, type RenewalStage,
} from "@/app/services/postIssuance";
import {
  AuditTimeline, btnDanger, btnGhost, btnPrimary, CheckList, Chip, fmtDate, fmtDateTime, inputCls, KV, Stat,
} from "@/components/policy/panelKit";
import { tx } from "@/lib/i18n/tx";

// ─────────────────────────────────────────────────────────────────────────────
// Stage B · Step 7 — Policy Renewals.
//
// Two different processes share this panel and are never mixed:
//   Premium Renewal  — collect the next scheduled premium; the policy simply continues.
//   Contract Renewal — renew cover for another term: risk evaluation + acceptance + bind.
// The "Renewal processing" tracker is supplied by the backend (renewal_engine.project_stages),
// so the rows shown always match what the server will actually enforce.
// ─────────────────────────────────────────────────────────────────────────────

const UNDERWRITING_ROLES = ["SuperAdmin", "Admin", "Underwriter"];
const READ_ONLY_ROLES = ["Agent", "Viewer"];
const PAY_CHANNELS = ["JazzCash", "Easypaisa", "Card", "BankTransfer", "Manual (offline)"];

const STATE_TEXT: Record<RenewalStage["state"], string> = {
  complete: "text-blue-700", pending: "text-amber-600", awaiting: "text-amber-600", action: "text-amber-700",
  exception: "text-red-600", not_started: "text-slate-400", skipped: "text-slate-400",
};

const TIMING_CHIP: Record<string, { label: string; cls: string }> = {
  Upcoming: { label: "Upcoming", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  InWindow: { label: "Notice window open", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  Due: { label: "Due today", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  Overdue: { label: "Overdue", cls: "bg-red-50 text-red-700 border-red-200" },
};

const EVENT_LABEL: Record<string, string> = {
  RenewalOpened: "Renewal opened", RenewalNoticeIssued: "Renewal notice issued", RenewalRiskEvaluated: "Risk evaluated",
  RenewalRiskDecision: "Underwriting decision", RenewalAccepted: "Renewed terms accepted", RenewalDeclined: "Renewed terms declined",
  PremiumCollected: "Premium collected", RenewalReconciled: "Payment reconciled",
  RenewalReconciliationException: "Reconciliation exception", PremiumRenewalCompleted: "Premium renewal completed",
  PolicyRenewed: "Contract renewed", RenewalConfirmationIssued: "Confirmation issued",
  RenewalConfirmationSent: "Confirmation sent", RenewalCancelled: "Renewal cancelled",
};

function StageIcon({ state }: Readonly<{ state: RenewalStage["state"] }>) {
  if (state === "complete") {
    return (
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white flex-shrink-0">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      </span>
    );
  }
  const cls = state === "exception" ? "border-red-300 bg-red-50 text-red-600"
    : state === "pending" || state === "awaiting" || state === "action" ? "border-amber-300 bg-amber-50 text-amber-600"
      : "border-slate-200 bg-slate-50 text-slate-300";
  return <span className={`flex items-center justify-center w-6 h-6 rounded-full border flex-shrink-0 ${cls}`}><span className="w-1.5 h-1.5 rounded-full bg-current" /></span>;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function RenewalsPanel({
  policyId, onChanged, onOpenReinstatement,
}: Readonly<{ policyId: string; onChanged: () => Promise<void>; onOpenReinstatement?: () => void }>) {
  const { notify } = useNotify();
  const [ov, setOv] = useState<RenewalOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<string | null>("eligibility");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") setRole(localStorage.getItem("user_role"));
  }, []);

  const load = useCallback(async () => {
    try {
      setOv(await getRenewals(policyId));
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? e?.message ?? tx("Failed to load renewal data."));
    }
  }, [policyId]);
  useEffect(() => { load(); }, [load]);

  const openCase = ov?.case?.is_open ? ov.case : null;
  // Follow the workflow: open the first step that still needs attention.
  const currentKey = ov?.stages.find((s) => !["complete", "skipped"].includes(s.state))?.key ?? null;
  useEffect(() => { if (currentKey && openCase) setOpenStage(currentKey); }, [currentKey, openCase?.id]);

  const readOnly = !!role && READ_ONLY_ROLES.includes(role);
  const canDecide = !!role && UNDERWRITING_ROLES.includes(role);
  const locked = busy || readOnly;

  const run = async (fn: () => Promise<unknown>, success: string, syncPage = false): Promise<boolean> => {
    setBusy(true); setErr(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "stages" in (res as object) && "eligibility" in (res as object)) setOv(res as RenewalOverview);
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
      : <p className="text-xs text-slate-400 italic">{tx("Loading renewal data…")}</p>;
  }

  const el = ov.eligibility;
  const next = ov.next;
  const kase = ov.case;
  const lastDone = kase && !kase.is_open && kase.status === "Completed" ? kase : null;
  const closedCase = kase && !kase.is_open && kase.status !== "Completed" ? kase : null;

  // Header numbers: the open case's own figures when there is one, else the upcoming cycle.
  const dueDate = openCase?.due_date ?? next?.due_date ?? null;
  const premium = openCase
    ? (openCase.payment && openCase.payment.status !== "Paid" ? openCase.payment.payable : openCase.quoted_amount)
    : next?.payable ?? null;
  const typeLabel = openCase?.renewal_type_label ?? next?.renewal_type_label ?? tx("—");
  const isContract = (openCase?.renewal_type ?? next?.renewal_type) === "ContractRenewal";

  const statusChip = (() => {
    if (openCase) return openCase.status === "Referred"
      ? { label: tx("Awaiting underwriting"), cls: "bg-amber-50 text-amber-700 border-amber-200" }
      : { label: tx("In progress"), cls: "bg-blue-50 text-blue-700 border-blue-200" };
    if (el.outcome === "use_reinstatement") return { label: tx("Lapsed"), cls: "bg-red-50 text-red-700 border-red-200" };
    if (el.outcome === "group_scheme") return { label: tx("Group scheme"), cls: "bg-slate-50 text-slate-600 border-slate-200" };
    if (el.outcome === "term_complete") return { label: tx("Term complete"), cls: "bg-slate-50 text-slate-600 border-slate-200" };
    if (next) { const t = TIMING_CHIP[next.state]; return { label: tx(t.label), cls: t.cls }; }
    return { label: tx("—"), cls: "bg-slate-50 text-slate-600 border-slate-200" };
  })();

  const showTracker = !!next || !!openCase;

  return (
    <div className="space-y-4">
      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 flex justify-between gap-3">
          <span>{err}</span><button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">×</button>
        </div>
      )}
      {readOnly && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          {tx("🔒 Your role has read-only access to renewals.")}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chip cls={statusChip.cls}>{statusChip.label}</Chip>
        {ov.resumed && <Chip cls="bg-amber-50 text-amber-700 border-amber-200">{tx("Resumed existing renewal")}</Chip>}
        {openCase && <span className="text-xs font-mono font-semibold text-slate-600 bg-white border border-slate-200 rounded-md px-2.5 py-1">{openCase.renewal_no}</span>}
      </div>

      {/* Not applicable / redirect banners */}
      {!openCase && el.outcome === "use_reinstatement" && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-red-700">{tx("Policy has lapsed")}</p>
            <p className="text-xs text-red-600/90 mt-0.5 max-w-xl">{el.message}</p>
          </div>
          {onOpenReinstatement && (
            <button onClick={onOpenReinstatement} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-red-200 text-red-700 hover:bg-red-100">{tx("Go to Reinstatement")}</button>
          )}
        </div>
      )}
      {ov.group_scheme && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 space-y-3">
          <p className="text-sm font-bold text-slate-800">{tx("Group scheme — renews at master-policy level")}</p>
          <p className="text-xs text-slate-600 max-w-2xl">{el.message}{" "}{tx("Premium and contract renewal for the employer's scheme are run once for the whole group, not per certificate.")}</p>
          <div className="grid sm:grid-cols-4 gap-4">
            <KV label={tx("Master policy")} value={ov.group_scheme.master_policy_number} />
            <KV label={tx("Scheme expires")} value={fmtDate(ov.group_scheme.expiry_date)} />
            <KV label={tx("Latest renewal")} value={ov.group_scheme.latest_renewal_status} />
            <KV label={tx("Renewed to")} value={fmtDate(ov.group_scheme.latest_renewal_period_end)} />
          </div>
          {ov.group_scheme.organization_id && (
            <a href={`/admin/organizations/${ov.group_scheme.organization_id}`} className={`inline-block ${btnGhost}`}>{tx("Open the employer scheme")}</a>
          )}
        </div>
      )}
      {!openCase && !ov.group_scheme && ["blocked", "term_complete"].includes(el.outcome) && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${el.outcome === "blocked" ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
          <p className="font-bold">{el.outcome === "blocked" ? tx("Renewal not available") : tx("Policy term complete")}</p>
          <p className="text-xs mt-1 opacity-90">{el.message}</p>
        </div>
      )}

      {/* The three headline cards from the design */}
      {(next || openCase) && (
        <div className="grid sm:grid-cols-3 gap-3">
          <Stat label={tx("Next due date")} value={fmtDate(dueDate)} tone={next?.state === "Overdue" ? "bad" : undefined}
            hint={next && !openCase ? (next.days_until >= 0
              ? `${next.days_until} ${tx("day(s) away")} · ${tx("notice window opens")} ${fmtDate(next.window_opens_on)}`
              : `${Math.abs(next.days_until)} ${tx("day(s) overdue")}`) : undefined} />
          <Stat label={tx("Renewal premium")} value={premium != null ? fmtPKR(premium) : "—"} tone="accent"
            hint={[next?.frequency && `${tx(next.frequency)} ${tx("instalment")}`,
              openCase?.payment && openCase.payment.surcharge > 0 && `${tx("incl.")} ${fmtPKR(openCase.payment.surcharge)} ${tx("late surcharge")}`,
              !openCase && next && next.surcharge > 0 && `${tx("incl.")} ${fmtPKR(next.surcharge)} ${tx("late surcharge")}`]
              .filter(Boolean).join(" · ") || undefined} />
          <Stat label={tx("Renewal type")} value={tx(typeLabel)}
            hint={isContract ? tx("Renews the insurance contract for another term") : tx("Continues the existing policy — contract unchanged")} />
        </div>
      )}

      {/* Start button (no open case, eligible) */}
      {!openCase && el.eligible && next && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-blue-900 max-w-xl">
            {next.state === "Upcoming"
              ? `${tx("The notice window opens on")} ${fmtDate(next.window_opens_on)}. ${tx("You can start the renewal early.")}`
              : tx("The renewal window is open — start the renewal to issue the notice and collect the premium.")}
          </p>
          <button disabled={locked} className={btnPrimary}
            onClick={() => run(() => openRenewal(policyId), tx("Renewal started."))}>{tx("Start renewal")}</button>
        </div>
      )}

      {/* Renewal processing tracker */}
      {showTracker && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Renewal processing")}</p>
            {!openCase && <p className="text-[11px] text-slate-400">{tx("Start the renewal to act on these steps")}</p>}
          </div>
          <div className="divide-y divide-slate-100">
            {ov.stages.map((st) => {
              const expandable = !!openCase || st.key === "eligibility";
              const open = expandable && openStage === st.key;
              return (
                <div key={st.key}>
                  <button disabled={!expandable} onClick={() => setOpenStage(open ? null : st.key)} aria-expanded={open}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left ${expandable ? "hover:bg-slate-50" : "cursor-default"}`}>
                    <StageIcon state={st.state} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm font-semibold ${st.state === "not_started" || st.state === "skipped" ? "text-slate-500" : "text-slate-800"}`}>{tx(st.title)}</span>
                      {st.detail && <span className="block text-[11px] text-slate-400 truncate">{st.detail}</span>}
                    </span>
                    <span className={`text-xs font-semibold tabular-nums ${STATE_TEXT[st.state]}`}>{tx(st.label)}</span>
                    {expandable && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
                    )}
                  </button>
                  {open && (
                    <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/40">
                      <StageBody stage={st.key} ov={ov} kase={openCase} policyId={policyId} locked={locked} canDecide={canDecide} run={run} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {openCase && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-slate-400">{openCase.cycle_label} · {tx("opened")} {fmtDate(openCase.created_at)}{openCase.source === "Sweep" ? ` · ${tx("by the renewal sweep")}` : ""}</p>
          {openCase.can.cancel && !readOnly && <button disabled={busy} className={btnDanger} onClick={() => setCancelOpen((v) => !v)}>{tx("Cancel renewal")}</button>}
        </div>
      )}
      {cancelOpen && openCase && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-4 space-y-2">
          <p className="text-xs text-red-700 font-semibold">
            {tx("Cancelling closes this renewal cycle.")}{" "}
            {openCase.payment && openCase.payment.amount_paid > 0 ? tx("Money has already been collected — the ledger row stays.") : tx("An unpaid instalment created for it is removed again.")}
          </p>
          <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} placeholder={tx("Reason (optional)")} className={inputCls} />
          <div className="flex gap-2">
            <button disabled={locked} className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
              onClick={() => run(() => cancelRenewal(policyId, openCase.id, { reason: cancelReason || undefined }), tx("Renewal cancelled."))
                .then((ok) => { if (ok) { setCancelOpen(false); setCancelReason(""); } })}>{tx("Confirm cancellation")}</button>
            <button className={btnGhost} onClick={() => setCancelOpen(false)}>{tx("Keep renewal")}</button>
          </div>
        </div>
      )}

      {closedCase && (
        <div className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-xs text-slate-600">
          <b>{closedCase.renewal_no} · {tx(closedCase.status)}.</b> {closedCase.closed_reason}
        </div>
      )}

      {lastDone && <LastRenewal kase={lastDone} policyId={policyId} locked={locked} run={run} />}

      {kase && kase.timeline.length > 0 && <AuditTimeline items={kase.timeline} labels={EVENT_LABEL} />}

      {ov.history.length > 1 && (
        <div className="rounded-xl border border-slate-200 bg-white">
          <p className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">{tx("Renewal history")}</p>
          <div className="divide-y divide-slate-100">
            {ov.history.map((h) => (
              <div key={h.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-2.5 text-xs">
                <span className="font-mono font-semibold text-slate-700">{h.renewal_no}</span>
                <span className="text-slate-500 truncate">{h.renewal_type === "ContractRenewal" ? tx("Contract renewal") : tx("Premium renewal")} · {tx("due")} {fmtDate(h.due_date)}</span>
                <span className="tabular-nums text-slate-600">{fmtPKR(h.quoted_amount)}</span>
                <Chip cls={h.status === "Completed" ? "bg-blue-50 text-blue-700 border-blue-200" : h.status === "Declined" || h.status === "Cancelled" ? "bg-slate-100 text-slate-600 border-slate-300" : "bg-amber-50 text-amber-700 border-amber-200"}>{tx(h.status)}</Chip>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Last completed renewal (confirmation actions live here once the case closes) ──

type Run = (fn: () => Promise<unknown>, success: string, syncPage?: boolean) => Promise<boolean>;

function LastRenewal({ kase, policyId, locked, run }: Readonly<{ kase: RenewalCase; policyId: string; locked: boolean; run: Run }>) {
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-blue-900">{tx("Last renewal")} · {kase.renewal_no}</p>
        <Chip cls="bg-blue-100 text-blue-800 border-blue-300">{tx(kase.renewal_type_label)} {tx("completed")}</Chip>
      </div>
      <div className="grid sm:grid-cols-4 gap-4">
        <KV label={tx("Premium collected")} value={kase.payment ? fmtPKR(kase.payment.amount_paid) : "—"} />
        <KV label={tx("Completed")} value={fmtDateTime(kase.completion.completed_at)} />
        <KV label={kase.renewal_type === "ContractRenewal" ? tx("Renewed until") : tx("Policy status")}
          value={kase.renewal_type === "ContractRenewal" ? fmtDate(kase.period_end) : tx("Continues unchanged")} />
        <KV label={tx("Next premium due")} value={fmtDate(kase.completion.next_due_date)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={renewalConfirmationUrl(policyId, kase.id)} target="_blank" rel="noreferrer"
          className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white">{tx("Download confirmation (PDF)")}</a>
        <button disabled={locked} className={btnGhost}
          onClick={() => run(async () => {
            const r = await sendRenewalConfirmation(policyId, kase.id);
            if (!r.delivered) throw new Error(tx("The email could not be delivered (mail provider not configured or rejected it)."));
          }, tx("Confirmation emailed to the customer."))}>{tx("Email to customer")}</button>
        {kase.confirmation.sent_at && <span className="text-[11px] text-slate-500 self-center">{tx("Sent")} {fmtDateTime(kase.confirmation.sent_at)} · {kase.confirmation.sent_to}</span>}
      </div>
    </div>
  );
}

// ── Stage bodies ─────────────────────────────────────────────────────────────

function StageBody({
  stage, ov, kase, policyId, locked, canDecide, run,
}: Readonly<{ stage: RenewalStage["key"]; ov: RenewalOverview; kase: RenewalCase | null; policyId: string; locked: boolean; canDecide: boolean; run: Run }>) {
  if (stage === "eligibility") {
    const checks = kase?.eligibility?.checks ?? ov.eligibility.checks;
    return checks.length ? <CheckList checks={checks} /> : <p className="text-xs text-slate-500">{ov.eligibility.message}</p>;
  }
  if (!kase) return null;
  switch (stage) {
    case "notice": return <NoticeStage ov={ov} kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "risk": return <RiskStage kase={kase} policyId={policyId} locked={locked} canDecide={canDecide} run={run} />;
    case "acceptance": return <AcceptanceStage ov={ov} kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "collection": return <CollectionStage kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "reconciliation": return <ReconciliationStage kase={kase} policyId={policyId} locked={locked} run={run} />;
    default: return <ConfirmationStage kase={kase} policyId={policyId} locked={locked} run={run} />;
  }
}

function QuoteSummary({ kase }: Readonly<{ kase: RenewalCase }>) {
  const q = kase.quote;
  if (!q) return null;
  const contract = kase.renewal_type === "ContractRenewal";
  return (
    <div className="grid sm:grid-cols-4 gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
      <KV label={contract ? tx("Current annual premium") : tx("Annual premium")} value={fmtPKR(q.current_annual)} />
      {contract && <KV label={tx("Renewed annual premium")} value={<span>{fmtPKR(q.new_annual)}{q.change_pct != null && q.change_pct !== 0 ? <span className="text-[11px] text-slate-500"> ({q.change_pct > 0 ? "+" : ""}{q.change_pct}%)</span> : null}</span>} />}
      {q.loading_pct > 0 && <KV label={tx("Underwriting loading")} value={`${q.loading_pct}% (+${fmtPKR(q.additional_annual)}${tx("/yr")})`} />}
      <KV label={`${tx(q.frequency)} ${tx("instalment")}`} value={fmtPKR(q.instalment)} />
      {contract && <KV label={tx("Renewed period")} value={`${fmtDate(q.period_start)} → ${fmtDate(q.period_end)}`} />}
    </div>
  );
}

function NoticeStage({ ov, kase, policyId, locked, run }: Readonly<{ ov: RenewalOverview; kase: RenewalCase; policyId: string; locked: boolean; run: Run }>) {
  const [channel, setChannel] = useState(ov.options.channels[0] ?? "Email");
  return (
    <div className="space-y-3">
      <QuoteSummary kase={kase} />
      <p className="text-xs text-slate-600">
        {kase.notice.sent_at
          ? <>{tx("Last sent")} <b>{fmtDateTime(kase.notice.sent_at)}</b> {tx("by")} {kase.notice.channel} · {kase.notice.count} {tx("sent in total")}
            {kase.notice.delivered === false && <span className="text-amber-600"> · {tx("the channel did not deliver it")}</span>}</>
          : tx("No notice has been sent. Adamjee issues the notice and an SMS reminder one month before the premium is due.")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className={`${inputCls} !w-auto`}>
          {ov.options.channels.map((c) => <option key={c} value={c}>{tx(c)}</option>)}
        </select>
        <button disabled={locked || !kase.can.notice} className={btnPrimary}
          onClick={() => run(() => sendRenewalNotice(policyId, kase.id, { channel }), tx("Renewal notice issued."))}>
          {kase.notice.sent_at ? tx("Send again") : tx("Generate & send notice")}
        </button>
        <a href={renewalNoticeUrl(policyId, kase.id)} target="_blank" rel="noreferrer" className={btnGhost}>{tx("Preview PDF")}</a>
      </div>
    </div>
  );
}

function RiskStage({ kase, policyId, locked, canDecide, run }: Readonly<{ kase: RenewalCase; policyId: string; locked: boolean; canDecide: boolean; run: Run }>) {
  const [decision, setDecision] = useState<"Approve" | "ApproveWithLoading" | "Decline">("Approve");
  const [loading, setLoading] = useState("");
  const [notes, setNotes] = useState("");
  const r = kase.risk;
  const reasons = r.detail?.reasons ?? [];
  const blocker = decision !== "Approve" && !notes.trim() ? tx("Notes are required for this decision.")
    : decision === "ApproveWithLoading" && !(Number(loading) > 0) ? tx("Enter a loading percentage.") : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Chip cls={r.outcome === "Referred" ? "bg-amber-50 text-amber-700 border-amber-200"
          : r.outcome === "Declined" ? "bg-red-50 text-red-700 border-red-200" : "bg-blue-50 text-blue-700 border-blue-200"}>
          {r.outcome === "STP" ? tx("Straight-through") : tx(r.outcome ?? "—")}
        </Chip>
        <p className="text-xs text-slate-600 flex-1 min-w-[200px]">
          {r.outcome === "STP" ? tx("The renewal passes the straight-through rules — no underwriter is needed.") : r.outcome === "Referred" ? tx("Referred to underwriting:") : ""}
        </p>
        {kase.is_open && !r.decided_at && <button disabled={locked} className={btnGhost}
          onClick={() => run(() => reevaluateRenewalRisk(policyId, kase.id), tx("Risk re-evaluated."))}>{tx("Re-evaluate")}</button>}
      </div>
      {reasons.length > 0 && (
        <ul className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
          {reasons.map((x) => <li key={x} className="px-3 py-2 text-xs text-slate-700">{x}</li>)}
        </ul>
      )}
      {r.decided_at && (
        <p className="text-xs text-slate-600">{tx("Decision by")} <b>{r.decided_by}</b> · {fmtDateTime(r.decided_at)}{r.notes ? ` — ${r.notes}` : ""}{r.loading_pct > 0 ? ` · ${r.loading_pct}% ${tx("loading")}` : ""}</p>
      )}
      {kase.can.risk_decide && (canDecide ? (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Underwriting decision")}</p>
          <div className="flex flex-wrap gap-2">
            {([["Approve", "Approve"], ["ApproveWithLoading", "Approve with loading"], ["Decline", "Decline"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setDecision(v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${decision === v ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{tx(l)}</button>
            ))}
          </div>
          {decision === "ApproveWithLoading" && (
            <input type="number" min={0} value={loading} onChange={(e) => setLoading(e.target.value)} placeholder={tx("Loading on the renewed premium (%)")} className={inputCls} />
          )}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls}
            placeholder={decision === "Approve" ? tx("Notes (optional)") : tx("Notes (required)")} />
          <div className="flex items-center gap-3">
            <button disabled={locked || !!blocker} className={decision === "Decline" ? "px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40" : btnPrimary}
              onClick={() => run(() => decideRenewalRisk(policyId, kase.id, { decision, notes: notes.trim() || undefined, loading_pct: decision === "ApproveWithLoading" ? Number(loading) : undefined }),
                tx("Underwriting decision recorded."))}>{tx("Record decision")}</button>
            {blocker && <p className="text-[11px] text-amber-600">{blocker}</p>}
          </div>
        </div>
      ) : <p className="text-xs text-slate-500">{tx("Only an Underwriter or Admin can decide a referred renewal.")}</p>)}
    </div>
  );
}

function AcceptanceStage({ ov, kase, policyId, locked, run }: Readonly<{ ov: RenewalOverview; kase: RenewalCase; policyId: string; locked: boolean; run: Run }>) {
  const [method, setMethod] = useState(kase.acceptance.methods[0] ?? "Portal");
  const [by, setBy] = useState(ov.policy.customer_name ?? "");
  const a = kase.acceptance;
  return (
    <div className="space-y-3">
      <QuoteSummary kase={kase} />
      {a.accepted_at ? (
        <p className="text-xs text-slate-600">{tx("Accepted by")} <b>{a.accepted_by}</b> {tx("via")} {a.method} · {fmtDateTime(a.accepted_at)}</p>
      ) : (
        <>
          <p className="text-xs text-slate-600">{kase.risk.loading_pct > 0
            ? tx("The terms were revised by underwriting — the customer must consent to them before the premium is collected.")
            : tx("The renewed contract terms need the customer's consent before the premium is collected.")}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={by} onChange={(e) => setBy(e.target.value)} placeholder={tx("Accepted by")} className={inputCls} />
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
              {a.methods.map((m) => <option key={m} value={m}>{tx(m)}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button disabled={locked || !kase.can.accept || !by.trim()} className={btnPrimary}
              onClick={() => run(() => captureRenewalAcceptance(policyId, kase.id, { accepted: true, accepted_by: by.trim(), method }), tx("Renewed terms accepted."))}>{tx("Customer accepts")}</button>
            <button disabled={locked || !kase.can.accept} className={btnDanger}
              onClick={() => { if (confirm(tx("Declining the renewed terms closes this renewal. Continue?"))) run(() => captureRenewalAcceptance(policyId, kase.id, { accepted: false, accepted_by: by.trim() || undefined, method }), tx("Renewed terms declined — renewal closed.")); }}>{tx("Customer declines")}</button>
          </div>
          {!kase.can.accept && <p className="text-[11px] text-slate-400">{tx("Available once underwriting has cleared the renewal.")}</p>}
        </>
      )}
    </div>
  );
}

function CollectionStage({ kase, policyId, locked, run }: Readonly<{ kase: RenewalCase; policyId: string; locked: boolean; run: Run }>) {
  const [channel, setChannel] = useState(PAY_CHANNELS[0]);
  const [reference, setReference] = useState("");
  const p = kase.payment;
  const manual = channel.startsWith("Manual");
  if (!p) {
    return <p className="text-xs text-slate-500">{kase.acceptance.required && !kase.acceptance.accepted_at
      ? tx("Collection opens once the customer accepts the renewed terms — the instalment is added to the premium ledger at that point.")
      : tx("The instalment will be added to the premium ledger when collection opens.")}</p>;
  }
  const paid = p.status === "Paid";
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-4 gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <KV label={tx("Instalment")} value={`#${p.installment_no} · ${fmtDate(p.due_date)}`} />
        <KV label={tx("Amount due")} value={fmtPKR(p.amount_due)} />
        <KV label={paid ? tx("Collected") : tx("Payable now")} value={<span className="tabular-nums font-semibold">{fmtPKR(paid ? p.amount_paid : p.payable)}</span>} />
        <KV label={tx("Status")} value={tx(p.status)} />
        {!paid && p.surcharge > 0 && <p className="sm:col-span-4 text-[11px] text-amber-600">{tx("Includes a")} {fmtPKR(p.surcharge)} {tx("late-payment surcharge — the instalment is past its due date.")}</p>}
        {paid && <p className="sm:col-span-4 text-[11px] text-slate-500">{tx("Reference")} <span className="font-mono">{p.payment_reference}</span> · {p.receipts.map((r) => r.receipt_no).join(", ")} · {fmtDateTime(p.paid_at)}</p>}
      </div>
      {!paid && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
          <p className="text-xs text-slate-600">{tx("Collected through the same path as Premium Collection (Step 3) — the receipt, commission accrual and ledger update are identical.")}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputCls}>
              {PAY_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {manual && <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={tx("Receipt / reference no.")} className={inputCls} />}
          </div>
          <button disabled={locked || !kase.can.pay} className={btnPrimary}
            onClick={() => run(() => payRenewal(policyId, kase.id, manual ? { manual: true, reference: reference || undefined } : { method: channel }), tx("Premium collected."), true)}>
            {tx("Collect")} {fmtPKR(p.payable)}
          </button>
          {!kase.can.pay && <p className="text-[11px] text-slate-400">{tx("Collection opens once risk is cleared and any renewed terms are accepted.")}</p>}
        </div>
      )}
    </div>
  );
}

function ReconciliationStage({ kase, policyId, locked, run }: Readonly<{ kase: RenewalCase; policyId: string; locked: boolean; run: Run }>) {
  const [note, setNote] = useState("");
  const rec = kase.reconciliation;
  const res = rec.result;
  const exception = res?.status === "Exception" && !rec.reconciled_at;
  if (!kase.payment || kase.payment.status !== "Paid") {
    return <p className="text-xs text-slate-500">{tx("Reconciliation starts once the premium has been collected.")}</p>;
  }
  return (
    <div className="space-y-3">
      {res && (
        <>
          <div className="grid sm:grid-cols-4 gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
            <KV label={tx("Expected")} value={fmtPKR(res.expected)} />
            <KV label={tx("Received (base)")} value={fmtPKR(res.expected + res.variance)} />
            <KV label={tx("Late surcharge")} value={fmtPKR(res.surcharge)} />
            <KV label={tx("Variance")} value={<span className={Math.abs(res.variance) >= 0.01 ? "text-red-600" : ""}>{fmtPKR(res.variance)}</span>} />
          </div>
          <CheckList checks={res.checks} />
        </>
      )}
      {rec.reconciled_at ? (
        <p className="text-xs text-slate-600">{res?.status === "Matched" ? tx("Reconciled") : tx("Signed off with an exception")} · {rec.reconciled_by} · {fmtDateTime(rec.reconciled_at)}{rec.note ? ` — ${rec.note}` : ""}</p>
      ) : (
        <div className="space-y-2">
          {exception && (
            <>
              <p className="text-xs text-red-600">{tx("A blocking check failed. Resolve it, or sign the exception off with a note.")}</p>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inputCls} placeholder={tx("Note explaining the exception")} />
            </>
          )}
          <button disabled={locked || !kase.can.reconcile || (exception && !note.trim())} className={btnPrimary}
            onClick={() => run(() => reconcileRenewal(policyId, kase.id, { note: note.trim() || undefined }),
              exception ? tx("Exception signed off.") : tx("Payment reconciliation run."))}>
            {exception ? tx("Reconcile with exception") : res ? tx("Re-run reconciliation") : tx("Reconcile payment")}
          </button>
        </div>
      )}
    </div>
  );
}

function ConfirmationStage({ kase, policyId, locked, run }: Readonly<{ kase: RenewalCase; policyId: string; locked: boolean; run: Run }>) {
  const contract = kase.renewal_type === "ContractRenewal";
  const unmet = [
    !kase.payment || kase.payment.status !== "Paid" ? tx("collected premium") : null,
    !kase.reconciliation.reconciled_at ? tx("payment reconciliation") : null,
  ].filter(Boolean);
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        {contract
          ? tx("Completing binds the renewed contract: a new policy version, a renewal transaction, and the renewed period — then issues the confirmation.")
          : tx("Completing records the renewal and the next due date. The contract is unchanged — this is a premium, not a new contract — then issues the confirmation.")}
      </p>
      <button disabled={locked || !kase.can.complete} className={btnPrimary}
        onClick={() => { if (confirm(contract ? tx("Bind the renewed contract now?") : tx("Complete this premium renewal?"))) run(() => completeRenewal(policyId, kase.id), contract ? tx("Contract renewed.") : tx("Premium renewal completed."), true); }}>
        {contract ? tx("Complete & bind renewal") : tx("Complete renewal")}
      </button>
      {!kase.can.complete && unmet.length > 0 && <p className="text-[11px] text-slate-400">{tx("Outstanding:")} {unmet.join(", ")}</p>}
    </div>
  );
}
