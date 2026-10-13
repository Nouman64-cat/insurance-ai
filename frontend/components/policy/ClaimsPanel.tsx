"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { fmtPKR } from "@/app/services/policies";
import {
  getClaimsOverview, getClaimWorkspace, registerClaim, adoptClaim, reverifyClaimEligibility, overrideClaimEligibility,
  uploadClaimDocument, waiveClaimDocument, returnClaimDocument, requestClaimDocument, claimDocumentUrl, claimChecklistUrl,
  claimLetterUrl, addClaimFinding, completeClaimInvestigation, assessClaim, decideClaim, verifyClaimPayees,
  authorizeClaimDisbursement, disburseClaim, reconcileClaim, closeClaim, sendClaimLetter,
  type ClaimsOverview, type ClaimWorkspace, type ClaimStage, type ClaimCategory, type ClaimPayee, type RegisterClaimBody,
} from "@/app/services/postIssuance";
import {
  AuditTimeline, btnDanger, btnGhost, btnPrimary, CheckList, Chip, fmtDate, fmtDateTime, inputCls, KV, StageDot, TRACKER_TEXT,
} from "@/components/policy/panelKit";
import { tx } from "@/lib/i18n/tx";

// ─────────────────────────────────────────────────────────────────────────────
// Stage B · Step 8 — Claims Management. A policy-scoped workspace over the same Claim
// records the claims register uses. Independent of Reinstatement and Renewals: a claim is
// tested against the cover in force on the EVENT date, so a lapsed or closed policy can
// still have a valid claim. The seven steps mirror services/claim_engine.project_stages.
// ─────────────────────────────────────────────────────────────────────────────

const CLAIMS_ROLES = ["ClaimsAdjuster", "ClaimsManager", "Admin", "SuperAdmin", "Underwriter"];
const DECIDER_ROLES = ["ClaimsAdjuster", "ClaimsManager", "Admin", "SuperAdmin"];
const MANAGER_ROLES = ["ClaimsManager", "Admin", "SuperAdmin"];

