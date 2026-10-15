"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { fmtPKR } from "@/app/services/policies";
import {
  getExitOverview, openExit, recordPolicyLoan, reverifyExit, decideExitExtension, uploadExitDocument, waiveExitDocument,
  exitDocumentUrl, recordExitConsent, calculateExitSettlement, exitStatementUrl, acceptExitSettlement, verifyExitPayee,
  authorizeExitPayment, disburseExitPayment, reconcileExitPayment, closeExit, cancelExit, exitLetterUrl, sendExitLetter,
  type ExitOverview, type ExitCaseView, type ExitSettlement, type ExitStage,
} from "@/app/services/postIssuance";
import {
  AuditTimeline, btnDanger, btnGhost, btnPrimary, CheckList, Chip, fmtDate, fmtDateTime, inputCls, KV, Stat, StageDot, TRACKER_TEXT,
} from "@/components/policy/panelKit";
import { tx } from "@/lib/i18n/tx";

// ─────────────────────────────────────────────────────────────────────────────
// Stage B · Step 9 — Policy Maturity & Exit: the end of a policy's life. Maturity with a
// benefit, expiry without one, early surrender and corporate coverage expiry — plus the
// closure that follows a paid death claim (the benefit itself is Claims Management's).
// The seven steps mirror services/exit_engine.project_stages. An extension is a Renewals
// matter: while a contract renewal is open the policy is never closed here.
// ─────────────────────────────────────────────────────────────────────────────

const PROCESS_ROLES = ["ClaimsAdjuster", "ClaimsManager", "Admin", "SuperAdmin", "Underwriter"];
const MANAGER_ROLES = ["ClaimsManager", "Admin", "SuperAdmin"];

