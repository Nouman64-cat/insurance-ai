"use client";

import { useEffect, useMemo, useState } from "react";
import api from "@/app/services/api";

interface InsurancePlan {
  id: string; label: string; insurance_type: string; category: string; status: string;
  entry_age_min: number; entry_age_max: number; term_min_years: number; term_max_years: number;
  max_maturity_age: number; max_income_multiple: number;
}
import ModalPortal from "@/components/ModalPortal";
import { tx } from "@/lib/i18n/tx";

// Change the plan on a proposal that is already in pre-underwriting. Step 1 picks the plan, cover and term; step 2
// shows exactly what the change will redo and keep (a dry run on the server) and asks for a reason before applying.

interface Impact {
  plan: { from: string; to: string };
  coverage: { from: number; to: number };
  term: { from: number; to: number };
  premium: { from: number | null; to: number | null };
  documents: { added: string[]; removed: string[]; kept: string[] };
  resets: { label: string; detail: string }[];
  keeps: string[];
  review: { label: string; detail: string }[];
}

interface Props {
  tenantId: string;
  caseId: string;
  policy: { product_name: string; coverage_amount: number; term_years: number; dependent_name: string | null; dependent_dob: string | null };
  customer: { dob: string; declared_income: number } | null;
  onClose: () => void;
  onDone: (message: string) => void;
}

const money = (n: number | null | undefined) => (n == null ? "—" : `PKR ${Math.round(n).toLocaleString()}`);
const label = "text-[11px] font-semibold text-slate-500 uppercase tracking-wide";
const input = "mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2";

// The same checks the server makes, so mistakes show before the impact preview.
function planError(
  plan: InsurancePlan, coverage: string, term: string,
  income: number | null | undefined, dob: string | null | undefined, depName: string,
): string | null {
  const cov = Number(coverage);
  const yrs = Number(term);
  if (!cov || cov <= 0) return tx("Please enter a coverage amount greater than PKR 0.");
  if (!yrs || yrs < plan.term_min_years || yrs > plan.term_max_years)
    return tx("The term must be between {0} and {1} years.", { 0: plan.term_min_years, 1: plan.term_max_years });
  if (income && plan.max_income_multiple && cov > income * plan.max_income_multiple)
    return tx("Coverage is above {0}× the declared annual income (PKR {1}).", { 0: plan.max_income_multiple, 1: Math.round(income * plan.max_income_multiple).toLocaleString() });
  if (dob) {
    const age = Math.floor((Date.now() - new Date(dob).getTime()) / 31_557_600_000);
    if (age < plan.entry_age_min || age > plan.entry_age_max)
      return tx("The customer's age ({0}) is outside this plan's entry ages ({1}–{2}).", { 0: age, 1: plan.entry_age_min, 2: plan.entry_age_max });
    if (age + yrs > plan.max_maturity_age)
      return tx("The policy would mature at age {0}, above this plan's maximum of {1}.", { 0: age + yrs, 1: plan.max_maturity_age });
  }
  if (plan.insurance_type === "CHILD_EDUCATION_MARRIAGE" && !depName.trim()) return tx("This plan needs the child's name.");
  return null;
}

function Change({ title, from, to }: { title: string; from: string; to: string }) {
  const same = from === to;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-slate-500">{title}</span>
      <span className={same ? "text-slate-700" : "font-semibold text-slate-900"}>
        {same ? to : <>{from} <span className="text-blue-600">→</span> {to}</>}
      </span>
    </div>
  );
}