const STATUS_TONE: Record<string, string> = {
  New: "bg-slate-50 text-slate-600 border-slate-200", Triaged: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200", "Under Investigation": "bg-blue-50 text-blue-700 border-blue-200",
  "Referred to Manager": "bg-amber-50 text-amber-700 border-amber-200", Approved: "bg-blue-50 text-blue-700 border-blue-200",
  "Partial Approval": "bg-blue-50 text-blue-700 border-blue-200", Declined: "bg-red-50 text-red-700 border-red-200",
  Settled: "bg-blue-100 text-blue-800 border-blue-300", Closed: "bg-slate-100 text-slate-600 border-slate-300",
};
const SLA_TONE: Record<string, { label: string; cls: string }> = {
  not_started: { label: "Clock not started", cls: "bg-slate-50 text-slate-500 border-slate-200" },
  on_track: { label: "On track", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  at_risk: { label: "Due now", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  breached: { label: "Overdue", cls: "bg-red-50 text-red-700 border-red-200" },
  met: { label: "Decided in time", cls: "bg-blue-50 text-blue-700 border-blue-200" },
};
const EVENT_LABEL: Record<string, string> = {
  ClaimRegistered: "Claim registered", ClaimAdopted: "Claim brought into the workflow", ClaimEligibilityVerified: "Eligibility verified",
  ClaimEligibilityOverridden: "Eligibility overridden", ClaimDocumentReceived: "Document received", ClaimDocumentsComplete: "All required documents received",
  ClaimDocumentWaived: "Document waived", ClaimDocumentReturned: "Document returned", ClaimDocumentRequested: "Document requested",
  ClaimInvestigationFinding: "Investigation finding", ClaimInvestigationCompleted: "Investigation completed", ClaimAssessed: "Benefit assessed",
  ClaimDecision: "Claims decision", ClaimPayeeVerified: "Payee verified", ClaimDisbursementAuthorized: "Disbursement authorised",
  ClaimSettled: "Claim paid", ClaimReconciled: "Payment reconciled", ClaimReconciliationException: "Reconciliation exception",
  PolicyTerminatedByClaim: "Policy ended by the claim", ClaimClosed: "Claim closed", ClaimLetterSent: "Letter sent",
};

type Run = (fn: () => Promise<unknown>, success: string) => Promise<boolean>;

// ─────────────────────────────────────────────────────────────────────────────

export default function ClaimsPanel({ policyId, onChanged }: Readonly<{ policyId: string; onChanged: () => Promise<void> }>) {
  const { notify } = useNotify();
  const [ov, setOv] = useState<ClaimsOverview | null>(null);
  const [ws, setWs] = useState<ClaimWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [regCategory, setRegCategory] = useState<ClaimCategory>("Death");

  useEffect(() => { if (typeof window !== "undefined") setRole(localStorage.getItem("user_role")); }, []);

  const loadOverview = useCallback(async () => {
    try { setOv(await getClaimsOverview(policyId)); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? e?.message ?? tx("Failed to load claims.")); }
  }, [policyId]);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  const open = async (claimId: string) => {
    try { setWs(await getClaimWorkspace(policyId, claimId)); setShowRegister(false); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? e?.message ?? tx("Failed to open the claim.")); }
  };

  const canWork = !!role && CLAIMS_ROLES.includes(role);
  const canDecide = !!role && DECIDER_ROLES.includes(role);
  const isManager = !!role && MANAGER_ROLES.includes(role);

  const currentKey = ws?.stages.find((s) => !["complete", "skipped"].includes(s.state))?.key ?? null;
  useEffect(() => { if (currentKey) setOpenStep(currentKey); }, [currentKey, ws?.claim.id]);

  const run: Run = async (fn, success) => {
    setBusy(true); setErr(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "stages" in (res as object) && "claim" in (res as object)) setWs(res as ClaimWorkspace);
      await loadOverview();
      await onChanged();           // the policy header may have changed (e.g. ended by a death claim)
      notify(success, true);
      return true;
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setErr(typeof detail === "string" ? detail : e?.message ?? tx("Action failed."));
      if (ws) { try { setWs(await getClaimWorkspace(policyId, ws.claim.id)); } catch { /* keep the last view */ } }
      return false;
    } finally { setBusy(false); }
  };

  if (!ov) {
    return err
      ? <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>
      : <p className="text-xs text-slate-400 italic">{tx("Loading claims…")}</p>;
  }
  const locked = busy || !canWork;

  return (
    <div className="space-y-4">
      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 flex justify-between gap-3">
          <span>{err}</span><button onClick={() => setErr(null)} className="text-red-400 hover:text-red-600">×</button>
        </div>
      )}
      {!canWork && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
          {tx("🔒 Claims actions need a claims role — you can view claims on this policy.")}
        </div>
      )}

      {/* Cover: the periods claims are tested against */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-800">{tx("Cover on record")}</p>
          <Chip cls={ov.coverage.in_force_today ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-red-50 text-red-700 border-red-200"}>
            {ov.coverage.in_force_today ? tx("In force today") : tx("Not in force today")} · {ov.policy.status}
          </Chip>
        </div>
        <div className="grid sm:grid-cols-4 gap-4">
          <KV label={tx("Policy")} value={<span className="font-mono">{ov.policy.policy_number}</span>} />
          <KV label={tx("Product")} value={ov.policy.product_name} />
          <KV label={tx("Segment")} value={tx(ov.policy.segment)} />
          <KV label={tx("Sum assured")} value={fmtPKR(ov.policy.sum_assured)} />
        </div>
        {ov.coverage.periods.length > 0 && (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {ov.coverage.periods.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="font-semibold text-slate-700">{tx("Cover period")} {i + 1}</span>
                <span className="text-slate-600 tabular-nums">{fmtDate(p.from)} → {p.to ? fmtDate(p.to) : tx("continuing")}</span>
                <span className="text-slate-400">{p.ended_by ? `${tx("ended by")} ${p.ended_by}` : tx("in force")}</span>
              </div>
            ))}
          </div>
        )}
        {ov.coverage.note && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{ov.coverage.note}</p>}
      </div>

      {/* Benefits + register */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {ov.benefits.map((b) => (
          <div key={b.category} className={`rounded-xl border p-3.5 flex flex-col justify-between gap-2 ${b.available ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"}`}>
            <div>
              <p className={`text-xs font-bold ${b.available ? "text-slate-800" : "text-slate-500"}`}>{tx(b.label)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{tx(b.applies)}</p>
              <p className={`text-sm font-black tabular-nums mt-2 ${b.available ? "text-slate-800" : "text-slate-400"}`}>{b.available ? fmtPKR(b.sum_assured) : tx("Not covered")}</p>
              <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2" title={b.detail}>{b.available ? b.source : b.detail}</p>
            </div>
            <button disabled={!canWork} className={b.available ? btnGhost : `${btnGhost} opacity-70`}
              onClick={() => { setRegCategory(b.category); setShowRegister(true); setWs(null); }}>{tx("Register claim")}</button>
          </div>
        ))}
      </div>

      {showRegister && (
        <RegisterForm key={regCategory} ov={ov} category={regCategory} locked={locked} onCancel={() => setShowRegister(false)}
          onSubmit={async (body) => { const ok = await run(() => registerClaim(policyId, body), tx("Claim registered.")); if (ok) setShowRegister(false); return ok; }} />
      )}

      {/* Claims on this policy */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Claims on this policy")} · {ov.claims.length}</p>
          <p className="text-[11px] text-slate-400">{tx("Decisions are normally made within")} {ov.rules.sla_working_days} {tx("working days of complete documents")}</p>
        </div>
        {ov.claims.length === 0 ? (
          <p className="px-4 py-6 text-xs text-slate-400 italic text-center">{tx("No claims have been registered on this policy.")}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {ov.claims.map((c) => {
              const sla = c.sla_state ? SLA_TONE[c.sla_state] : null;
              return (
                <div key={c.id} className={`grid grid-cols-[1fr_auto] md:grid-cols-[150px_1fr_110px_120px_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-xs ${ws?.claim.id === c.id ? "bg-blue-50/50" : ""}`}>
                  <span className="font-mono font-semibold text-slate-700">{c.claim_number}</span>
                  <span className="min-w-0 text-slate-600 truncate">{c.claim_type} · {tx("event")} {fmtDate(c.event_date)}{c.stage ? <span className="text-slate-400"> · {c.stage}</span> : null}</span>
                  <span className="tabular-nums text-slate-700 font-semibold md:text-right">{fmtPKR(c.approved_amount > 0 ? c.approved_amount : c.claimed_amount)}</span>
                  <span className="flex items-center gap-1.5 flex-wrap"><Chip cls={STATUS_TONE[c.status] ?? STATUS_TONE.New}>{tx(c.status)}</Chip>{sla && c.sla_state !== "not_started" && <Chip cls={sla.cls}>{tx(sla.label)}</Chip>}</span>
                  <span className="flex gap-2 justify-end col-span-2 md:col-span-1">
                    {c.has_workflow
                      ? <button className={btnGhost} onClick={() => open(c.id)}>{tx("Open")} {c.progress ? `(${c.progress.done}/${c.progress.total})` : ""}</button>
                      : <button disabled={locked} className={btnGhost} onClick={() => run(() => adoptClaim(policyId, c.id, { category: "Hospitalization" }), tx("Claim brought into the workflow."))}>{tx("Start workflow")}</button>}
                    <a href={`/claims/${c.id}`} className={btnGhost}>{tx("Register")}</a>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {ws && <Workspace ws={ws} ov={ov} policyId={policyId} locked={locked} canDecide={canDecide} isManager={isManager}
        openStep={openStep} setOpenStep={setOpenStep} run={run} onClose={() => setWs(null)} />}
    </div>
  );
}

// ── Registration (step 1) ────────────────────────────────────────────────────

function RegisterForm({
  ov, category, locked, onCancel, onSubmit,
}: Readonly<{ ov: ClaimsOverview; category: ClaimCategory; locked: boolean; onCancel: () => void; onSubmit: (b: RegisterClaimBody) => Promise<boolean> }>) {
  const benefit = ov.benefits.find((b) => b.category === category);
  const label = ov.options.categories.find((c) => c.key === category)?.label ?? category;
  const [f, setF] = useState({
    event_date: "", event_end_date: "", cause: category === "Hospitalization" ? "" : "Natural / illness", event_place: "", event_description: "",
    hospital: "", diagnosis: "", claimed_amount: benefit?.available && category !== "Hospitalization" ? String(benefit.sum_assured) : "",
    claimant_name: ov.policy.customer_name ?? "", claimant_cnic: ov.policy.customer_cnic ?? "", claimant_relationship: "Self",
    claimant_phone: "", claimant_email: "", covered_person_name: "", covered_relationship: "Self", channel: ov.options.channels[0] ?? "Branch", notes: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const death = category === "Death" || category === "AccidentalDeath";
  const valid = f.event_date && Number(f.claimed_amount) > 0 && f.claimant_name.trim() && (!death || f.cause);
  return (
    <div className="rounded-xl border border-blue-200 bg-white p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-800">{tx("Claim intimation")} — {tx(label)}</p>
        <button className="text-slate-400 hover:text-slate-600" onClick={onCancel}>×</button>
      </div>
      {benefit && !benefit.available && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {tx("This policy shows no")} {tx(label).toLowerCase()} {tx("benefit today:")} {benefit.detail} {tx("The claim will still be registered — eligibility is tested against the event date.")}
        </p>
      )}
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={tx("Event date")}><input type="date" max={new Date().toISOString().slice(0, 10)} value={f.event_date} onChange={(e) => set("event_date", e.target.value)} className={inputCls} /></Field>
        {category === "Hospitalization" && <Field label={tx("Discharge date")}><input type="date" value={f.event_end_date} onChange={(e) => set("event_end_date", e.target.value)} className={inputCls} /></Field>}
        <Field label={death ? tx("Cause (required)") : tx("Cause")}>
          <select value={f.cause} onChange={(e) => set("cause", e.target.value)} className={inputCls}>
            <option value="">{tx("— select —")}</option>{ov.options.causes.map((c) => <option key={c} value={c}>{tx(c)}</option>)}
          </select>
        </Field>
        <Field label={tx("Claimed amount (PKR)")}><input type="number" min={0} value={f.claimed_amount} onChange={(e) => set("claimed_amount", e.target.value)} className={inputCls} /></Field>
        <Field label={tx("Place")}><input value={f.event_place} onChange={(e) => set("event_place", e.target.value)} className={inputCls} /></Field>
        {category === "Hospitalization" && <>
          <Field label={tx("Hospital")}><input value={f.hospital} onChange={(e) => set("hospital", e.target.value)} className={inputCls} /></Field>
          <Field label={tx("Diagnosis")}><input value={f.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} className={inputCls} /></Field>
        </>}
        <div className="sm:col-span-3"><Field label={tx("What happened")}><textarea rows={2} value={f.event_description} onChange={(e) => set("event_description", e.target.value)} className={inputCls} /></Field></div>
      </div>
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Claimant")}</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={tx("Name")}><input value={f.claimant_name} onChange={(e) => set("claimant_name", e.target.value)} className={inputCls} /></Field>
        <Field label={tx("CNIC")}><input value={f.claimant_cnic} onChange={(e) => set("claimant_cnic", e.target.value)} className={inputCls} placeholder="35202-1234567-1" /></Field>
        <Field label={tx("Relationship to the covered person")}>
          <select value={f.claimant_relationship} onChange={(e) => set("claimant_relationship", e.target.value)} className={inputCls}>{ov.options.claimant_relationships.map((r) => <option key={r} value={r}>{tx(r)}</option>)}</select>
        </Field>
        <Field label={tx("Phone")}><input value={f.claimant_phone} onChange={(e) => set("claimant_phone", e.target.value)} className={inputCls} /></Field>
        <Field label={tx("Email")}><input value={f.claimant_email} onChange={(e) => set("claimant_email", e.target.value)} className={inputCls} /></Field>
        <Field label={tx("Received via")}><select value={f.channel} onChange={(e) => set("channel", e.target.value)} className={inputCls}>{ov.options.channels.map((c) => <option key={c} value={c}>{tx(c)}</option>)}</select></Field>
      </div>
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Covered person")}</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={tx("Relationship to the policyholder")}><select value={f.covered_relationship} onChange={(e) => set("covered_relationship", e.target.value)} className={inputCls}>{ov.options.covered_relationships.map((r) => <option key={r} value={r}>{tx(r)}</option>)}</select></Field>
        {f.covered_relationship !== "Self" && <Field label={tx("Name")}><input value={f.covered_person_name} onChange={(e) => set("covered_person_name", e.target.value)} className={inputCls} /></Field>}
      </div>
      <div className="flex items-center gap-3">
        <button disabled={locked || !valid} className={btnPrimary} onClick={() => onSubmit({
          category, event_date: f.event_date, event_end_date: f.event_end_date || undefined, cause: f.cause || undefined,
          event_place: f.event_place || undefined, event_description: f.event_description || undefined,
          event_details: category === "Hospitalization" ? { hospital: f.hospital, diagnosis: f.diagnosis } : undefined,
          claimed_amount: Number(f.claimed_amount), claimant_name: f.claimant_name.trim(), claimant_cnic: f.claimant_cnic || undefined,
          claimant_relationship: f.claimant_relationship, claimant_phone: f.claimant_phone || undefined, claimant_email: f.claimant_email || undefined,
          covered_person_name: f.covered_person_name || undefined, covered_person_relationship: f.covered_relationship, channel: f.channel, notes: f.notes || undefined,
        })}>{tx("Register claim")}</button>
        <p className="text-[11px] text-slate-400">{tx("Eligibility on the event date is checked straight away.")}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return <div><label className="text-[11px] font-semibold text-slate-500">{label}</label><div className="mt-1">{children}</div></div>;
}

// ── The seven-step workspace ─────────────────────────────────────────────────

function Workspace({
  ws, ov, policyId, locked, canDecide, isManager, openStep, setOpenStep, run, onClose,
}: Readonly<{ ws: ClaimWorkspace; ov: ClaimsOverview; policyId: string; locked: boolean; canDecide: boolean; isManager: boolean;
  openStep: string | null; setOpenStep: (k: string | null) => void; run: Run; onClose: () => void }>) {
  const sla = SLA_TONE[ws.sla.state];
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold font-mono text-slate-700 bg-white px-2.5 py-1 rounded-md border border-slate-200">{ws.claim.claim_number}</span>
          <span className="text-sm font-semibold text-slate-800">{ws.process.category_label}</span>
          <Chip cls={STATUS_TONE[ws.claim.status] ?? STATUS_TONE.New}>{tx(ws.claim.status)}</Chip>
          <Chip cls={sla.cls}>{tx(sla.label)}{ws.sla.due_date && ws.sla.state !== "met" ? ` · ${fmtDate(ws.sla.due_date)}` : ""}</Chip>
          {ws.claim.duplicate_flag && <Chip cls="bg-red-50 text-red-700 border-red-200">{tx("Possible duplicate")}</Chip>}
        </div>
        <div className="flex gap-2">
          <a href={`/claims/${ws.claim.id}`} className={btnGhost}>{tx("Open in claims register")}</a>
          <button className={btnGhost} onClick={onClose}>{tx("Close view")}</button>
        </div>
      </div>

      <div className="space-y-2">
        {ws.stages.map((st) => {
          const isOpen = openStep === st.key;
          return (
            <div key={st.key} className={`rounded-xl border bg-white overflow-hidden ${["action", "pending"].includes(st.state) ? "border-amber-300" : "border-slate-200"}`}>
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
                  <StepBody step={st.key} ws={ws} ov={ov} policyId={policyId} locked={locked} canDecide={canDecide} isManager={isManager} run={run} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {ws.timeline.length > 0 && <AuditTimeline items={ws.timeline} labels={EVENT_LABEL} />}
    </div>
  );
}

function StepBody({
  step, ws, ov, policyId, locked, canDecide, isManager, run,
}: Readonly<{ step: ClaimStage["key"]; ws: ClaimWorkspace; ov: ClaimsOverview; policyId: string; locked: boolean; canDecide: boolean; isManager: boolean; run: Run }>) {
  switch (step) {
    case "intimation": return <IntimationStep ws={ws} />;
    case "eligibility": return <EligibilityStep ws={ws} policyId={policyId} locked={locked} isManager={isManager} run={run} />;
    case "documents": return <DocumentsStep ws={ws} policyId={policyId} locked={locked} isManager={isManager} run={run} />;
    case "assessment": return <AssessmentStep ws={ws} policyId={policyId} locked={locked} run={run} />;
    case "decision": return <DecisionStep ws={ws} policyId={policyId} locked={locked} canDecide={canDecide} isManager={isManager} run={run} />;
    case "settlement": return <SettlementStep ws={ws} ov={ov} policyId={policyId} locked={locked} canDecide={canDecide} run={run} />;
    default: return <ClosureStep ws={ws} policyId={policyId} locked={locked} run={run} />;
  }
}

function IntimationStep({ ws }: Readonly<{ ws: ClaimWorkspace }>) {
  const p = ws.process, c = ws.claim;
  return (
    <div className="grid sm:grid-cols-3 gap-4">
      <KV label={tx("Claim")} value={<span className="font-mono">{c.claim_number}</span>} />
      <KV label={tx("Claimed")} value={fmtPKR(c.claimed_amount)} />
      <KV label={tx("Reported")} value={`${fmtDate(c.reported_date)} · ${p.channel ?? "—"}`} />
      <KV label={tx("Claimant")} value={`${c.claimant.name ?? "—"} (${c.claimant.relationship ?? "—"})`} />
      <KV label={tx("Claimant CNIC")} value={c.claimant.cnic} />
      <KV label={tx("Contact")} value={[c.claimant.phone, c.claimant.email].filter(Boolean).join(" · ")} />
      <KV label={tx("Covered person")} value={`${p.covered_person.name ?? "—"} (${p.covered_person.relationship ?? "—"})`} />
      <KV label={tx("Event")} value={`${fmtDate(p.event.date)}${p.event.end_date ? ` → ${fmtDate(p.event.end_date)}` : ""}`} />
      <KV label={tx("Cause / place")} value={[p.event.cause, p.event.place].filter(Boolean).join(" · ")} />
      {Object.entries(p.event.details ?? {}).filter(([, v]) => v).map(([k, v]) => <KV key={k} label={tx(k.charAt(0).toUpperCase() + k.slice(1))} value={v} />)}
      <div className="sm:col-span-3"><KV label={tx("What happened")} value={p.event.description} /></div>
    </div>
  );
}

function EligibilityStep({ ws, policyId, locked, isManager, run }: Readonly<{ ws: ClaimWorkspace; policyId: string; locked: boolean; isManager: boolean; run: Run }>) {
  const [note, setNote] = useState("");
  const e = ws.eligibility, r = e.result;
  if (!r) return <p className="text-xs text-slate-500">{tx("Eligibility has not been verified yet.")}</p>;
  const tone = e.status === "Ineligible" ? "border-red-200 bg-red-50 text-red-800" : e.status === "Referred" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-blue-200 bg-blue-50 text-blue-800";
  return (
    <div className="space-y-3">
      <div className={`rounded-lg border px-3 py-2.5 text-xs ${tone}`}><b>{tx(e.status ?? "")}</b> — {r.message}</div>
      <div className="grid sm:grid-cols-3 gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <KV label={tx("Event date")} value={fmtDate(ws.process.event.date)} />
        <KV label={tx("Benefit that responds")} value={r.benefit.available ? r.benefit.label : tx("None")} />
        <KV label={tx("Sum assured payable under it")} value={r.benefit.available ? fmtPKR(r.benefit.sum_assured) : "—"} />
      </div>
      <CheckList checks={r.checks} />
      <p className="text-[11px] text-slate-400">{tx("Verified")} {fmtDateTime(e.verified_at)} · {e.verified_by}{e.override_by ? ` · ${tx("overridden by")} ${e.override_by}: ${e.override_note}` : ""}</p>
      {ws.can.verify && <button disabled={locked} className={btnGhost} onClick={() => run(() => reverifyClaimEligibility(policyId, ws.claim.id), tx("Eligibility re-verified."))}>{tx("Re-verify")}</button>}
      {e.status === "Ineligible" && !e.override_by && ws.can.verify && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
          <p className="text-xs text-slate-600">{tx("An ineligible claim is rejected. A claims manager can instead let it proceed (for example an ex-gratia decision) — the reason is recorded permanently.")}</p>
          {isManager
            ? <>
              <textarea rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} className={inputCls} placeholder={tx("Reason for the override (at least 15 characters)")} />
              <button disabled={locked || note.trim().length < 15} className={btnDanger} onClick={() => run(() => overrideClaimEligibility(policyId, ws.claim.id, note.trim()), tx("Eligibility overridden."))}>{tx("Override and continue")}</button>
            </>
            : <p className="text-[11px] text-slate-400">{tx("Only a claims manager can override.")}</p>}
        </div>
      )}
    </div>
  );
}

function DocumentsStep({ ws, policyId, locked, isManager, run }: Readonly<{ ws: ClaimWorkspace; policyId: string; locked: boolean; isManager: boolean; run: Run }>) {
  const d = ws.documents;
  const [extra, setExtra] = useState("");
  if (d.items.length === 0) return <p className="text-xs text-slate-500">{tx("The checklist is generated once the claim is eligible.")}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600"><b>{d.progress.received}</b> {tx("of")} <b>{d.progress.required}</b> {tx("required documents received.")} {ws.sla.message}</p>
        <a href={claimChecklistUrl(policyId, ws.claim.id)} target="_blank" rel="noreferrer" className={btnGhost}>{tx("Checklist for the claimant (PDF)")}</a>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
        {d.items.map((it) => <DocRow key={it.key} it={it} ws={ws} policyId={policyId} locked={locked} isManager={isManager} run={run} />)}
      </div>
      {ws.can.edit_documents && (
        <div className="flex gap-2">
          <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={tx("Ask for another document…")} className={inputCls} />
          <button disabled={locked || !extra.trim()} className={btnGhost}
            onClick={() => run(() => requestClaimDocument(policyId, ws.claim.id, { label: extra.trim(), required: true }), tx("Document requested.")).then((ok) => { if (ok) setExtra(""); })}>{tx("Request")}</button>
        </div>
      )}
    </div>
  );
}

function DocRow({ it, ws, policyId, locked, isManager, run }: Readonly<{ it: ClaimWorkspace["documents"]["items"][number]; ws: ClaimWorkspace; policyId: string; locked: boolean; isManager: boolean; run: Run }>) {
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const done = it.status === "Received" || it.status === "Waived";
  return (
    <div className="px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-700">{it.label}</p>
          {it.reason && <p className="text-[11px] text-slate-400">{it.reason}</p>}
          {it.note && <p className="text-[11px] text-slate-500">{it.note}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Chip cls={it.required ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-50 text-slate-500 border-slate-200"}>{it.required ? tx("Required") : tx("If asked")}</Chip>
          <Chip cls={it.status === "Received" ? "bg-blue-50 text-blue-700 border-blue-200" : it.status === "Waived" ? "bg-slate-100 text-slate-600 border-slate-300" : "bg-slate-50 text-slate-600 border-slate-200"}>{tx(it.status)}</Chip>
        </div>
      </div>
      {it.status === "Received" && (
        <p className="text-[11px] text-slate-500">{fmtDateTime(it.received_at)}{it.artifact_id && <> · <a className="text-blue-600 hover:underline" target="_blank" rel="noreferrer" href={claimDocumentUrl(policyId, ws.claim.id, it.key)}>{it.file_name ?? tx("View file")}</a></>}</p>
      )}
      {ws.can.edit_documents && !done && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[11px] text-slate-500 max-w-[220px]" />
          <button disabled={locked || !file} className={btnGhost} onClick={() => file && run(() => uploadClaimDocument(policyId, ws.claim.id, it.key, file), tx("Document received."))}>{tx("Receive")}</button>
          {isManager && <>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tx("Reason to waive")} className={`${inputCls} !w-44`} />
            <button disabled={locked || reason.trim().length < 10} className={btnDanger} onClick={() => run(() => waiveClaimDocument(policyId, ws.claim.id, it.key, reason.trim()), tx("Document waived."))}>{tx("Waive")}</button>
          </>}
        </div>
      )}
      {ws.can.edit_documents && it.status === "Received" && (
        <div className="flex gap-2 items-center">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tx("Why send it back? (illegible, wrong person…)")} className={inputCls} />
          <button disabled={locked || !reason.trim()} className={btnGhost} onClick={() => run(() => returnClaimDocument(policyId, ws.claim.id, it.key, reason.trim()), tx("Document returned to the claimant."))}>{tx("Return")}</button>
        </div>
      )}
    </div>
  );
}

function AssessmentStep({ ws, policyId, locked, run }: Readonly<{ ws: ClaimWorkspace; policyId: string; locked: boolean; run: Run }>) {
  const inv = ws.investigation;
  const [kind, setKind] = useState("Neutral");
  const [source, setSource] = useState("");
  const [finding, setFinding] = useState("");
  const [outcome, setOutcome] = useState("Verified");
  const [invNotes, setInvNotes] = useState("");
  const [pct, setPct] = useState("");
  const [copay, setCopay] = useState("");
  const [lines, setLines] = useState<{ label: string; amount: string }[]>([]);
  const [notes, setNotes] = useState("");
  const a = ws.assessment.result;
  const cat = ws.process.category;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Investigation")}{inv.requires_investigation ? ` — ${tx("required")}` : ` — ${tx("not required")}`}</p>
        {(inv.flags ?? []).length === 0 ? <p className="text-xs text-slate-500">{tx("No red flags raised.")}</p> : (
          <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
            {inv.flags!.map((f) => (
              <div key={f.code} className="flex items-start gap-2.5 px-3 py-2">
                <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${f.severity === "high" ? "bg-red-500" : f.severity === "medium" ? "bg-amber-500" : "bg-slate-400"}`} />
                <p className="text-xs text-slate-700">{f.message}</p>
              </div>
            ))}
          </div>
        )}
        {(inv.findings ?? []).map((x, i) => (
          <p key={i} className="text-xs text-slate-600 border-l-2 border-slate-200 pl-3"><b>{x.kind}</b>{x.source ? ` · ${x.source}` : ""} — {x.note} <span className="text-slate-400">({x.by}, {fmtDateTime(x.at)})</span></p>
        ))}
        {ws.can.investigate && !inv.completed_at && (
          <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
            <div className="grid sm:grid-cols-[110px_1fr_1fr] gap-2">
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>{["Neutral", "Verified", "Adverse"].map((k) => <option key={k} value={k}>{tx(k)}</option>)}</select>
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder={tx("Source (hospital call, FIR check…)")} className={inputCls} />
              <input value={finding} onChange={(e) => setFinding(e.target.value)} placeholder={tx("What was found")} className={inputCls} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={locked || !finding.trim()} className={btnGhost} onClick={() => run(() => addClaimFinding(policyId, ws.claim.id, { kind, source: source || undefined, note: finding.trim() }), tx("Finding recorded.")).then((ok) => { if (ok) { setFinding(""); setSource(""); } })}>{tx("Add finding")}</button>
              <span className="text-slate-300">|</span>
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={`${inputCls} !w-auto`}>{["Verified", "Adverse", "Inconclusive"].map((k) => <option key={k} value={k}>{tx(k)}</option>)}</select>
              <input value={invNotes} onChange={(e) => setInvNotes(e.target.value)} placeholder={tx("Outcome notes")} className={`${inputCls} !w-56`} />
              <button disabled={locked} className={btnPrimary} onClick={() => run(() => completeClaimInvestigation(policyId, ws.claim.id, { outcome, notes: invNotes || undefined }), tx("Investigation completed."))}>{tx("Complete investigation")}</button>
            </div>
          </div>
        )}
        {inv.completed_at && <p className="text-xs text-slate-600">{tx("Investigation completed")} {fmtDateTime(inv.completed_at)} — <b>{inv.outcome}</b>{inv.notes ? `: ${inv.notes}` : ""}</p>}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Contractual benefit")}</p>
        {a && (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 space-y-1.5 max-w-lg">
            {a.components.map((c) => <Line key={c.label} k={c.label} v={fmtPKR(c.amount)} />)}
            {a.deductions.map((d) => <Line key={d.label} k={`− ${d.label}`} v={fmtPKR(d.amount)} muted />)}
            <div className="border-t border-slate-200 pt-1.5 mt-1.5"><Line k={tx("Payable")} v={fmtPKR(a.payable)} strong /></div>
            <p className="text-[11px] text-slate-400">{a.basis}{a.capped_by ? ` · ${tx("limited by")} ${tx(a.capped_by)}` : ""} · {tx("claimed")} {fmtPKR(a.claimed_amount)} · {ws.assessment.assessed_by}</p>
          </div>
        )}
        {ws.can.assess ? (
          <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
            <div className="grid sm:grid-cols-3 gap-2">
              {cat === "Disability" && <input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} placeholder={tx("Degree of disability (%)")} className={inputCls} />}
              {cat === "Hospitalization" && <input type="number" min={0} max={100} value={copay} onChange={(e) => setCopay(e.target.value)} placeholder={tx("Co-payment % (blank = plan default)")} className={inputCls} />}
            </div>
            {lines.map((ln, i) => (
              <div key={i} className="flex gap-2">
                <input value={ln.label} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder={cat === "Hospitalization" ? tx("Not admissible (e.g. cosmetic procedure)") : tx("Deduction (e.g. policy loan)")} className={inputCls} />
                <input type="number" min={0} value={ln.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="PKR" className={`${inputCls} !w-36`} />
                <button className="text-slate-300 hover:text-red-500 px-1" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="text-[11px] text-blue-600 font-semibold" onClick={() => setLines([...lines, { label: "", amount: "" }])}>{cat === "Hospitalization" ? tx("+ Add a non-admissible item") : tx("+ Add a deduction")}</button>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tx("Assessment notes")} className={inputCls} />
            <button disabled={locked || (cat === "Disability" && !(Number(pct) > 0))} className={btnPrimary}
              onClick={() => run(() => assessClaim(policyId, ws.claim.id, {
                disability_pct: cat === "Disability" ? Number(pct) : undefined, copay_pct: copay ? Number(copay) : undefined,
                deductions: lines.filter((l) => l.label.trim() && Number(l.amount) > 0).map((l) => ({ label: l.label.trim(), amount: Number(l.amount) })), notes: notes || undefined,
              }), tx("Benefit assessed."))}>{a ? tx("Re-assess") : tx("Calculate benefit")}</button>
          </div>
        ) : !a && <p className="text-xs text-slate-400">{tx("Assessment opens once every required document is in and any required investigation is complete.")}</p>}
      </div>
    </div>
  );
}

function Line({ k, v, strong, muted }: Readonly<{ k: string; v: string; strong?: boolean; muted?: boolean }>) {
  return <div className="flex justify-between gap-6 text-xs"><span className={strong ? "font-bold text-slate-800" : muted ? "text-slate-500" : "text-slate-600"}>{k}</span><span className={`tabular-nums ${strong ? "font-bold text-slate-900" : "text-slate-700"}`}>{v}</span></div>;
}

function DecisionStep({ ws, policyId, locked, canDecide, isManager, run }: Readonly<{ ws: ClaimWorkspace; policyId: string; locked: boolean; canDecide: boolean; isManager: boolean; run: Run }>) {
  const [choice, setChoice] = useState<"Approve" | "PartialApprove" | "Reject" | "RequestInfo" | "Refer">("Approve");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [asks, setAsks] = useState<string[]>([""]);
  const d = ws.decision;
  const payable = ws.assessment.result?.payable ?? 0;
  const blockedByManager = d.requires_manager && !isManager && (choice === "Approve" || choice === "PartialApprove" || choice === "Reject");
  const need = choice !== "Approve" && !reason.trim() ? tx("A reason is required.")
    : choice === "PartialApprove" && !(Number(amount) > 0 && Number(amount) < payable) ? tx("Enter an amount below the assessed benefit.")
      : choice === "RequestInfo" && !asks.some((a) => a.trim()) ? tx("List what is needed.") : null;
  const decided = ["Approved", "Partial Approval", "Declined", "Settled", "Closed"].includes(ws.claim.status);
  const options: [typeof choice, string][] = [["Approve", "Approve"], ["PartialApprove", "Partially approve"], ["Reject", "Reject"], ["RequestInfo", "Request information"], ["Refer", "Refer to manager"]];
  return (
    <div className="space-y-3">
      {d.decision && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700">
          <b>{tx(d.decision)}</b>{d.amount > 0 ? ` · ${fmtPKR(d.amount)}` : ""} · {d.by} · {fmtDateTime(d.at)}{d.reason ? ` — ${d.reason}` : ""}
        </div>
      )}
      <p className="text-xs text-slate-500">{ws.sla.message}{d.requires_manager ? ` ${tx("Above")} ${fmtPKR(d.manager_limit)} ${tx("(or already referred) a claims manager must decide.")}` : ""}</p>
      {!decided && ws.can.decide && (canDecide ? (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {options.map(([v, l]) => (
              <button key={v} onClick={() => setChoice(v)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${choice === v ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{tx(l)}</button>
            ))}
          </div>
          {choice === "Approve" && <p className="text-xs text-slate-600">{tx("Approves the assessed benefit of")} <b>{fmtPKR(payable)}</b>.</p>}
          {choice === "PartialApprove" && <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`${tx("Amount to approve (below")} ${fmtPKR(payable)})`} className={inputCls} />}
          {choice === "RequestInfo" && (
            <div className="space-y-2">
              {asks.map((a, i) => <input key={i} value={a} onChange={(e) => setAsks(asks.map((x, j) => (j === i ? e.target.value : x)))} placeholder={tx("Information or document needed")} className={inputCls} />)}
              <button className="text-[11px] text-blue-600 font-semibold" onClick={() => setAsks([...asks, ""])}>{tx("+ Add another")}</button>
            </div>
          )}
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder={choice === "Approve" ? tx("Rationale (optional; required for a flagged duplicate)") : tx("Reason (required)")} />
          <div className="flex items-center gap-3 flex-wrap">
            <button disabled={locked || !!need || blockedByManager} className={choice === "Reject" ? "px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40" : btnPrimary}
              onClick={() => run(() => decideClaim(policyId, ws.claim.id, {
                decision: choice, amount: choice === "PartialApprove" ? Number(amount) : undefined, reason: reason.trim() || undefined,
                info_requests: choice === "RequestInfo" ? asks.filter((a) => a.trim()).map((label) => ({ label: label.trim() })) : undefined,
              }), tx("Decision recorded."))}>{tx("Record decision")}</button>
            {blockedByManager ? <p className="text-[11px] text-amber-600">{tx("Needs a claims manager — use “Refer to manager”.")}</p> : need && <p className="text-[11px] text-amber-600">{need}</p>}
          </div>
        </div>
      ) : <p className="text-xs text-slate-500">{tx("Only an authorised claims officer can record the decision.")}</p>)}
      {!decided && !ws.can.decide && ws.claim.status !== "Referred to Manager" && <p className="text-xs text-slate-400">{tx("The decision opens once documents are complete, any investigation is done and the benefit is assessed.")}</p>}
      {d.history.length > 1 && (
        <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
          {[...d.history].reverse().map((h, i) => <p key={i} className="px-3 py-2 text-xs text-slate-600"><b>{tx(h.decision)}</b>{h.amount > 0 ? ` · ${fmtPKR(h.amount)}` : ""} · {h.by} · {fmtDateTime(h.at)}{h.reason ? ` — ${h.reason}` : ""}</p>)}
        </div>
      )}
    </div>
  );
}

function SettlementStep({ ws, ov, policyId, locked, canDecide, run }: Readonly<{ ws: ClaimWorkspace; ov: ClaimsOverview; policyId: string; locked: boolean; canDecide: boolean; run: Run }>) {
  const s = ws.settlement;
  const [method, setMethod] = useState(ov.options.payout_methods[0] ?? "Bank Transfer");
  const [note, setNote] = useState("");
  if (["Declined"].includes(ws.claim.status) || ws.stages.find((x) => x.key === "settlement")?.state === "skipped") {
    return <p className="text-xs text-slate-500">{tx("No payment — the claim was rejected.")}</p>;
  }
  if (s.payees.length === 0) return <p className="text-xs text-slate-400">{tx("Settlement begins once the claim is approved.")}</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">{tx("Approved")} <b>{fmtPKR(ws.claim.approved_amount)}</b> {tx("— verify who is rightfully paid, authorise, disburse and reconcile.")}</p>
      {s.payees.map((p) => <PayeeCard key={p.id} p={p} editable={ws.can.verify_payees} policyId={policyId} claimId={ws.claim.id} locked={locked} run={run} />)}
      <div className="flex flex-wrap items-center gap-2">
        {ws.can.authorize && <button disabled={locked || !canDecide} className={btnPrimary} onClick={() => run(() => authorizeClaimDisbursement(policyId, ws.claim.id), tx("Disbursement authorised."))}>{tx("Authorise disbursement")} {fmtPKR(ws.claim.approved_amount)}</button>}
        {s.authorized_at && <p className="text-xs text-slate-600">{tx("Authorised by")} <b>{s.authorized_by}</b> · {fmtDateTime(s.authorized_at)}</p>}
        {ws.can.disburse && (<>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inputCls} !w-auto`}>{s.methods.map((m) => <option key={m} value={m}>{tx(m)}</option>)}</select>
          <button disabled={locked || !canDecide} className={btnPrimary} onClick={() => { if (confirm(tx("Disburse the authorised amount now?"))) run(() => disburseClaim(policyId, ws.claim.id, method), tx("Claim paid.")); }}>{tx("Disburse")}</button>
        </>)}
      </div>
      {s.payouts.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400"><th className="text-left font-semibold px-3 py-2">{tx("Payee")}</th><th className="text-left font-semibold px-3 py-2">{tx("Method")}</th><th className="text-left font-semibold px-3 py-2">{tx("Reference")}</th><th className="text-right font-semibold px-3 py-2">{tx("Amount")}</th></tr></thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">{s.payouts.map((p) => <tr key={p.id}><td className="px-3 py-2">{p.payee_name}</td><td className="px-3 py-2">{p.method}</td><td className="px-3 py-2 font-mono">{p.reference_number}</td><td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtPKR(p.amount)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {s.reconciliation && <CheckList checks={s.reconciliation.checks} />}
      {s.reconciled_at
        ? <p className="text-xs text-slate-600">{tx("Reconciled by")} {s.reconciled_by} · {fmtDateTime(s.reconciled_at)}</p>
        : ws.can.reconcile && (
          <div className="space-y-2">
            {s.reconciliation?.status === "Exception" && <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder={tx("Note explaining the exception")} />}
            <button disabled={locked || (s.reconciliation?.status === "Exception" && !note.trim())} className={btnPrimary} onClick={() => run(() => reconcileClaim(policyId, ws.claim.id, note.trim() || undefined), tx("Payment reconciled."))}>
              {s.reconciliation?.status === "Exception" ? tx("Reconcile with exception") : tx("Reconcile payment")}</button>
          </div>
        )}
    </div>
  );
}

function PayeeCard({ p, editable, policyId, claimId, locked, run }: Readonly<{ p: ClaimPayee; editable: boolean; policyId: string; claimId: string; locked: boolean; run: Run }>) {
  const [f, setF] = useState({ cnic: p.cnic ?? "", bank_name: p.bank_name ?? "", account_title: p.account_title ?? p.name, iban: p.iban ?? "", method: p.method ?? "", note: p.note ?? "" });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <div className={`rounded-lg border bg-white p-3 space-y-3 ${p.verified ? "border-blue-200" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-slate-800">{p.name}{p.beneficiary_name !== p.name && <span className="text-xs font-medium text-slate-500"> {tx("for")} {p.beneficiary_name} ({tx("minor")})</span>}</p>
          <p className="text-[11px] text-slate-400">{p.relationship} · {p.share_pct}% · {p.source}</p>
        </div>
        <div className="flex items-center gap-2"><span className="text-sm font-black tabular-nums text-slate-800">{fmtPKR(p.amount)}</span>
          <Chip cls={p.verified ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-amber-50 text-amber-700 border-amber-200"}>{p.verified ? tx("Verified") : tx("Unverified")}</Chip></div>
      </div>
      {editable ? (
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
            <button disabled={locked} className={btnGhost} onClick={() => run(() => verifyClaimPayees(policyId, claimId, [{ id: p.id, ...f, verify: false }]), tx("Payee details saved."))}>{tx("Save & check")}</button>
            <button disabled={locked} className={btnPrimary} onClick={() => run(() => verifyClaimPayees(policyId, claimId, [{ id: p.id, ...f, verify: true }]), tx("Payee verified."))}>{p.verified ? tx("Re-verify") : tx("Verify payee")}</button>
          </div>
        </>
      ) : <p className="text-[11px] text-slate-500">{p.bank_name} · <span className="font-mono">{p.iban}</span> · {p.account_title}</p>}
      {p.checks.length > 0 && <CheckList checks={p.checks} />}
    </div>
  );
}

function ClosureStep({ ws, policyId, locked, run }: Readonly<{ ws: ClaimWorkspace; policyId: string; locked: boolean; run: Run }>) {
  const c = ws.closure;
  if (c.outcome) {
    const cu = c.coverage_update ?? {};
    return (
      <div className="space-y-3">
        <div className="grid sm:grid-cols-4 gap-4">
          <KV label={tx("Outcome")} value={tx(c.outcome)} /><KV label={tx("Closed")} value={fmtDateTime(c.closed_at)} /><KV label={tx("By")} value={c.closed_by} />
          <KV label={tx("Benefit paid")} value={fmtPKR(Number(cu["benefit_paid"] ?? 0))} />
        </div>
        {typeof cu["note"] === "string" && <p className="text-xs text-slate-600 bg-white border border-slate-200 rounded-lg px-3 py-2">{cu["note"] as string}{cu["policy_status"] ? ` ${tx("Policy is now")} ${cu["policy_status"]}.` : ""}{cu["remaining_limit"] != null ? ` ${tx("Remaining annual limit")} ${fmtPKR(Number(cu["remaining_limit"]))}.` : ""}{cu["rider_sum_after"] != null ? ` ${tx("Rider benefit left")} ${fmtPKR(Number(cu["rider_sum_after"]))}.` : ""}</p>}
        <div className="flex flex-wrap gap-2">
          <a href={claimLetterUrl(policyId, ws.claim.id)} target="_blank" rel="noreferrer" className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white">{c.outcome === "Settled" ? tx("Download settlement confirmation (PDF)") : tx("Download decision letter (PDF)")}</a>
          <button disabled={locked} className={btnGhost} onClick={() => run(async () => {
            const r = await sendClaimLetter(policyId, ws.claim.id);
            if (!r.delivered) throw new Error(tx("The email could not be delivered (mail provider not configured or rejected it)."));
          }, tx("Letter emailed to the claimant."))}>{tx("Email to claimant")}</button>
          {c.confirmation.sent_at && <span className="text-[11px] text-slate-500 self-center">{tx("Sent")} {fmtDateTime(c.confirmation.sent_at)} · {c.confirmation.sent_to}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">{tx("Closing records the outcome, issues the confirmation letter and updates the coverage records. A paid death benefit ends the policy and waives its unpaid instalments; a rider or hospital benefit reduces what is left.")}</p>
      <button disabled={locked || !ws.can.close} className={btnPrimary}
        onClick={() => { if (confirm(tx("Close this claim? This cannot be undone."))) run(() => closeClaim(policyId, ws.claim.id), tx("Claim closed.")); }}>{tx("Close claim")}</button>
      {!ws.can.close && <p className="text-[11px] text-slate-400">{tx("A claim can be closed once it is paid and reconciled, or rejected.")}</p>}
    </div>
  );
}