const FINAL_TONE: Record<string, string> = {
  Matured: "bg-blue-100 text-blue-800 border-blue-300", Surrendered: "bg-slate-100 text-slate-700 border-slate-300", Expired: "bg-slate-100 text-slate-700 border-slate-300",
};
const TIMING_TONE: Record<string, { label: string; cls: string }> = {
  Upcoming: { label: "Upcoming", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  InWindow: { label: "Maturity window open", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  Reached: { label: "Term reached", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  Unknown: { label: "No end date", cls: "bg-slate-50 text-slate-500 border-slate-200" },
};
const EVENT_LABEL: Record<string, string> = {
  ExitOpened: "Exit opened", SurrenderRequested: "Surrender requested", ExitEligibilityVerified: "Eligibility verified",
  ExitExtensionDeclined: "Extension declined", ExitRedirectedToRenewals: "Sent to Renewals", ExitDocumentReceived: "Document received",
  ExitDocumentWaived: "Document waived", ExitConsentRecorded: "Consent recorded", ExitSettlementCalculated: "Settlement calculated",
  ExitSettlementAccepted: "Settlement accepted", ExitSettlementDeclined: "Settlement declined", ExitPayeeVerified: "Payee verified",
  ExitPaymentAuthorized: "Payment authorised", ExitPaymentMade: "Payment made", ExitReconciled: "Payment reconciled",
  ExitReconciliationException: "Reconciliation exception", PolicyMatured: "Policy matured", PolicySurrendered: "Policy surrendered",
  PolicyExpired: "Policy expired", PolicyClosureArchived: "Closure archived", ExitClosed: "Exit closed", ExitCancelled: "Exit withdrawn",
  ExitLetterSent: "Letter sent",
};

type Run = (fn: () => Promise<unknown>, success: string) => Promise<boolean>;

// ─────────────────────────────────────────────────────────────────────────────

export default function ExitPanel({
  policyId, onChanged, onOpenRenewals, onOpenReinstatement,
}: Readonly<{ policyId: string; onChanged: () => Promise<void>; onOpenRenewals?: () => void; onOpenReinstatement?: () => void }>) {
  const { notify } = useNotify();
  const [ov, setOv] = useState<ExitOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);

  useEffect(() => { if (typeof window !== "undefined") setRole(localStorage.getItem("user_role")); }, []);

  const load = useCallback(async () => {
    try { setOv(await getExitOverview(policyId)); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? e?.message ?? tx("Failed to load the exit data.")); }
  }, [policyId]);
  useEffect(() => { load(); }, [load]);

  const canWork = !!role && PROCESS_ROLES.includes(role);
  const isManager = !!role && MANAGER_ROLES.includes(role);
  const kase = ov?.case ?? null;
  const openCase = kase?.case.is_open ? kase : null;
  const currentKey = openCase?.stages.find((s) => !["complete", "skipped"].includes(s.state))?.key ?? null;
  useEffect(() => { if (currentKey) setOpenStep(currentKey); }, [currentKey, openCase?.case.id]);

  const run: Run = async (fn, success) => {
    setBusy(true); setErr(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "profile" in (res as object) && "policy" in (res as object)) setOv(res as ExitOverview);
      else await load();
      await onChanged();           // the policy header changes when the policy is closed
      notify(success, true);
      return true;
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setErr(typeof detail === "string" ? detail : e?.message ?? tx("Action failed."));
      await load();
      return false;
    } finally { setBusy(false); }
  };

  if (!ov) {
    return err
      ? <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>
      : <p className="text-xs text-slate-400 italic">{tx("Loading maturity & exit data…")}</p>;
  }
  const locked = busy || !canWork;
  const p = ov.policy;
  const nat = ov.natural;
  const mat = ov.indicative?.maturity ?? null;
  const loansTotal = ov.loans.reduce((a, l) => a + l.balance, 0);
  const completed = kase && kase.case.status === "Completed" ? kase : null;

  return (
    <div className="space-y-4">
      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 flex justify-between gap-3">
          <span>{err}</span><button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">×</button>
        </div>
      )}
      {!canWork && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          {tx("🔒 Exit actions need a servicing role — you can view this policy's maturity and exit status.")}
        </div>
      )}

      {/* Headline numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={tx("Policy status")} value={p.status} tone={ov.closed ? undefined : p.status === "Lapsed" ? "bad" : undefined}
          hint={`${p.product_name} · ${tx(ov.profile === "Savings" ? "savings / investment" : ov.profile === "Group" ? "group certificate" : "protection only")}`} />
        <Stat label={ov.profile === "Group" ? tx("Master policy ends") : tx("Term ends")}
          value={fmtDate(ov.profile === "Group" ? ov.group_scheme?.master_expiry : p.maturity_date)}
          hint={nat?.timing.days_until != null ? (nat.timing.days_until > 0 ? `${nat.timing.days_until} ${tx("day(s) away")}` : `${Math.abs(nat.timing.days_until)} ${tx("day(s) ago")}`) : `${p.completed_years} ${tx("completed year(s)")}`} />
        <Stat label={tx("Maturity proceeds (indicative)")} tone="accent"
          value={mat ? fmtPKR(mat.net) : ov.profile === "Savings" ? "—" : tx("No benefit")}
          hint={mat ? `${tx("fund")} ${fmtPKR(mat.gross)} − ${tx("deductions")} ${fmtPKR(mat.total_deductions)}` : tx("This product pays nothing at the end of its term")} />
        <Stat label={tx("Outstanding loans")} value={fmtPKR(loansTotal)} tone={loansTotal > 0 ? "warn" : undefined}
          hint={loansTotal > 0 ? tx("recovered from any proceeds") : tx("none recorded")} />
      </div>

      {ov.outlook && <OutlookCard o={ov.outlook} />}

      {/* A closed policy */}
      {ov.closed && (
        <div className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-slate-800">{tx("This policy is")} {p.status.toLowerCase()}</p>
            <p className="text-xs text-slate-600 mt-0.5">{tx("The policy has reached its final state. Its record is archived and no further billing or claims apply after the cover end date.")}</p>
          </div>
          <Chip cls={FINAL_TONE[p.status] ?? FINAL_TONE.Expired}>{tx(p.status)}</Chip>
        </div>
      )}

      {/* Closed by a paid death claim */}
      {ov.claim_closure && !ov.closed && !openCase && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 space-y-2">
          <p className="text-sm font-bold text-slate-800">{tx("The policy ended with a paid death claim")}</p>
          <p className="text-xs text-slate-600">{tx("Claim")} <span className="font-mono">{ov.claim_closure.claim_no}</span> {tx("settled")} {fmtPKR(Number(ov.claim_closure.benefit_paid ?? 0))} {tx("on")} {fmtDate(ov.claim_closure.at)}. {tx("The benefit was settled in Claims Management; here the closure is confirmed and archived.")}</p>
          {nat?.exit_type === "DeathClaimClosure" && nat.eligibility.status !== "Ineligible" && (
            <button disabled={locked} className={btnPrimary} onClick={() => run(() => openExit(policyId, {}), tx("Closure opened."))}>{tx("Confirm closure & archive")}</button>
          )}
        </div>
      )}

      {/* No open exit: the natural end, surrender, loans */}
      {!openCase && !ov.closed && !(ov.claim_closure) && nat && (
        <NaturalCard ov={ov} locked={locked} onOpen={() => run(() => openExit(policyId, {}), tx("Exit opened."))} onOpenReinstatement={onOpenReinstatement} onOpenRenewals={onOpenRenewals} />
      )}
      {!openCase && !ov.closed && ov.profile === "Savings" && !ov.claim_closure && (
        <SurrenderCard ov={ov} locked={locked} onRequest={(b) => run(() => openExit(policyId, { exit_type: "Surrender", ...b }), tx("Surrender requested."))} />
      )}
      {!ov.closed && !openCase && ov.profile === "Savings" && (
        <LoansCard ov={ov} policyId={policyId} locked={locked || !isManager} isManager={isManager} run={run} />
      )}

      {/* The seven steps */}
      {openCase && (
        <Workspace ov={ov} kase={openCase} policyId={policyId} locked={locked} isManager={isManager} openStep={openStep} setOpenStep={setOpenStep}
          run={run} onOpenRenewals={onOpenRenewals} />
      )}

      {completed && <ClosedCase kase={completed} policyId={policyId} locked={locked} run={run} />}
      {!openCase && kase && ["Declined", "Cancelled"].includes(kase.case.status) && (
        <div className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-xs text-slate-600">
          <b>{kase.case.exit_no} · {tx(kase.case.status)}.</b> {kase.case.closed_reason}
        </div>
      )}
      {kase && !openCase && kase.timeline.length > 0 && <AuditTimeline items={kase.timeline} labels={EVENT_LABEL} />}

      {ov.history.length > 1 && (
        <div className="rounded-xl border border-slate-200 bg-white">
          <p className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">{tx("Exit history")}</p>
          <div className="divide-y divide-slate-100">
            {ov.history.map((h) => (
              <div key={h.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-2.5 text-xs">
                <span className="font-mono font-semibold text-slate-700">{h.exit_no}</span>
                <span className="text-slate-500 truncate">{h.exit_type} · {fmtDate(h.created_at)}{h.closed_reason ? ` · ${h.closed_reason}` : ""}</span>
                <span className="tabular-nums text-slate-600">{h.net_payable > 0 ? fmtPKR(h.net_payable) : "—"}</span>
                <Chip cls={h.status === "Completed" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-100 text-slate-600 border-slate-300"}>{tx(h.status)}</Chip>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Before a case: the policy's natural end ──────────────────────────────────

function NaturalCard({
  ov, locked, onOpen, onOpenReinstatement, onOpenRenewals,
}: Readonly<{ ov: ExitOverview; locked: boolean; onOpen: () => void; onOpenReinstatement?: () => void; onOpenRenewals?: () => void }>) {
  const n = ov.natural!;
  const tone = TIMING_TONE[n.timing.state];
  const blocked = n.eligibility.status === "Ineligible";
  const lapsed = ov.policy.status === "Lapsed" && ov.profile === "Savings";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-slate-800">{tx(n.label)}</p>
          <p className="text-[11px] text-slate-400">{n.term_ends ? `${tx("Term ends")} ${fmtDate(n.term_ends)}` : tx("No end date on record")}</p>
        </div>
        <Chip cls={tone.cls}>{tx(tone.label)}</Chip>
      </div>
      <CheckList checks={n.eligibility.checks} />
      {n.eligibility.status === "Ineligible" && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{n.eligibility.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={locked || !n.can_open || blocked} className={btnPrimary} onClick={onOpen}>
          {n.exit_type === "Maturity" ? tx("Open maturity") : n.exit_type === "Expiry" ? tx("Close expired policy") : n.exit_type === "CorporateExpiry" ? tx("Close group cover") : tx("Open exit")}
        </button>
        {!n.can_open && <p className="text-[11px] text-slate-400">{tx("This opens")} {ov.rules.maturity_window_days} {tx("days before the term ends. To leave earlier, request a surrender below.")}</p>}
        {lapsed && onOpenReinstatement && <button className={btnGhost} onClick={onOpenReinstatement}>{tx("Go to Reinstatement")}</button>}
        {ov.extension.open_renewal_no && onOpenRenewals && <button className={btnGhost} onClick={onOpenRenewals}>{tx("Go to Renewals")}</button>}
      </div>
    </div>
  );
}

function SettlementBreakdown({ s, compact }: Readonly<{ s: ExitSettlement; compact?: boolean }>) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white px-4 py-3 space-y-1.5 ${compact ? "" : "max-w-lg"}`}>
      {s.lines.map((l) => <Line key={l.label} k={l.label} v={`${l.amount < 0 ? "− " : ""}${fmtPKR(Math.abs(l.amount))}`} muted={l.amount < 0} />)}
      <Line k={tx("Gross value")} v={fmtPKR(s.gross)} />
      {s.deductions.map((d) => <Line key={d.label} k={`− ${d.label}`} v={fmtPKR(d.amount)} muted />)}
      {s.tax > 0 && <Line k={`− ${tx("Tax withheld")} (${s.tax_pct}%)`} v={fmtPKR(s.tax)} muted />}
      <div className="border-t border-slate-200 pt-1.5 mt-1.5"><Line k={tx("Net payable")} v={fmtPKR(s.net)} strong /></div>
      {s.shortfall > 0 && <p className="text-[11px] text-red-600">{tx("Deductions exceed the value by")} {fmtPKR(s.shortfall)} — {tx("nothing is payable.")}</p>}
      <p className="text-[11px] text-slate-400">{s.basis} · {tx("valued")} {fmtDate(s.valuation_date)} · {tx("premiums paid")} {fmtPKR(s.fund.premiums_paid)}</p>
    </div>
  );
}

function OutlookCard({ o }: Readonly<{ o: NonNullable<ExitOverview["outlook"]> }>) {
  const savings = o.profile === "Savings";
  const noClaim = o.no_claim.benefit;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div>
        <p className="text-sm font-bold text-slate-800">{tx("What this policy returns")}</p>
        <p className="text-[11px] text-slate-400">{tx("Premiums paid so far")} {fmtPKR(o.premiums_paid)} {tx("of")} {fmtPKR(o.premiums_scheduled)} {tx("scheduled over the term")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">{tx("If no claim is made")}</p>
          <p className="mt-1 text-xl font-extrabold text-emerald-700">{noClaim > 0 ? fmtPKR(noClaim) : tx("No return")}</p>
          <p className="mt-1 text-xs text-slate-600">{tx(o.no_claim.note)}</p>
          {savings && o.no_claim.fund != null && <p className="mt-1 text-[11px] text-slate-500">{tx("Includes growth of")} {fmtPKR(o.no_claim.growth ?? 0)}</p>}
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">{tx("If surrendered early")}</p>
          <p className="mt-1 text-xl font-extrabold text-amber-700">{o.surrender.benefit ? fmtPKR(o.surrender.benefit) : savings ? "—" : tx("No return")}</p>
          <p className="mt-1 text-xs text-slate-600">{tx(o.surrender.note)}</p>
        </div>
      </div>
      {o.schedule.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              {[tx("Year"), tx("Premiums paid"), tx("Fund value"), tx("Surrender %"), tx("Surrender value")].map((h) => <th key={h} className="px-3 py-2 text-start font-semibold">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {o.schedule.map((r) => (
                <tr key={r.year} className={r.reached ? "bg-blue-50/40" : ""}>
                  <td className="px-3 py-1.5 font-medium text-slate-700">{r.year}</td>
                  <td className="px-3 py-1.5 tabular-nums">{fmtPKR(r.premiums_paid)}</td>
                  <td className="px-3 py-1.5 tabular-nums">{fmtPKR(r.fund)}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.factor != null ? `${r.factor}%` : "—"}</td>
                  <td className="px-3 py-1.5 font-semibold tabular-nums text-slate-900">{fmtPKR(r.value)}</td>
                </tr>
              ))}
              <tr className="bg-emerald-50/50"><td className="px-3 py-1.5 font-medium text-slate-700">{o.term_years ?? tx("Term")} ({tx("maturity")})</td><td className="px-3 py-1.5 tabular-nums">{fmtPKR(o.premiums_scheduled)}</td><td className="px-3 py-1.5 tabular-nums">{fmtPKR(o.no_claim.fund ?? 0)}</td><td className="px-3 py-1.5">100%</td><td className="px-3 py-1.5 font-semibold tabular-nums text-emerald-700">{fmtPKR(noClaim)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] italic text-slate-400">{tx(o.projection_basis)}</p>
    </div>
  );
}

function Line({ k, v, strong, muted }: Readonly<{ k: string; v: string; strong?: boolean; muted?: boolean }>) {
  return <div className="flex justify-between gap-6 text-xs"><span className={strong ? "font-bold text-slate-800" : muted ? "text-slate-500" : "text-slate-600"}>{k}</span><span className={`tabular-nums ${strong ? "font-bold text-slate-900" : "text-slate-700"}`}>{v}</span></div>;
}

export function SurrenderCard({
  ov, locked, onRequest,
}: Readonly<{ ov: ExitOverview; locked: boolean; onRequest: (b: { reason: string; requested_by: string; relationship: string; channel: string }) => void }>) {
  const sv = ov.indicative?.surrender;
  const [f, setF] = useState({ reason: "", requested_by: ov.policy.customer_name ?? "", relationship: "Policyholder", channel: ov.options.channels[0] ?? "Branch" });
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-slate-800">{tx("Early surrender")}</p>
          <p className="text-[11px] text-slate-400">{tx("Needs")} {ov.rules.surrender_min_years} {tx("completed years; ends all cover permanently.")}</p>
        </div>
        {sv?.available && <Chip cls="bg-blue-50 text-blue-700 border-blue-200">{tx("Available")}</Chip>}
      </div>
      {sv?.available && sv.settlement ? (
        <>
          <p className="text-xs text-slate-600">{tx("If surrendered today the policyholder would receive")} <b>{fmtPKR(sv.settlement.net)}</b>:</p>
          <SettlementBreakdown s={sv.settlement} />
          {!show
            ? <button disabled={locked} className={btnGhost} onClick={() => setShow(true)}>{tx("Request surrender")}</button>
            : (
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <input value={f.requested_by} onChange={(e) => setF({ ...f, requested_by: e.target.value })} placeholder={tx("Requested by")} className={inputCls} />
                  <select value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} className={inputCls}>{ov.options.relationships.map((r) => <option key={r} value={r}>{tx(r)}</option>)}</select>
                  <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} className={inputCls}>{ov.options.channels.map((c) => <option key={c} value={c}>{tx(c)}</option>)}</select>
                  <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={tx("Reason for surrendering (required)")} className={inputCls} />
                </div>
                <div className="flex gap-2">
                  <button disabled={locked || !f.reason.trim() || !f.requested_by.trim()} className={btnPrimary} onClick={() => onRequest({ ...f, reason: f.reason.trim(), requested_by: f.requested_by.trim() })}>{tx("Start surrender")}</button>
                  <button className={btnGhost} onClick={() => setShow(false)}>{tx("Cancel")}</button>
                </div>
              </div>
            )}
        </>
      ) : <p className="text-xs text-slate-500">{sv?.reason ?? tx("Surrender is not available for this policy.")}</p>}
    </div>
  );
}

function LoansCard({ ov, policyId, locked, isManager, run }: Readonly<{ ov: ExitOverview; policyId: string; locked: boolean; isManager: boolean; run: Run }>) {
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ principal: "", annual_interest_pct: "", disbursed_on: "", reference: "" });
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-slate-800">{tx("Loans against the policy")}</p>
        {isManager && <button className={btnGhost} onClick={() => setShow((s) => !s)}>{tx("Record a loan")}</button>}
      </div>
      {ov.loans.length === 0 ? <p className="text-xs text-slate-500">{tx("No loan is recorded. Any loan is repaid from the proceeds when the policy leaves.")}</p> : (
        <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
          {ov.loans.map((l) => (
            <div key={l.id} className="grid grid-cols-[1fr_auto_auto] gap-4 px-3 py-2 text-xs">
              <span className="text-slate-700">{l.reference ?? tx("Loan")} · {fmtDate(l.disbursed_on)} · {l.annual_interest_pct}%</span>
              <span className="text-slate-500 tabular-nums">{fmtPKR(l.principal)} + {fmtPKR(l.interest)}</span>
              <span className="font-semibold tabular-nums text-slate-800">{fmtPKR(l.balance)}</span>
            </div>
          ))}
        </div>
      )}
      {show && isManager && (
        <div className="grid sm:grid-cols-5 gap-2">
          <input type="number" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} placeholder={tx("Principal (PKR)")} className={inputCls} />
          <input type="number" value={f.annual_interest_pct} onChange={(e) => setF({ ...f, annual_interest_pct: e.target.value })} placeholder={tx("Interest % p.a.")} className={inputCls} />
          <input type="date" value={f.disbursed_on} onChange={(e) => setF({ ...f, disbursed_on: e.target.value })} className={inputCls} />
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder={tx("Reference")} className={inputCls} />
          <button disabled={locked || !(Number(f.principal) > 0) || !f.disbursed_on} className={btnPrimary}
            onClick={() => run(() => recordPolicyLoan(policyId, { principal: Number(f.principal), annual_interest_pct: Number(f.annual_interest_pct || 0), disbursed_on: f.disbursed_on, reference: f.reference || undefined }), tx("Loan recorded."))
              .then((ok) => { if (ok) { setShow(false); setF({ principal: "", annual_interest_pct: "", disbursed_on: "", reference: "" }); } })}>{tx("Save")}</button>
        </div>
      )}
    </div>
  );
}

// ── The seven-step workspace ─────────────────────────────────────────────────

function Workspace({
  ov, kase, policyId, locked, isManager, openStep, setOpenStep, run, onOpenRenewals,
}: Readonly<{ ov: ExitOverview; kase: ExitCaseView; policyId: string; locked: boolean; isManager: boolean; openStep: string | null;
  setOpenStep: (k: string | null) => void; run: Run; onOpenRenewals?: () => void }>) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const c = kase.case;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold font-mono text-slate-700 bg-white px-2.5 py-1 rounded-md border border-slate-200">{c.exit_no}</span>
          <span className="text-sm font-semibold text-slate-800">{tx(c.exit_type_label)}</span>
          <Chip cls="bg-blue-50 text-blue-700 border-blue-200">{tx("In progress")}</Chip>
          {c.source === "Sweep" && <Chip cls="bg-slate-50 text-slate-600 border-slate-200">{tx("Opened by the sweep")}</Chip>}
        </div>
        {kase.can.cancel && <button disabled={locked} className={btnDanger} onClick={() => setCancelOpen((v) => !v)}>{tx("Withdraw")}</button>}
      </div>
      {cancelOpen && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-4 space-y-2">
          <p className="text-xs text-red-700 font-semibold">{tx("Withdrawing closes this exit. The policy carries on exactly as it was.")}</p>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder={tx("Reason (optional)")} />
          <div className="flex gap-2">
            <button disabled={locked} className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
              onClick={() => run(() => cancelExit(policyId, c.id, reason || undefined), tx("Exit withdrawn.")).then((ok) => { if (ok) setCancelOpen(false); })}>{tx("Confirm withdrawal")}</button>
            <button className={btnGhost} onClick={() => setCancelOpen(false)}>{tx("Keep exit")}</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {kase.stages.map((st) => {
          const isOpen = openStep === st.key;
          return (
            <div key={st.key} className={`rounded-xl border bg-white overflow-hidden ${["action", "pending"].includes(st.state) ? "border-amber-300" : st.state === "exception" ? "border-red-200" : "border-slate-200"}`}>
              <button onClick={() => setOpenStep(isOpen ? null : st.key)} aria-expanded={isOpen} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <StageDot state={st.state} n={st.n} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-bold ${["not_started", "skipped"].includes(st.state) ? "text-slate-500" : "text-slate-800"}`}>{tx(st.title)}</span>
                  {st.detail && <span className="block text-[11px] text-slate-400 truncate">{st.detail}</span>}
                </span>
                <span className={`text-xs font-semibold ${TRACKER_TEXT[st.state]}`}>{tx(st.label)}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/40">
                  <StepBody step={st.key} stage={st} ov={ov} kase={kase} policyId={policyId} locked={locked} isManager={isManager} run={run} onOpenRenewals={onOpenRenewals} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {kase.timeline.length > 0 && <AuditTimeline items={kase.timeline} labels={EVENT_LABEL} />}
    </div>
  );
}

function StepBody({
  step, stage, ov, kase, policyId, locked, isManager, run, onOpenRenewals,
}: Readonly<{ step: ExitStage["key"]; stage: ExitStage; ov: ExitOverview; kase: ExitCaseView; policyId: string; locked: boolean; isManager: boolean; run: Run; onOpenRenewals?: () => void }>) {
  if (stage.state === "skipped") return <p className="text-xs text-slate-500">{stage.detail || tx("Not applicable to this kind of exit.")}</p>;
  switch (step) {
    case "identify": return <IdentifyStep kase={kase} ov={ov} />;
    case "extension": return <ExtensionStep kase={kase} ov={ov} policyId={policyId} locked={locked} run={run} onOpenRenewals={onOpenRenewals} />;
    case "eligibility": return <EligibilityStep kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "documents": return <DocumentsStep kase={kase} policyId={policyId} locked={locked} isManager={isManager} run={run} />;
    case "settlement": return <SettlementStep kase={kase} policyId={policyId} locked={locked} run={run} />;
    case "disbursement": return <DisbursementStep kase={kase} ov={ov} policyId={policyId} locked={locked} isManager={isManager} run={run} />;
    default: return <ClosureStep kase={kase} policyId={policyId} locked={locked} run={run} />;
  }
}

function IdentifyStep({ kase, ov }: Readonly<{ kase: ExitCaseView; ov: ExitOverview }>) {
  const c = kase.case;
  return (
    <div className="grid sm:grid-cols-3 gap-4">
      <KV label={tx("Exit")} value={tx(c.exit_type_label)} />
      <KV label={tx("Term ends")} value={fmtDate(kase.timing.term_ends)} />
      <KV label={tx("Policy")} value={`${ov.policy.policy_number} · ${ov.policy.completed_years} ${tx("completed year(s)")}`} />
      {c.exit_type === "Surrender" && <>
        <KV label={tx("Requested by")} value={`${c.requested_by} (${c.requested_relationship})`} />
        <KV label={tx("Channel")} value={c.channel} />
        <KV label={tx("Reason")} value={c.reason} />
      </>}
      {c.exit_type === "DeathClaimClosure" && ov.claim_closure && <KV label={tx("Death claim")} value={`${ov.claim_closure.claim_no} · ${fmtPKR(Number(ov.claim_closure.benefit_paid ?? 0))}`} />}
      {ov.group_scheme?.master_number && <KV label={tx("Master policy")} value={`${ov.group_scheme.master_number} · ${tx("ends")} ${fmtDate(ov.group_scheme.master_expiry)}`} />}
    </div>
  );
}

function ExtensionStep({ kase, ov, policyId, locked, run, onOpenRenewals }: Readonly<{ kase: ExitCaseView; ov: ExitOverview; policyId: string; locked: boolean; run: Run; onOpenRenewals?: () => void }>) {
  const [note, setNote] = useState("");
  const e = kase.extension;
  return (
    <div className="space-y-3">
      {e.open_renewal_no && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 space-y-2">
          <p>{tx("Renewal")} <b className="font-mono">{e.open_renewal_no}</b> {tx("is open — an approved extension is being finalised under Renewals. The policy cannot be closed here until that is complete or cancelled.")}</p>
          {onOpenRenewals && <button className={btnGhost} onClick={onOpenRenewals}>{tx("Go to Renewals")}</button>}
        </div>
      )}
      {e.decision === "NotApplicable" && <p className="text-xs text-slate-600">{tx("This product has no extension option, so nothing needs to be decided. Extensions, where a product allows them, are completed under Renewals.")}</p>}
      {e.decision === "Declined" && <p className="text-xs text-slate-600">{tx("The policyholder declined an extension")}{e.decided_by ? ` — ${e.decided_by}` : ""} · {fmtDateTime(e.decided_at)}{e.note ? ` — ${e.note}` : ""}</p>}
      {kase.can.extension && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
          <p className="text-xs text-slate-600">{tx("The product permits an approved extension. Either the policyholder declines it and the exit goes ahead, or the case is sent to Renewals (Module 7), which owns every extension.")}</p>
          <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder={tx("Note")} className={inputCls} />
          <div className="flex gap-2">
            <button disabled={locked} className={btnPrimary} onClick={() => run(() => decideExitExtension(policyId, kase.case.id, { decision: "Declined", note: note || undefined }), tx("Extension declined — the exit continues."))}>{tx("Policyholder declines extension")}</button>
            <button disabled={locked || !note.trim()} className={btnGhost} onClick={() => run(() => decideExitExtension(policyId, kase.case.id, { decision: "Redirect", note: note.trim() }), tx("Sent to Renewals."))}>{tx("Send to Renewals")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function EligibilityStep({ kase, policyId, locked, run }: Readonly<{ kase: ExitCaseView; policyId: string; locked: boolean; run: Run }>) {
  const r = kase.eligibility.result;
  if (!r) return <p className="text-xs text-slate-500">{tx("Not verified yet.")}</p>;
  const tone = kase.eligibility.status === "Ineligible" ? "border-red-200 bg-red-50 text-red-800" : kase.eligibility.status === "Referred" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-blue-200 bg-blue-50 text-blue-800";
  return (
    <div className="space-y-3">
      <div className={`rounded-lg border px-3 py-2.5 text-xs ${tone}`}><b>{tx(kase.eligibility.status ?? "")}</b> — {r.message}</div>
      <CheckList checks={r.checks} />
      {r.financials && <>
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Financial position (indicative)")}</p>
        <SettlementBreakdown s={r.financials} />
      </>}
      {r.financials_error && <p className="text-xs text-amber-700">{r.financials_error}</p>}
      <p className="text-[11px] text-slate-400">{tx("Verified")} {fmtDateTime(kase.eligibility.verified_at)} · {kase.eligibility.verified_by}</p>
      {kase.can.verify && <button disabled={locked} className={btnGhost} onClick={() => run(() => reverifyExit(policyId, kase.case.id), tx("Eligibility re-verified."))}>{tx("Re-verify")}</button>}
    </div>
  );
}

function DocumentsStep({ kase, policyId, locked, isManager, run }: Readonly<{ kase: ExitCaseView; policyId: string; locked: boolean; isManager: boolean; run: Run }>) {
  const d = kase.documents;
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [waive, setWaive] = useState<Record<string, string>>({});
  const [by, setBy] = useState(kase.consent.state?.by ?? "");
  const [method, setMethod] = useState(kase.consent.state?.method ?? kase.consent.methods[0]);
  const [accepted, setAccepted] = useState<string[]>((kase.consent.state?.declarations ?? []).filter((x) => x.accepted).map((x) => x.key));
  const toggle = (k: string) => setAccepted((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-600"><b>{d.progress.received}</b> {tx("of")} <b>{d.progress.required}</b> {tx("required documents received.")}</p>
      <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
        {d.items.map((it) => {
          const done = it.status === "Received" || it.status === "Waived";
          return (
            <div key={it.key} className="px-3 py-2.5 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-semibold text-slate-700">{it.label}</p>
                <div className="flex gap-2"><Chip cls={it.required ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-50 text-slate-500 border-slate-200"}>{it.required ? tx("Required") : tx("If asked")}</Chip>
                  <Chip cls={it.status === "Received" ? "bg-blue-50 text-blue-700 border-blue-200" : it.status === "Waived" ? "bg-slate-100 text-slate-600 border-slate-300" : "bg-slate-50 text-slate-600 border-slate-200"}>{tx(it.status)}</Chip></div>
              </div>
              {it.status === "Received" && <p className="text-[11px] text-slate-500">{fmtDateTime(it.received_at)} · <a className="text-blue-600 hover:underline" target="_blank" rel="noreferrer" href={exitDocumentUrl(policyId, kase.case.id, it.key)}>{it.file_name}</a></p>}
              {it.status === "Waived" && <p className="text-[11px] text-slate-500">{it.note}</p>}
              {kase.can.documents && !done && !kase.settlement.accepted_at && (
                <div className="flex flex-wrap items-center gap-2">
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg,.tiff" onChange={(e) => setFiles({ ...files, [it.key]: e.target.files?.[0] ?? null })} className="text-[11px] text-slate-500 max-w-[220px]" />
                  <button disabled={locked || !files[it.key]} className={btnGhost} onClick={() => { const f = files[it.key]; if (f) run(() => uploadExitDocument(policyId, kase.case.id, it.key, f), tx("Document received.")); }}>{tx("Receive")}</button>
                  {isManager && <>
                    <input value={waive[it.key] ?? ""} onChange={(e) => setWaive({ ...waive, [it.key]: e.target.value })} placeholder={tx("Reason to waive")} className={`${inputCls} !w-44`} />
                    <button disabled={locked || (waive[it.key] ?? "").trim().length < 10} className={btnDanger} onClick={() => run(() => waiveExitDocument(policyId, kase.case.id, it.key, waive[it.key].trim()), tx("Document waived."))}>{tx("Waive")}</button>
                  </>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Policyholder's declarations")}</p>
        {kase.consent.declarations.map((dec) => (
          <label key={dec.key} className="flex items-start gap-2 text-xs text-slate-700">
            <input type="checkbox" className="mt-0.5" disabled={!kase.can.consent || !!kase.settlement.accepted_at} checked={accepted.includes(dec.key)} onChange={() => toggle(dec.key)} />
            {dec.text}
          </label>
        ))}
        {kase.consent.complete
          ? <p className="text-xs text-blue-700">{tx("Consent recorded by")} <b>{kase.consent.state?.by}</b> {tx("via")} {kase.consent.state?.method} · {fmtDateTime(kase.consent.at)}</p>
          : !kase.can.consent && <p className="text-[11px] text-slate-400">{tx("Consent is recorded once every required document is in.")}</p>}
        {kase.can.consent && !kase.settlement.accepted_at && (
          <div className="grid sm:grid-cols-3 gap-2">
            <input value={by} onChange={(e) => setBy(e.target.value)} placeholder={tx("Given by")} className={inputCls} />
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>{kase.consent.methods.map((m) => <option key={m} value={m}>{tx(m)}</option>)}</select>
            <button disabled={locked || !by.trim()} className={btnPrimary} onClick={() => run(() => recordExitConsent(policyId, kase.case.id, { accepted, by: by.trim(), method }), tx("Consent recorded."))}>{tx("Record consent")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function SettlementStep({ kase, policyId, locked, run }: Readonly<{ kase: ExitCaseView; policyId: string; locked: boolean; run: Run }>) {
  const [lines, setLines] = useState<{ label: string; amount: string; note: string }[]>([]);
  const [notes, setNotes] = useState("");
  const [by, setBy] = useState("");
  const [method, setMethod] = useState(kase.consent.methods[0]);
  const [why, setWhy] = useState("");
  const s = kase.settlement;
  return (
    <div className="space-y-3">
      {s.result && <SettlementBreakdown s={s.result} />}
      {s.result && (
        <p className="text-xs text-slate-600">
          {tx("Calculated by")} {s.calculated_by} · {fmtDateTime(s.calculated_at)} · {s.accepted_at ? tx("accepted") : s.quote_valid ? `${tx("valid until")} ${fmtDate(s.valid_until)}` : <b className="text-red-600">{tx("expired — recalculate")}</b>}
          {" · "}<a className="text-blue-600 hover:underline" target="_blank" rel="noreferrer" href={exitStatementUrl(policyId, kase.case.id)}>{tx("Statement for the customer (PDF)")}</a>
        </p>
      )}
      {kase.can.calculate && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
          <p className="text-xs text-slate-600">{tx("Value is worked out from the premiums paid; loans and unpaid premium are deducted automatically. Add any other recoverable amount below.")}</p>
          {lines.map((ln, i) => (
            <div key={i} className="flex gap-2">
              <input value={ln.label} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder={tx("Recoverable amount (e.g. overpaid bonus)")} className={inputCls} />
              <input type="number" min={0} value={ln.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="PKR" className={`${inputCls} !w-36`} />
              <button className="text-slate-300 hover:text-red-500 px-1" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className="text-[11px] text-blue-600 font-semibold" onClick={() => setLines([...lines, { label: "", amount: "", note: "" }])}>{tx("+ Add a recoverable amount")}</button>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tx("Notes")} className={inputCls} />
          <button disabled={locked} className={btnPrimary}
            onClick={() => run(() => calculateExitSettlement(policyId, kase.case.id, { recoverables: lines.filter((l) => l.label.trim() && Number(l.amount) > 0).map((l) => ({ label: l.label.trim(), amount: Number(l.amount) })), notes: notes || undefined }), tx("Settlement calculated."))}>
            {s.result ? tx("Recalculate") : tx("Calculate settlement")}</button>
        </div>
      )}
      {kase.can.accept && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-2">
          <p className="text-xs font-semibold text-blue-900">{tx("Present the figure to the policyholder")}</p>
          <div className="grid sm:grid-cols-2 gap-2">
            <input value={by} onChange={(e) => setBy(e.target.value)} placeholder={tx("Accepted by")} className={inputCls} />
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>{kase.consent.methods.map((m) => <option key={m} value={m}>{tx(m)}</option>)}</select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={locked || !by.trim() || !s.quote_valid} className={btnPrimary} onClick={() => run(() => acceptExitSettlement(policyId, kase.case.id, { accepted: true, by: by.trim(), method }), tx("Settlement accepted."))}>{tx("Policyholder accepts")}</button>
            <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder={tx("Reason if declined")} className={`${inputCls} !w-52`} />
            <button disabled={locked} className={btnDanger} onClick={() => { if (confirm(tx("Declining ends this exit and leaves the policy as it is. Continue?"))) run(() => acceptExitSettlement(policyId, kase.case.id, { accepted: false, note: why || undefined }), tx("Settlement declined — exit closed.")); }}>{tx("Policyholder declines")}</button>
          </div>
        </div>
      )}
      {!s.result && !kase.can.calculate && <p className="text-xs text-slate-400">{tx("The settlement can be calculated once the extension check is resolved and every document and declaration is in.")}</p>}
    </div>
  );
}

function DisbursementStep({ kase, ov, policyId, locked, isManager, run }: Readonly<{ kase: ExitCaseView; ov: ExitOverview; policyId: string; locked: boolean; isManager: boolean; run: Run }>) {
  const d = kase.disbursement;
  const payee = d.payee;
  const [f, setF] = useState({ cnic: payee?.cnic ?? ov.policy.customer_cnic ?? "", bank_name: payee?.bank_name ?? "", account_title: payee?.account_title ?? ov.policy.customer_name ?? "",
    iban: payee?.iban ?? "", method: payee?.method ?? "", note: payee?.note ?? "" });
  const [method, setMethod] = useState(d.methods[0]);
  const [note, setNote] = useState("");
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const net = kase.settlement.net;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">{tx("Net payable")} <b>{fmtPKR(net)}</b>. {tx("The only valid payee is the policyholder; payments above")} {fmtPKR(d.dual_control_limit)} {tx("need a second person to authorise.")}</p>
      {(kase.can.verify_payee || payee) && (
        <div className={`rounded-lg border bg-white p-3 space-y-3 ${d.payee_verified_at ? "border-blue-200" : "border-slate-200"}`}>
          <div className="flex items-center justify-between"><p className="text-sm font-bold text-slate-800">{ov.policy.customer_name}</p>
            <Chip cls={d.payee_verified_at ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-amber-50 text-amber-700 border-amber-200"}>{d.payee_verified_at ? tx("Verified") : tx("Unverified")}</Chip></div>
          {kase.can.verify_payee ? (
            <>
              <div className="grid sm:grid-cols-3 gap-2">
                <input value={f.cnic} onChange={(e) => set("cnic", e.target.value)} placeholder={tx("CNIC (13 digits)")} className={inputCls} />
                <input value={f.bank_name} onChange={(e) => set("bank_name", e.target.value)} placeholder={tx("Bank")} className={inputCls} />
                <input value={f.account_title} onChange={(e) => set("account_title", e.target.value)} placeholder={tx("Account title")} className={inputCls} />
                <input value={f.iban} onChange={(e) => set("iban", e.target.value)} placeholder="IBAN — PK00AAAA0000000000000000" className={`${inputCls} sm:col-span-2 font-mono`} />
                <input value={f.method} onChange={(e) => set("method", e.target.value)} placeholder={tx("How identity was verified")} className={inputCls} />
                <input value={f.note} onChange={(e) => set("note", e.target.value)} placeholder={tx("Note (needed if the account title differs)")} className={`${inputCls} sm:col-span-3`} />
              </div>
              <div className="flex gap-2">
                <button disabled={locked} className={btnGhost} onClick={() => run(() => verifyExitPayee(policyId, kase.case.id, { ...f, verify: false }), tx("Payee details saved."))}>{tx("Save & check")}</button>
                <button disabled={locked} className={btnPrimary} onClick={() => run(() => verifyExitPayee(policyId, kase.case.id, { ...f, verify: true }), tx("Payee verified."))}>{d.payee_verified_at ? tx("Re-verify") : tx("Verify payee")}</button>
              </div>
            </>
          ) : payee && <p className="text-[11px] text-slate-500">{payee.bank_name} · <span className="font-mono">{payee.iban}</span> · {payee.account_title}</p>}
          {payee && payee.checks.length > 0 && <CheckList checks={payee.checks} />}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {kase.can.authorize && <button disabled={locked || !isManager} className={btnPrimary} onClick={() => run(() => authorizeExitPayment(policyId, kase.case.id), tx("Payment authorised."))}>{tx("Authorise payment")} {fmtPKR(net)}</button>}
        {d.authorized_at && <p className="text-xs text-slate-600">{tx("Authorised by")} <b>{d.authorized_by}</b> · {fmtDateTime(d.authorized_at)}</p>}
        {kase.can.authorize && !isManager && <p className="text-[11px] text-slate-400">{tx("Only a manager can authorise.")}</p>}
        {kase.can.disburse && (<>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inputCls} !w-auto`}>{d.methods.map((m) => <option key={m} value={m}>{tx(m)}</option>)}</select>
          <button disabled={locked} className={btnPrimary} onClick={() => { if (confirm(tx("Pay the authorised amount now?"))) run(() => disburseExitPayment(policyId, kase.case.id, method), tx("Payment made.")); }}>{tx("Disburse")}</button>
        </>)}
        {d.authorized_at && !kase.can.disburse && !d.disbursed_at && kase.case.exit_type === "Maturity" && !kase.timing.term_reached && <p className="text-[11px] text-amber-600">{tx("Maturity proceeds are paid on or after")} {fmtDate(kase.timing.term_ends)}.</p>}
      </div>
      {d.payouts.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400"><th className="text-left font-semibold px-3 py-2">{tx("Payee")}</th><th className="text-left font-semibold px-3 py-2">{tx("Method")}</th><th className="text-left font-semibold px-3 py-2">{tx("Reference")}</th><th className="text-right font-semibold px-3 py-2">{tx("Amount")}</th></tr></thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">{d.payouts.map((p) => <tr key={p.reference}><td className="px-3 py-2">{p.payee_name}</td><td className="px-3 py-2">{p.method}</td><td className="px-3 py-2 font-mono">{p.reference}</td><td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtPKR(p.amount)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {d.reconciliation && <CheckList checks={d.reconciliation.checks} />}
      {d.reconciled_at
        ? <p className="text-xs text-slate-600">{tx("Reconciled by")} {d.reconciled_by} · {fmtDateTime(d.reconciled_at)}</p>
        : kase.can.reconcile && (
          <div className="space-y-2">
            {d.reconciliation?.status === "Exception" && <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder={tx("Note explaining the exception")} />}
            <button disabled={locked || (d.reconciliation?.status === "Exception" && !note.trim())} className={btnPrimary} onClick={() => run(() => reconcileExitPayment(policyId, kase.case.id, note.trim() || undefined), tx("Payment reconciled."))}>{tx("Reconcile payment")}</button>
          </div>
        )}
    </div>
  );
}

function ClosureStep({ kase, policyId, locked, run }: Readonly<{ kase: ExitCaseView; policyId: string; locked: boolean; run: Run }>) {
  const t = kase.case.exit_type;
  const text = t === "Maturity" ? tx("Closing ends the policy as Matured on its maturity date, stops all future billing, ends any riders and recovers loans from the proceeds, then issues the closure confirmation.")
    : t === "Surrender" ? tx("Closing ends the policy as Surrendered with effect from today, stops all future billing and ends any riders, then issues the closure confirmation. This cannot be undone.")
      : t === "DeathClaimClosure" ? tx("The policy was ended by the death claim. Closing issues the closure confirmation and archives the record.")
        : tx("Closing ends the policy as Expired on the day its term ends, stops future billing and ends any riders, then issues the closure confirmation.");
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">{text}</p>
      <div className="flex items-center gap-3 flex-wrap">
        <button disabled={locked || !kase.can.close} className={btnPrimary}
          onClick={() => { if (confirm(tx("Close this policy? This cannot be undone."))) run(() => closeExit(policyId, kase.case.id), tx("Policy closed.")); }}>{tx("Close policy & archive")}</button>
        {!kase.can.close && <p className="text-[11px] text-slate-400">
          {t !== "Surrender" && t !== "DeathClaimClosure" && !kase.timing.term_reached ? `${tx("The policy can be closed on or after")} ${fmtDate(kase.timing.term_ends)}.` : tx("Complete the earlier steps — payment must be reconciled and no claim or extension may be open.")}</p>}
      </div>
    </div>
  );
}

function ClosedCase({ kase, policyId, locked, run }: Readonly<{ kase: ExitCaseView; policyId: string; locked: boolean; run: Run }>) {
  const cu = kase.closure.coverage_update ?? {};
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-blue-900">{tx(kase.case.exit_type_label)} · {kase.case.exit_no}</p>
        <Chip cls={FINAL_TONE[String(cu.policy_status)] ?? "bg-slate-100 text-slate-700 border-slate-300"}>{tx(String(cu.policy_status ?? "Closed"))}</Chip>
      </div>
      <div className="grid sm:grid-cols-4 gap-4">
        <KV label={tx("Cover ended")} value={fmtDate(cu.coverage_ended)} />
        <KV label={tx("Benefit paid")} value={fmtPKR(Number(cu.benefit_paid ?? 0))} />
        <KV label={tx("Instalments cancelled")} value={String(cu.instalments_waived ?? 0)} />
        <KV label={tx("Closed")} value={`${fmtDateTime(kase.closure.closed_at)} · ${kase.closure.closed_by}`} />
      </div>
      {kase.disbursement.payouts.length > 0 && <p className="text-xs text-slate-600">{tx("Paid")} {fmtPKR(kase.disbursement.payouts[0].amount)} {tx("by")} {kase.disbursement.payouts[0].method} · <span className="font-mono">{kase.disbursement.payouts[0].reference}</span></p>}
      <div className="flex flex-wrap gap-2">
        <a href={exitLetterUrl(policyId, kase.case.id)} target="_blank" rel="noreferrer" className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white">{tx("Download closure confirmation (PDF)")}</a>
        <button disabled={locked} className={btnGhost} onClick={() => run(async () => {
          const r = await sendExitLetter(policyId, kase.case.id);
          if (!r.delivered) throw new Error(tx("The email could not be delivered (mail provider not configured or rejected it)."));
        }, tx("Closure confirmation emailed."))}>{tx("Email to policyholder")}</button>
        {kase.closure.confirmation.sent_at && <span className="text-[11px] text-slate-500 self-center">{tx("Sent")} {fmtDateTime(kase.closure.confirmation.sent_at)}</span>}
      </div>
      <AuditTimeline items={kase.timeline} labels={EVENT_LABEL} />
    </div>
  );
}