function Group({ title, items }: { title: string; items: { label: string; detail?: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">{title}</p>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-sm font-semibold text-slate-800">{i.label}</p>
            {i.detail && <p className="text-xs text-slate-500 mt-0.5">{i.detail}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChangePlanModal({ tenantId, caseId, policy, customer, onClose, onDone }: Props) {
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [planId, setPlanId] = useState("");
  const [coverage, setCoverage] = useState<string>(String(policy.coverage_amount));
  const [term, setTerm] = useState<string>(String(policy.term_years));
  const [depName, setDepName] = useState(policy.dependent_name ?? "");
  const [depDob, setDepDob] = useState(policy.dependent_dob ?? "");
  const [reason, setReason] = useState("");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const all = (await api.get<InsurancePlan[]>(`/tenants/${tenantId}/insurance-plans`)).data;
        setPlans(all.filter((p) => p.status === "Active" && p.category === "Individual"));
      } catch {
        setErr(tx("Could not load the plans."));
      } finally {
        setLoading(false);
      }
    })();
  }, [tenantId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const plan = useMemo(() => plans.find((p) => p.id === planId) ?? null, [plans, planId]);
  const isChild = plan?.insurance_type === "CHILD_EDUCATION_MARRIAGE";
  const validation = plan
    ? planError(plan, coverage, term, customer?.declared_income, customer?.dob, depName)
    : null;

  const choose = (id: string) => {
    setPlanId(id);
    setImpact(null);
    setErr(null);
    const p = plans.find((x) => x.id === id);
    if (p) {
      const t = Number(term);
      if (!t || t < p.term_min_years || t > p.term_max_years) setTerm(String(p.term_min_years));
    }
  };

  const body = (extra: object) => ({
    plan_id: planId,
    coverage_amount: Number(coverage),
    term_years: Number(term),
    dependent_name: isChild ? depName.trim() || null : null,
    dependent_dob: isChild ? depDob || null : null,
    ...extra,
  });

  const detailOf = (e: any) => {
    const d = e?.response?.data?.detail;
    return typeof d === "string" ? d : tx("Something went wrong. Please try again.");
  };

  const preview = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<Impact>(`/tenants/${tenantId}/cases/${caseId}/change-plan`, body({ dry_run: true }));
      setImpact(res.data);
    } catch (e: any) {
      setErr(detailOf(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/tenants/${tenantId}/cases/${caseId}/change-plan`, body({ dry_run: false, reason: reason.trim() }));
      onDone(tx("Plan changed to {0}. Steps that depended on the old plan were reset.", { 0: plan?.label ?? "" }));
    } catch (e: any) {
      setErr(detailOf(e));
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => !busy && onClose()}>
        <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="bg-blue-600 px-5 py-3 flex-shrink-0">
            <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">{impact ? tx("Step 2 of 2 · Review impact") : tx("Step 1 of 2 · Choose plan")}</p>
            <h2 className="text-white text-lg font-bold">{tx("Change plan")}</h2>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto">
            {!impact ? (
              <>
                <p className="text-sm text-slate-600">
                  {tx("Currently")}: <span className="font-semibold text-slate-800">{policy.product_name}</span> · {money(policy.coverage_amount)} · {policy.term_years} {tx("yrs")}
                </p>
                <div>
                  <label className={label}>{tx("New plan")}</label>
                  <select className={input} value={planId} disabled={loading} onChange={(e) => choose(e.target.value)}>
                    <option value="">{loading ? tx("Loading…") : tx("Select a plan")}</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                {plan && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={label}>{tx("Coverage amount (PKR)")}</label>
                        <input type="number" className={input} value={coverage} onChange={(e) => { setCoverage(e.target.value); setImpact(null); }} />
                      </div>
                      <div>
                        <label className={label}>{tx("Term (years)")}</label>
                        <input type="number" className={input} value={term} min={plan.term_min_years} max={plan.term_max_years} onChange={(e) => { setTerm(e.target.value); setImpact(null); }} />
                        <p className="text-[11px] text-slate-400 mt-0.5">{plan.term_min_years}–{plan.term_max_years} {tx("yrs")}</p>
                      </div>
                    </div>
                    {isChild && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={label}>{tx("Child's name")}</label>
                          <input className={input} value={depName} onChange={(e) => setDepName(e.target.value)} />
                        </div>
                        <div>
                          <label className={label}>{tx("Child's date of birth")}</label>
                          <input type="date" className={input} value={depDob} onChange={(e) => setDepDob(e.target.value)} />
                        </div>
                      </div>
                    )}
                    {validation && <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">{validation}</p>}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-2 divide-y divide-blue-100">
                  <Change title={tx("Plan")} from={impact.plan.from} to={impact.plan.to} />
                  <Change title={tx("Coverage")} from={money(impact.coverage.from)} to={money(impact.coverage.to)} />
                  <Change title={tx("Term")} from={`${impact.term.from} ${tx("yrs")}`} to={`${impact.term.to} ${tx("yrs")}`} />
                  <Change title={tx("Annual premium")} from={money(impact.premium.from)} to={money(impact.premium.to)} />
                </div>
                <Group title={tx("Documents to collect")} items={impact.documents.added.map((d) => ({ label: d, detail: tx("New for this plan") }))} />
                <Group title={tx("Documents no longer needed")} items={impact.documents.removed.map((d) => ({ label: d }))} />
                <Group title={tx("Will be redone on the new plan")} items={impact.resets.map((r) => ({ label: tx(r.label), detail: tx(r.detail) }))} />
                <Group title={tx("Needs your attention")} items={impact.review.map((r) => ({ label: tx(r.label), detail: tx(r.detail) }))} />
                <div>
                  <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1.5">{tx("Stays as it is")}</p>
                  <p className="text-sm text-slate-600">{impact.keeps.map((k) => tx(k)).join(" · ")}</p>
                </div>
                <div>
                  <label className={label}>{tx("Reason for the change")}</label>
                  <textarea className={input} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tx("e.g. Customer asked for a lower premium")} />
                  <p className="text-[11px] text-slate-400 mt-0.5">{tx("Kept in the case audit trail.")}</p>
                </div>
              </>
            )}
            {err && <p role="alert" className="text-xs text-slate-800 bg-slate-100 border border-slate-300 rounded-lg px-3 py-2">{err}</p>}
          </div>

          <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 flex-shrink-0">
            {impact ? (
              <button onClick={() => { setImpact(null); setErr(null); }} disabled={busy} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40">{tx("Back")}</button>
            ) : (
              <button onClick={onClose} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">{tx("Cancel")}</button>
            )}
            {impact ? (
              <button onClick={apply} disabled={busy || reason.trim().length < 5}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
                {busy ? tx("Changing…") : tx("Change plan")}
              </button>
            ) : (
              <button onClick={preview} disabled={busy || !plan || !!validation}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
                {busy ? tx("Checking…") : tx("Review impact")}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
