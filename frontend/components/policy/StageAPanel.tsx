"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getReadiness, getCounterOffer, acceptCounterOffer, declineCounterOffer,
  getRequirements, seedRequirements, actOnRequirement,
  getCompliance, runCompliance, clearCompliance,
  getBeneficiaries, replaceBeneficiaries, generateDocuments, documentDownloadUrl,
  type Readiness, type CounterOffer, type RequirementItem, type ComplianceCheck, type Beneficiary,
} from "@/app/services/preIssuance";
import { getPolicyDetail, type PolicyDocument } from "@/app/services/policies";

const fmtPKR = (n: number | null | undefined) =>
  n == null ? "—" : `PKR ${Math.round(n).toLocaleString()}`;

const PILL: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  blocked: "bg-red-50 text-red-700 border-red-200",
  current: "bg-amber-50 text-amber-700 border-amber-200",
  idle: "bg-slate-100 text-slate-500 border-slate-200",
};

function StepShell({
  n, title, state, hint, children,
}: Readonly<{ n: number; title: string; state: "done" | "blocked" | "current" | "idle"; hint: string; children?: React.ReactNode }>) {
  return (
    <div className="relative pl-9">
      <span className={`absolute left-0 top-0 flex items-center justify-center w-6 h-6 rounded-full border text-[11px] font-bold ${PILL[state]}`}>
        {state === "done" ? "✓" : n}
      </span>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${PILL[state]}`}>{hint}</span>
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

const Btn = ({ onClick, children, tone = "slate", disabled }: Readonly<{ onClick: () => void; children: React.ReactNode; tone?: "slate" | "emerald" | "red" | "amber"; disabled?: boolean }>) => {
  const tones: Record<string, string> = {
    slate: "bg-slate-800 hover:bg-slate-900 text-white",
    emerald: "bg-emerald-600 hover:bg-emerald-700 text-white",
    red: "bg-white border border-red-200 text-red-700 hover:bg-red-50",
    amber: "bg-amber-500 hover:bg-amber-600 text-white",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 ${tones[tone]}`}>
      {children}
    </button>
  );
};

