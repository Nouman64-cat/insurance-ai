"use client";

import { useCallback, useEffect, useState } from "react";
import api from "@/app/services/api";
import { BenefitClass, PanelProps, RIDER_LABEL, ServiceBand, basisText, errMsg, mpBase, pkr } from "./groupShared";

type Basis = BenefitClass["basis"];

const EMPTY = { name: "", basis: "Flat" as Basis, flat: "", multiple: "", grades: "", min: "", max: "", isDefault: false };

export default function ClassesPanel({ tenantId, orgId, mp, reload }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const [classes, setClasses] = useState<BenefitClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...EMPTY });
  const [bands, setBands] = useState<{ years: string; amount: string }[]>([{ years: "0", amount: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rider, setRider] = useState<{ classId: string; type: string; pct: string; max: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setClasses((await api.get<BenefitClass[]>(`${base}/benefit-classes`)).data); }
    catch (e: any) { setError(errMsg(e, "Could not load benefit classes.")); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { load(); }, [load]);

  // The backend freezes classes once members exist — changing one would silently change their cover.
  const frozen = !["Pending", "Proposed"].includes(mp.status);
  const set = (k: keyof typeof EMPTY, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setNotice(""); setSaving(true);
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), basis: form.basis, is_default: form.isDefault };
      if (form.basis === "Flat") body.flat_amount = parseFloat(form.flat);
      if (form.basis === "SalaryMultiple") body.salary_multiple = parseFloat(form.multiple);
      if (form.basis === "ServiceBanded") {
        body.service_bands = bands.filter((b) => b.amount).map((b): ServiceBand => ({ min_years: parseInt(b.years) || 0, amount: parseFloat(b.amount) }));
      }
      const grades = form.grades.split(",").map((g) => g.trim()).filter(Boolean);
      if (grades.length) body.grades = grades;
      if (form.min) body.min_cover = parseFloat(form.min);
      if (form.max) body.max_cover = parseFloat(form.max);
      await api.post(`${base}/benefit-classes`, body);
      setNotice(`Added “${form.name.trim()}”.`);
      setForm({ ...EMPTY }); setBands([{ years: "0", amount: "" }]);
      await load(); await reload();
    } catch (e: any) { setError(errMsg(e, "Could not add the class.")); }
    finally { setSaving(false); }
  };

  const remove = async (c: BenefitClass) => {
    if (!confirm(`Delete the “${c.name}” class?`)) return;
    setError(""); setNotice("");
    try { await api.delete(`${base}/benefit-classes/${c.id}`); await load(); await reload(); }
    catch (e: any) { setError(errMsg(e, "Could not delete the class.")); }
  };

  // Extra benefits stay editable until the employer accepts the quote (adding one withdraws an open quote).
  const benefitsLocked = ["Accepted", "PendingPayment", "Active"].includes(mp.status);
  const addRider = async () => {
    if (!rider) return;
    setError(""); setNotice("");
    try {
      await api.post(`${base}/benefit-classes/${rider.classId}/coverages`, {
        coverage_type: rider.type, percent_of_base: parseFloat(rider.pct), max_amount: rider.max ? parseFloat(rider.max) : undefined,
      });
      setNotice(`${RIDER_LABEL[rider.type]} added. Any open quote was withdrawn — generate a new one.`);
      setRider(null); await load(); await reload();
    } catch (e: any) { setError(errMsg(e, "Could not add the benefit.")); }
  };
  const removeRider = async (c: BenefitClass, coverageId: string) => {
    setError(""); setNotice("");
    try { await api.delete(`${base}/benefit-classes/${c.id}/coverages/${coverageId}`); await load(); await reload(); }
    catch (e: any) { setError(errMsg(e, "Could not remove the benefit.")); }
  };

  const input = "w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50";
  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`rounded-xl border p-3 text-sm font-medium ${error ? "bg-red-50 border-red-200 text-red-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>{error || notice}</div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Benefit classes</p>
          <p className="text-xs text-slate-400">Who gets how much cover. Employees match a class by grade, or by name in the census.</p>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-slate-400">Loading…</div>
        ) : classes.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400 px-6">
            No classes — everyone is covered at the scheme&apos;s default {mp.sum_assured_multiple}× monthly salary.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Class</th>
                <th className="px-5 py-3 text-left">Cover</th>
                <th className="px-5 py-3 text-left">Extra benefits</th>
                <th className="px-5 py-3 text-left">Grades</th>
                <th className="px-5 py-3 w-16" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {classes.map((c) => (
                <tr key={c.id}>
                  <td className="px-5 py-3 font-semibold text-slate-800">
                    {c.name}
                    {c.is_default && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-slate-500 border border-slate-200 rounded px-1.5 py-0.5">Default</span>}
                  </td>
                  <td className="px-5 py-3 text-slate-600">{basisText(c)}</td>
                  <td className="px-5 py-3 text-slate-600 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(c.coverages ?? []).filter((v) => v.coverage_type !== "Life").map((v) => (
                        <span key={v.id ?? v.coverage_type} className="inline-flex items-center gap-1 text-[11px] border border-slate-200 rounded px-1.5 py-0.5 text-slate-700">
                          {RIDER_LABEL[v.coverage_type] ?? v.coverage_type} {v.percent_of_base}%{v.max_amount ? ` (max ${pkr(v.max_amount)})` : ""}
                          {!benefitsLocked && v.id && <button onClick={() => removeRider(c, v.id!)} className="text-slate-400 hover:text-red-600" aria-label="Remove benefit">✕</button>}
                        </span>
                      ))}
                      {!benefitsLocked && rider?.classId !== c.id && (
                        <button onClick={() => setRider({ classId: c.id, type: "AccidentalDeath", pct: "100", max: "" })} className="text-[11px] font-semibold text-blue-600 hover:text-blue-800">+ Benefit</button>
                      )}
                    </div>
                    {rider?.classId === c.id && (
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <select className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-slate-50" value={rider.type} onChange={(e) => setRider({ ...rider, type: e.target.value })}>
                          {Object.entries(RIDER_LABEL).filter(([k]) => k !== "Life").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <input type="number" min="1" className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-20 bg-slate-50" value={rider.pct} onChange={(e) => setRider({ ...rider, pct: e.target.value })} aria-label="Percent of life cover" />
                        <span className="text-[11px] text-slate-400">% of life</span>
                        <input type="number" min="1" placeholder="Max PKR" className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-28 bg-slate-50" value={rider.max} onChange={(e) => setRider({ ...rider, max: e.target.value })} />
                        <button onClick={addRider} disabled={!(parseFloat(rider.pct) > 0)} className="text-xs font-semibold text-white bg-blue-600 disabled:opacity-50 rounded px-2 py-1">Add</button>
                        <button onClick={() => setRider(null)} className="text-xs text-slate-400">Cancel</button>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-600 align-top">{c.grades?.length ? c.grades.join(", ") : "—"}</td>
                  <td className="px-5 py-3 text-right">
                    {!frozen && <button onClick={() => remove(c)} className="text-xs font-semibold text-red-600 hover:text-red-800">Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form onSubmit={submit} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        <p className="text-sm font-semibold text-slate-700">Add a class</p>
        {frozen ? (
          <p className="text-xs text-slate-500">Classes are locked once the scheme is quoted — changing one would change members&apos; cover. Use an endorsement instead.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="text-xs font-semibold text-slate-600 space-y-1"><span>Name *</span>
                <input required className={input} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Management" /></label>
              <label className="text-xs font-semibold text-slate-600 space-y-1"><span>Basis *</span>
                <select className={input} value={form.basis} onChange={(e) => set("basis", e.target.value)}>
                  <option value="Flat">Flat amount</option>
                  <option value="SalaryMultiple">Salary multiple</option>
                  <option value="ServiceBanded">By years of service</option>
                  {mp.plan_code === "GROUP_CREDIT_LIFE" && <option value="LoanBalance">Outstanding loan balance</option>}
                </select></label>
              {form.basis === "Flat" && (
                <label className="text-xs font-semibold text-slate-600 space-y-1"><span>Amount (PKR) *</span>
                  <input required type="number" min="1" className={input} value={form.flat} onChange={(e) => set("flat", e.target.value)} /></label>
              )}
              {form.basis === "SalaryMultiple" && (
                <label className="text-xs font-semibold text-slate-600 space-y-1"><span>× monthly salary *</span>
                  <input required type="number" step="0.5" min="1" className={input} value={form.multiple} onChange={(e) => set("multiple", e.target.value)} /></label>
              )}
            </div>
            {form.basis === "LoanBalance" && (
              <p className="text-xs text-slate-500">Each borrower&apos;s cover is their outstanding loan balance, taken from the census&apos;s <code>loan_amount</code> column. Use the maximum cover below to cap it.</p>
            )}
            {form.basis === "ServiceBanded" && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-600">Cover by completed years of service *</p>
                {bands.map((b, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="number" min="0" className={`${input} w-28`} value={b.years} onChange={(e) => setBands((p) => p.map((x, j) => (j === i ? { ...x, years: e.target.value } : x)))} />
                    <span className="text-xs text-slate-500">+ years →</span>
                    <input type="number" min="1" placeholder="PKR" className={`${input} w-44`} value={b.amount} onChange={(e) => setBands((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    {bands.length > 1 && <button type="button" onClick={() => setBands((p) => p.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">Remove</button>}
                  </div>
                ))}
                <button type="button" onClick={() => setBands((p) => [...p, { years: "", amount: "" }])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add band</button>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="text-xs font-semibold text-slate-600 space-y-1"><span>Grades (comma separated)</span>
                <input className={input} value={form.grades} onChange={(e) => set("grades", e.target.value)} placeholder="M1, M2" /></label>
              <label className="text-xs font-semibold text-slate-600 space-y-1"><span>Minimum cover (PKR)</span>
                <input type="number" min="0" className={input} value={form.min} onChange={(e) => set("min", e.target.value)} /></label>
              <label className="text-xs font-semibold text-slate-600 space-y-1"><span>Maximum cover (PKR)</span>
                <input type="number" min="0" className={input} value={form.max} onChange={(e) => set("max", e.target.value)} /></label>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={form.isDefault} onChange={(e) => set("isDefault", e.target.checked)} />
                Default class (employees matching no grade)
              </label>
              <button type="submit" disabled={saving} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg">
                {saving ? "Adding…" : "Add class"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
