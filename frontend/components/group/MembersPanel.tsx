"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/app/services/api";
import { Pagination, usePagination } from "@/components/Pagination";
import CensusUpload from "./CensusUpload";
import { Chip, GroupMember, PanelProps, errMsg, mpBase, pkr } from "./groupShared";

const DEPENDENTS_EDITABLE = ["Pending", "Proposed", "Quoted", "Declined"];

interface Dependent { id: string; name: string; relationship: string; dob?: string | null; covered_amount: number; status: string }
interface Nominee { name: string; relationship: string; share_pct: string; cnic?: string }

export default function MembersPanel(props: PanelProps) {
  const { tenantId, orgId, mp, reload } = props;
  const base = mpBase(tenantId, orgId, mp.id);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<GroupMember | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setMembers((await api.get<GroupMember[]>(`${base}/members`)).data); setError(""); }
    catch (e: any) { setError(errMsg(e, "Could not load the members.")); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { load(); }, [load, mp.status]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? members.filter((m) => [m.name, m.cnic, m.employee_id, m.certificate_number].some((v) => (v ?? "").toLowerCase().includes(q))) : members;
  }, [members, search]);
  const { pageItems, pagination } = usePagination(filtered);

  const pending = members.filter((m) => m.underwriting_basis === "Pending").length;
  const missingNominee = mp.status === "Active" ? members.filter((m) => !m.nominations).length : 0;
  const canLoadCensus = ["Pending", "Proposed", "Quoted", "Declined"].includes(mp.status);

  return (
    <div className="space-y-4">
      {canLoadCensus && <CensusUpload {...props} reload={async () => { await load(); await reload(); }} />}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 font-medium">{error}</div>}
      {pending > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 font-medium">
          {pending} member{pending === 1 ? " is" : "s are"} above the Free Cover Limit and awaiting an underwriting decision — the scheme can&apos;t be quoted until they&apos;re decided.
        </div>
      )}
      {missingNominee > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          {missingNominee} member{missingNominee === 1 ? " has" : "s have"} no nominee recorded yet.
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm font-semibold text-slate-700">Insured members ({members.length})</p>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, CNIC, certificate…"
            className="text-xs border border-slate-200 rounded-lg px-3 py-1.5 w-64 bg-white" />
        </div>
        {loading ? (
          <div className="py-12 text-center text-sm text-slate-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400">{members.length ? "No members match." : "No members yet — upload a census above."}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Member</th>
                  <th className="px-5 py-3 text-left">Class</th>
                  <th className="px-5 py-3 text-right">Cover</th>
                  <th className="px-5 py-3 text-right">Annual share</th>
                  <th className="px-5 py-3 text-left">Underwriting</th>
                  <th className="px-5 py-3 text-left">Certificate</th>
                  <th className="px-5 py-3 text-center">Dep.</th>
                  <th className="px-5 py-3 text-center">Nominee</th>
                  <th className="px-5 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pageItems.map((m) => (
                  <tr key={m.id}>
                    <td className="px-5 py-3"><div className="font-semibold text-slate-800">{m.name}</div><div className="text-xs text-slate-400 font-mono">{m.cnic ?? "—"}</div></td>
                    <td className="px-5 py-3 text-slate-600">{m.benefit_class ?? "Standard"}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-800">{pkr(m.coverage_amount)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-600">{pkr(m.annual_premium)}</td>
                    <td className="px-5 py-3">{m.underwriting_basis ? <Chip status={m.underwriting_basis}>{m.underwriting_basis}</Chip> : "—"}</td>
                    <td className="px-5 py-3 text-xs text-slate-600">{m.certificate_number ? <><span className="font-mono">{m.certificate_number}</span> <Chip status={m.status}>{m.status}</Chip></> : <Chip status={m.status}>{m.status}</Chip>}</td>
                    <td className="px-5 py-3 text-center text-slate-600 tabular-nums">{m.dependents || "—"}</td>
                    <td className="px-5 py-3 text-center">{m.nominations ? <span className="text-emerald-600">✓</span> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-3 text-right"><button onClick={() => setOpen(m)} className="text-xs font-semibold text-blue-600 hover:text-blue-800">Manage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={pagination} noun="members" />
      </div>

      {open && <MemberDrawer {...props} member={open} onClose={() => setOpen(null)} onChanged={async () => { await load(); await reload(); }} />}
    </div>
  );
}

function MemberDrawer({ tenantId, orgId, mp, member, onClose, onChanged }: PanelProps & { member: GroupMember; onClose: () => void; onChanged: () => Promise<void> }) {
  const url = `${mpBase(tenantId, orgId, mp.id)}/members/${member.id}`;
  const [deps, setDeps] = useState<Dependent[]>([]);
  const [nominees, setNominees] = useState<Nominee[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dep, setDep] = useState({ name: "", relationship: "Spouse", dob: "", covered: "" });
  const depEditable = DEPENDENTS_EDITABLE.includes(mp.status);

  const load = useCallback(async () => {
    try {
      setDeps((await api.get<Dependent[]>(`${url}/dependents`)).data);
      const b = (await api.get<any[]>(`${url}/beneficiaries`)).data;
      setNominees(b.map((x) => ({ name: x.name, relationship: x.relationship, share_pct: String(x.share_pct), cnic: x.cnic ?? "" })));
    } catch (e: any) { setError(errMsg(e, "Could not load the member.")); }
  }, [url]);
  useEffect(() => { load(); }, [load]);

  const addDependent = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setNotice("");
    try {
      await api.post(`${url}/dependents`, { name: dep.name.trim(), relationship: dep.relationship, dob: dep.dob, covered_amount: parseFloat(dep.covered) });
      setDep({ name: "", relationship: "Spouse", dob: "", covered: "" });
      await load(); await onChanged();
    } catch (err: any) { setError(errMsg(err, "Could not add the dependant.")); }
  };
  const removeDependent = async (d: Dependent) => {
    setError(""); setNotice("");
    try { await api.delete(`${url}/dependents/${d.id}`); await load(); await onChanged(); }
    catch (err: any) { setError(errMsg(err, "Could not remove the dependant.")); }
  };

  const total = nominees.reduce((s, n) => s + (parseFloat(n.share_pct) || 0), 0);
  const saveNominees = async () => {
    setError(""); setNotice("");
    try {
      await api.put(`${url}/beneficiaries`, {
        beneficiaries: nominees.filter((n) => n.name.trim()).map((n) => ({
          name: n.name.trim(), relationship: n.relationship.trim() || "Other", share_pct: parseFloat(n.share_pct) || 0, cnic: n.cnic || undefined,
        })),
        change_reason: "Updated from the group scheme Members tab",
      });
      setNotice("Nominees saved."); await onChanged();
    } catch (err: any) { setError(errMsg(err, "Could not save the nominees.")); }
  };

  const field = "border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm bg-slate-50";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-2xl p-6 space-y-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-900">{member.name}</h3>
            <p className="text-xs text-slate-500">{member.benefit_class ?? "Standard"} · {pkr(member.coverage_amount)}{member.certificate_number ? ` · ${member.certificate_number}` : ""}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 font-medium">{error}</div>}
        {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 font-medium">{notice}</div>}

        <section className="space-y-3">
          <p className="text-sm font-semibold text-slate-700">Covered dependants</p>
          <p className="text-[11px] text-slate-400">Only people listed here are covered — naming someone as a nominee doesn&apos;t cover them.</p>
          {deps.length === 0 && <p className="text-xs text-slate-400">None.</p>}
          {deps.map((d) => (
            <div key={d.id} className="flex items-center justify-between text-sm border border-slate-100 rounded-lg px-3 py-2">
              <span><strong>{d.name}</strong> · {d.relationship}{d.dob ? ` · b. ${d.dob}` : ""} · {pkr(d.covered_amount)}</span>
              {depEditable && <button onClick={() => removeDependent(d)} className="text-xs font-semibold text-red-600">Remove</button>}
            </div>
          ))}
          {depEditable ? (
            <form onSubmit={addDependent} className="grid grid-cols-2 gap-2">
              <input required className={field} placeholder="Name" value={dep.name} onChange={(e) => setDep({ ...dep, name: e.target.value })} />
              <select className={field} value={dep.relationship} onChange={(e) => setDep({ ...dep, relationship: e.target.value })}>
                <option>Spouse</option><option>Child</option><option>Parent</option>
              </select>
              <input required type="date" className={field} value={dep.dob} onChange={(e) => setDep({ ...dep, dob: e.target.value })} />
              <input required type="number" min="1" className={field} placeholder="Cover (PKR)" value={dep.covered} onChange={(e) => setDep({ ...dep, covered: e.target.value })} />
              <button type="submit" className="col-span-2 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">Add dependant</button>
            </form>
          ) : <p className="text-xs text-slate-400">Dependants are locked once the quote is accepted.</p>}
        </section>

        <section className="space-y-3">
          <p className="text-sm font-semibold text-slate-700">Nominees (death benefit)</p>
          {nominees.map((n, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_5rem_auto] gap-2 items-center">
              <input className={field} placeholder="Name" value={n.name} onChange={(e) => setNominees((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className={field} placeholder="Relationship" value={n.relationship} onChange={(e) => setNominees((p) => p.map((x, j) => (j === i ? { ...x, relationship: e.target.value } : x)))} />
              <input className={field} type="number" min="0" max="100" placeholder="%" value={n.share_pct} onChange={(e) => setNominees((p) => p.map((x, j) => (j === i ? { ...x, share_pct: e.target.value } : x)))} />
              <button onClick={() => setNominees((p) => p.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">✕</button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button onClick={() => setNominees((p) => [...p, { name: "", relationship: "Spouse", share_pct: "" }])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add nominee</button>
            <span className={`text-xs font-semibold ${Math.abs(total - 100) < 0.01 ? "text-emerald-600" : "text-amber-600"}`}>Total {total}%</span>
          </div>
          <button onClick={saveNominees} disabled={nominees.length === 0 || Math.abs(total - 100) > 0.01}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">Save nominees</button>
        </section>
      </div>
    </div>
  );
}