export function StageAPanel({ policyId, onChanged }: Readonly<{ policyId: string; onChanged?: () => void }>) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [offer, setOffer] = useState<CounterOffer | null>(null);
  const [reqs, setReqs] = useState<RequirementItem[]>([]);
  const [checks, setChecks] = useState<ComplianceCheck[]>([]);
  const [bens, setBens] = useState<Beneficiary[]>([]);
  const [docs, setDocs] = useState<PolicyDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, o, rq, c, b, d] = await Promise.all([
        getReadiness(policyId),
        getCounterOffer(policyId).catch(() => null),
        getRequirements(policyId).catch(() => []),
        getCompliance(policyId).catch(() => []),
        getBeneficiaries(policyId).catch(() => ({ beneficiaries: [], total_share: 0 })),
        getPolicyDetail(policyId).then((p) => p.documents).catch(() => []),
      ]);
      setReadiness(r); setOffer(o); setReqs(rq); setChecks(c);
      setBens(b.beneficiaries.length ? b.beneficiaries : []); setDocs(d);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load pre-issuance status");
    }
  }, [policyId]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); onChanged?.(); }
    catch (e: any) { setErr(e?.message ?? "Action failed"); }
    finally { setBusy(false); }
  };

  if (!readiness) {
    return <div className="py-6 flex justify-center"><div className="animate-spin h-5 w-5 rounded-full border-2 border-slate-100 border-t-emerald-500" /></div>;
  }
  const s = readiness.steps;

  const reqState = s.requirements.status === "complete" ? "done"
    : s.requirements.status === "none" ? "idle" : "blocked";
  const compState = s.compliance.status === "clear" ? "done"
    : s.compliance.status === "not_run" ? "idle" : "blocked";
  const benState = s.beneficiaries.status === "valid" ? "done" : "blocked";
  const termState = s.revised_terms.status === "pending" ? "blocked"
    : (s.revised_terms.status === "accepted" || s.revised_terms.status === "not_required") ? "done" : "idle";
  const premState = s.premium.status === "paid" ? "done" : s.premium.status === "pending" ? "current" : "idle";
  const docState = s.documents.status === "ready" ? "done" : "idle";

  const benTotal = Math.round(bens.reduce((a, b) => a + (Number(b.share_pct) || 0), 0) * 100) / 100;

  return (
    <div className="space-y-5">
      {/* Readiness banner */}
      <div className={`rounded-lg border px-3 py-2 text-xs font-semibold ${readiness.ready_to_issue ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
        {readiness.ready_to_issue
          ? "✓ All pre-issuance gates cleared — ready to issue."
          : `${readiness.blockers.length} gate(s) remaining before issuance.`}
      </div>
      {err && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{err}</div>}

      <div className="space-y-5">
        {/* 1 — Revised terms */}
        <StepShell n={1} title="Accept Revised Terms" state={termState}
          hint={s.revised_terms.status.replace("_", " ")}>
          {offer && offer.status === "Pending" ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-2">
              <p className="text-xs text-slate-600">{offer.reason}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-white rounded p-2 border border-slate-100">
                  <p className="text-[10px] uppercase text-slate-400 font-semibold">Original</p>
                  <p className="font-semibold text-slate-700">{fmtPKR(offer.original_premium)}/yr</p>
                  <p className="text-slate-500">{fmtPKR(offer.original_coverage_amount)} cover</p>
                </div>
                <div className="bg-white rounded p-2 border border-emerald-200">
                  <p className="text-[10px] uppercase text-emerald-500 font-semibold">Revised</p>
                  <p className="font-semibold text-slate-800">{fmtPKR(offer.revised_premium)}/yr</p>
                  <p className="text-slate-500">
                    {offer.offer_type === "Loading" && `+${offer.revised_loading_pct}% loading`}
                    {offer.offer_type === "ReducedSumAssured" && `${fmtPKR(offer.revised_coverage_amount)} cover`}
                    {offer.offer_type === "PlanSubstitution" && offer.revised_product_name}
                    {offer.offer_type === "Exclusion" && (offer.exclusions?.join(", ") ?? "exclusions")}
                  </p>
                </div>
              </div>
              <p className="text-[10px] text-slate-400">Valid until {offer.valid_until}</p>
              <div className="flex gap-2">
                <Btn tone="emerald" disabled={busy} onClick={() => run(() => acceptCounterOffer(policyId))}>Accept terms</Btn>
                <Btn tone="red" disabled={busy} onClick={() => run(() => declineCounterOffer(policyId))}>Decline</Btn>
              </div>
            </div>
          ) : offer ? (
            <p className="text-xs text-slate-500">Counter-offer <b>{offer.status.toLowerCase()}</b>{offer.responded_at ? ` on ${offer.responded_at.slice(0, 10)}` : ""}.</p>
          ) : (
            <p className="text-xs text-slate-400 italic">Clean approval — no revised terms to accept.</p>
          )}
        </StepShell>

        {/* 2 — Requirements */}
        <StepShell n={2} title="Clear Pending Requirements" state={reqState}
          hint={reqs.length ? `${s.requirements.cleared}/${s.requirements.total}` : "none"}>
          {reqs.length === 0 ? (
            <Btn disabled={busy} onClick={() => run(() => seedRequirements(policyId))}>Create requirement checklist</Btn>
          ) : (
            <div className="space-y-1.5">
              {reqs.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 bg-slate-50 rounded-md px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-700 truncate">{r.label}</p>
                    <p className="text-[10px] text-slate-400">{r.status}</p>
                  </div>
                  {r.status !== "Verified" && r.status !== "Waived" && (
                    <div className="flex gap-1.5 flex-shrink-0">
                      <Btn tone="emerald" disabled={busy} onClick={() => run(() => actOnRequirement(r.id, "verify", "officer"))}>Verify</Btn>
                      <Btn tone="slate" disabled={busy} onClick={() => run(() => actOnRequirement(r.id, "waive", "officer"))}>Waive</Btn>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </StepShell>

        {/* 3 — First premium */}
        <StepShell n={3} title="Collect First Premium" state={premState}
          hint={s.premium.status}>
          <p className="text-xs text-slate-400 italic">
            {s.premium.status === "none"
              ? "Created when the policy is drafted; collected via Confirm Payment after issuance."
              : `${s.premium.paid}/${s.premium.total} installment(s) paid.`}
          </p>
        </StepShell>

        {/* 4 — Compliance */}
        <StepShell n={4} title="Compliance Checks" state={compState} hint={s.compliance.status.replace("_", " ")}>
          <div className="space-y-1.5">
            {checks.length === 0 ? (
              <Btn disabled={busy} onClick={() => run(() => runCompliance(policyId))}>Run AML / Sanctions / SECP</Btn>
            ) : (
              <>
                {checks.map((c) => {
                  const tone = c.status === "Passed" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                    : c.status === "Flagged" ? "text-amber-700 bg-amber-50 border-amber-200"
                    : c.status === "Failed" ? "text-red-700 bg-red-50 border-red-200" : "text-slate-500 bg-slate-50 border-slate-200";
                  return (
                    <div key={c.id} className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 bg-slate-50">
                      <div>
                        <p className="text-xs font-medium text-slate-700">{c.check_type}
                          <span className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${tone}`}>{c.status}</span>
                        </p>
                        {c.score != null && <p className="text-[10px] text-slate-400">score {c.score}</p>}
                      </div>
                      {c.status === "Flagged" && (
                        <Btn tone="amber" disabled={busy} onClick={() => run(() => clearCompliance(c.id, "Cleared after review", "officer"))}>Clear flag</Btn>
                      )}
                    </div>
                  );
                })}
                <button onClick={() => run(() => runCompliance(policyId))} disabled={busy}
                  className="text-[11px] text-slate-500 hover:text-slate-700 underline">Re-run screening</button>
              </>
            )}
          </div>
        </StepShell>

        {/* 5 — Beneficiaries */}
        <StepShell n={5} title="Capture Beneficiaries" state={benState}
          hint={bens.length ? `${benTotal}%` : "none"}>
          <div className="space-y-1.5">
            {bens.map((b, i) => (
              <div key={i} className="flex gap-1.5 items-center">
                <input value={b.name} placeholder="Name"
                  onChange={(e) => setBens((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  className="flex-1 min-w-0 text-xs border border-slate-200 rounded px-2 py-1" />
                <input value={b.relationship} placeholder="Relation"
                  onChange={(e) => setBens((p) => p.map((x, j) => j === i ? { ...x, relationship: e.target.value } : x))}
                  className="w-20 text-xs border border-slate-200 rounded px-2 py-1" />
                <input type="number" value={b.share_pct === 0 ? "" : b.share_pct}
                  onChange={(e) => setBens((p) => p.map((x, j) => j === i ? { ...x, share_pct: e.target.value === "" ? 0 : Number(e.target.value) } : x))}
                  className="w-14 text-xs border border-slate-200 rounded px-2 py-1" />
                <button onClick={() => setBens((p) => p.filter((_, j) => j !== i))}
                  className="text-slate-300 hover:text-red-500 text-sm px-1">×</button>
              </div>
            ))}
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => setBens((p) => [...p, { name: "", relationship: "", share_pct: 0 }])}
                className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold">+ Add beneficiary</button>
              <span className={`text-[11px] font-semibold ${Math.abs(benTotal - 100) < 0.01 ? "text-emerald-600" : "text-amber-600"}`}>Σ {benTotal}%</span>
            </div>
            <div className="flex items-center gap-2">
              <Btn tone="emerald" disabled={busy || Math.abs(benTotal - 100) > 0.01 || bens.some((b) => !b.name || !b.relationship)}
                onClick={() => run(() => replaceBeneficiaries(policyId, bens))}>Save beneficiaries</Btn>
              {Math.abs(benTotal - 100) > 0.01 && bens.length > 0 && (
                <span className="text-[10px] text-amber-600">Total share must equal 100% to save</span>
              )}
            </div>
          </div>
        </StepShell>

        {/* 6 — Documents */}
        <StepShell n={6} title="Generate & Validate Documents" state={docState}
          hint={docs.length ? `${s.documents.generated}/${s.documents.total}` : "none"}>
          <div className="space-y-1.5">
            {docs.length === 0 ? (
              <p className="text-xs text-slate-400 italic">Generated automatically when the policy is issued.</p>
            ) : (
              docs.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 bg-slate-50 rounded-md px-2.5 py-1.5">
                  <p className="text-xs font-medium text-slate-700 truncate">{d.document_name}</p>
                  {d.is_stub ? (
                    <span className="text-[10px] text-amber-600 font-semibold">stub</span>
                  ) : (
                    <a href={documentDownloadUrl(policyId, d.id)} target="_blank" rel="noreferrer"
                      className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-700">Download PDF</a>
                  )}
                </div>
              ))
            )}
            {docs.length > 0 && (
              <button onClick={() => run(() => generateDocuments(policyId))} disabled={busy}
                className="text-[11px] text-slate-500 hover:text-slate-700 underline">Regenerate documents</button>
            )}
          </div>
        </StepShell>
      </div>
    </div>
  );
}
