"use client";

// Plan Selection — the stage between a lead and a proposal. A lead sent here with "Select Plan" waits for a plan,
// cover and term to be chosen; "Send Draft" then turns it into a proposal and takes you to Proposals.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";
import { listCustomers } from "@/app/services/customers";
import { InsurancePlan, listInsurancePlans } from "@/app/services/insurancePlans";
import { getPlanValidationError, type Customer } from "@/components/entities/customerShared";
import { sendLeadToDraft } from "@/lib/sendToDraft";
import { portalUrl } from "@/lib/appLinks";
import { tx } from "@/lib/i18n/tx";

const money = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const label = "block text-xs font-semibold text-slate-600 mb-1";
const field = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

export default function PlanSelectionBoard() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const [leads, setLeads] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editing, setEditing] = useState<Customer | null>(null);
  const [planId, setPlanId] = useState("");
  const [coverage, setCoverage] = useState("");
  const [term, setTerm] = useState("");
  const [depName, setDepName] = useState("");
  const [depDob, setDepDob] = useState("");
  const [formError, setFormError] = useState("");
  const [links, setLinks] = useState<Record<string, { copied: boolean }>>({});
  const [docs, setDocs] = useState<Record<string, { received: number; total: number; all: boolean }>>({});

  // Document progress for every lead that has a plan, refreshed while the page is open so the status follows the
  // customer's uploads.
  useEffect(() => {
    if (!tenantId) return;
    const withPlan = leads.filter((c) => c.details?.plan_policy_id);
    if (withPlan.length === 0) return;
    let alive = true;
    const refresh = async () => {
      const rows = await Promise.all(withPlan.map(async (c) => {
        try {
          const { data } = await api.get(`/tenants/${tenantId}/customers/${c.id}/policies/${c.details.plan_policy_id}/document-request`);
          return [c.id, { received: data.received, total: data.total, all: data.all_received || data.total === 0 }] as const;
        } catch {
          return null;
        }
      }));
      if (alive) setDocs((prev) => ({ ...prev, ...Object.fromEntries(rows.filter((r) => r !== null) as any) }));
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [leads, tenantId]);

  const load = useCallback(async (tid: string) => {
    setLoading(true);
    try {
      const [full, quick, all] = await Promise.all([
        listCustomers<Customer>(tid, { category: "full_details" }),
        listCustomers<Customer>(tid, { category: "quick_lead" }),
        listInsurancePlans(tid),
      ]);
      const seen = new Set<string>();
      setLeads([...full, ...quick].filter((c) => c.details?.in_plan_selection && !seen.has(c.id) && seen.add(c.id)));
      setPlans(all.filter((p) => p.status === "Active" && p.category === "Individual"));
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? tx("Could not load leads."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const tid = localStorage.getItem("tenant_id") ?? "";
    setTenantId(tid);
    if (tid) load(tid);
  }, [load]);

  const plan = plans.find((p) => p.id === planId) ?? null;
  const isChild = plan?.insurance_type === "CHILD_EDUCATION_MARRIAGE";
  const validation = plan && editing
    ? getPlanValidationError(plan, coverage, term, editing.declared_income, editing.dob, depName, depDob)
    : null;

  const openPicker = (c: Customer) => {
    const pending = c.details?.pending_plan;
    const match = pending ? plans.find((p) => p.label === pending.product_name) : null;
    setEditing(c);
    setPlanId(match?.id ?? "");
    setCoverage(pending ? String(pending.coverage_amount) : "");
    setTerm(pending ? String(pending.term_years) : "");
    setDepName(pending?.dependent_name ?? "");
    setDepDob(pending?.dependent_dob ?? "");
    setFormError("");
  };

  const choosePlan = (id: string) => {
    setPlanId(id);
    const p = plans.find((x) => x.id === id);
    if (p) {
      const t = Number(term);
      if (!t || t < p.term_min_years || t > p.term_max_years) setTerm(String(p.term_min_years));
    }
  };

  const savePlan = async () => {
    if (!editing || !plan || validation) return;
    setBusyId(editing.id);
    setFormError("");
    try {
      const pending: any = {
        product_name: plan.label,
        insurance_type: plan.insurance_type,
        coverage_amount: Number(coverage),
        term_years: Number(term),
      };
      if (isChild) {
        pending.dependent_name = depName.trim() || null;
        pending.dependent_dob = depDob || null;
      }
      // The proposal is created now, so the customer can be sent the link for the plan's documents straight away.
      // Changing the plan later updates the same proposal, and its document list follows.
      const policyBase = `/tenants/${tenantId}/customers/${editing.id}/policies`;
      let policyId: string | undefined = editing.details?.plan_policy_id;
      if (policyId) {
        await api.put(`${policyBase}/${policyId}`, pending);
      } else {
        policyId = (await api.post(policyBase, pending)).data.id as string;
      }
      await api.put(`/tenants/${tenantId}/customers/${editing.id}`, {
        details: { ...(editing.details || {}), pending_plan: pending, plan_policy_id: policyId },
      });
      setEditing(null);
      await load(tenantId);
    } catch (e: any) {
      setFormError(e?.response?.data?.detail ?? tx("Could not save the plan."));
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (c: Customer) => {
    const policyId = c.details?.plan_policy_id;
    if (!policyId) return;
    setError("");
    try {
      const { data } = await api.get(`/tenants/${tenantId}/customers/${c.id}/policies/${policyId}/document-request`);
      const url = portalUrl(data.link_path);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const box = document.createElement("textarea");
        box.value = url;
        document.body.appendChild(box);
        box.select();
        document.execCommand("copy");
        box.remove();
      }
      setLinks((prev) => ({ ...prev, [c.id]: { copied: true } }));
      window.setTimeout(() => setLinks((prev) => ({ ...prev, [c.id]: { ...prev[c.id], copied: false } })), 2500);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? tx("Could not get the document link."));
    }
  };

  const sendDraft = async (c: Customer) => {
    setBusyId(c.id);
    setError("");
    try {
      // sendLeadToDraft drops pending_plan from the details, and the stage flag goes with it.
      await sendLeadToDraft("INDIVIDUAL", c.id, c.name, { clear: ["in_plan_selection", "plan_policy_id"] });
      router.push("/proposal");
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? tx("Failed to send draft."));
      setBusyId(null);
    }
  };

  const backToLeads = async (c: Customer) => {
    setBusyId(c.id);
    try {
      const { in_plan_selection, pending_plan, plan_policy_id, ...rest } = c.details || {};
      if (plan_policy_id) await api.delete(`/tenants/${tenantId}/customers/${c.id}/policies/${plan_policy_id}`);
      await api.put(`/tenants/${tenantId}/customers/${c.id}`, { details: rest });
      await load(tenantId);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? tx("Failed to update."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        {tx("Leads sent here are waiting for a plan. Choose the plan, cover and term, then send the lead to Proposals as a draft.")}
      </p>
      {error && <p role="alert" className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-800">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">{tx("Lead")}</th>
              <th className="px-4 py-3">{tx("CNIC")}</th>
              <th className="px-4 py-3">{tx("Plan")}</th>
              <th className="px-4 py-3">{tx("Status")}</th>
              <th className="px-4 py-3 text-right">{tx("Actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">{tx("Loading…")}</td></tr>
            ) : leads.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">{tx("No leads are waiting for a plan. Use “Select Plan” on the Leads page to send one here.")}</td></tr>
            ) : (
              leads.map((c) => {
                const pending = c.details?.pending_plan;
                const busy = busyId === c.id;
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-3 font-semibold text-slate-900">{c.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.cnic ?? "—"}</td>
                    <td className="px-4 py-3">
                      {pending ? (
                        <>
                          <p className="font-semibold text-slate-800">{pending.product_name}</p>
                          <p className="text-xs text-slate-500">{money(pending.coverage_amount)} · {pending.term_years} {tx("yrs")}</p>
                          {docs[c.id] && (
                            <p className="text-xs text-blue-600">{tx("{0} of {1} documents received", { 0: docs[c.id].received, 1: docs[c.id].total })}</p>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-400">{tx("Not selected")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const d = docs[c.id];
                        const [text, cls] = !pending
                          ? [tx("Awaiting plan"), "border-slate-300 bg-white text-slate-600"]
                          : d?.all
                            ? [tx("Documents submitted"), "border-blue-600 bg-blue-600 text-white"]
                            : [tx("Awaiting documents"), "border-blue-200 bg-blue-50 text-blue-700"];
                        return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{text}</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button disabled={busy} onClick={() => openPicker(c)}
                          className="rounded-md border border-blue-600 px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-40">
                          {pending ? tx("Change plan") : tx("Select plan")}
                        </button>
                        {pending && !docs[c.id]?.all && (
                          <button disabled={busy} onClick={() => copyLink(c)}
                            title={tx("Copy the link the customer uses to upload the documents this plan needs")}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                            {links[c.id]?.copied ? tx("Link copied") : tx("Copy document link")}
                          </button>
                        )}
                        <button disabled={busy || !pending} onClick={() => sendDraft(c)}
                          title={pending ? undefined : tx("Select a plan first")}
                          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
                          {tx("Send Draft")}
                        </button>
                        <button disabled={busy} onClick={() => backToLeads(c)}
                          className="px-2 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40">
                          {tx("Back to Leads")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="bg-blue-600 px-5 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-white/80">{editing.name}</p>
              <h2 className="text-lg font-bold text-white">{tx("Select plan")}</h2>
            </div>
            <div className="space-y-3 p-5">
              <div>
                <label className={label}>{tx("Plan")}</label>
                <select className={field} value={planId} onChange={(e) => choosePlan(e.target.value)}>
                  <option value="">{tx("Select a plan")}</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              {plan && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={label}>{tx("Coverage amount (PKR)")}</label>
                      <input type="number" className={field} value={coverage} onChange={(e) => setCoverage(e.target.value)} />
                    </div>
                    <div>
                      <label className={label}>{tx("Term (years)")}</label>
                      <input type="number" className={field} value={term} onChange={(e) => setTerm(e.target.value)} />
                      <p className="mt-0.5 text-[11px] text-slate-400">{plan.term_min_years}–{plan.term_max_years} {tx("yrs")}</p>
                    </div>
                  </div>
                  {isChild && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={label}>{tx("Child's name")}</label>
                        <input className={field} value={depName} onChange={(e) => setDepName(e.target.value)} />
                      </div>
                      <div>
                        <label className={label}>{tx("Child's date of birth")}</label>
                        <input type="date" className={field} value={depDob} onChange={(e) => setDepDob(e.target.value)} />
                      </div>
                    </div>
                  )}
                  {validation && <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{validation}</p>}
                </>
              )}
              {formError && <p role="alert" className="text-xs text-slate-800">{formError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">{tx("Cancel")}</button>
              <button onClick={savePlan} disabled={!plan || !!validation || busyId === editing.id}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                {tx("Save plan")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
