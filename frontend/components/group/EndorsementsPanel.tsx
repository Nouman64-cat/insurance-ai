"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/app/services/api";
import { Pagination, usePagination } from "@/components/Pagination";
import { Chip, Endorsement, GroupMember, PanelProps, downloadPdf, errMsg, mpBase, pkr, premiumWord, signedPkr } from "./groupShared";

type Kind = "ADD" | "DELETE" | "CHANGE";
const KIND_LABEL: Record<Kind, string> = { ADD: "Add members", DELETE: "Remove members", CHANGE: "Change a member" };
const BLANK_ROW = { name: "", cnic: "", dob: "", gender: "Male", occupation: "", declared_income: "", grade: "", benefit_class: "" };

const clamp = (d: string, lo: string, hi?: string | null) => (d < lo ? lo : hi && d > hi ? hi : d);

export default function EndorsementsPanel({ tenantId, orgId, mp, reload }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const word = premiumWord(mp.business_type);
  const live = mp.status === "Active";
  const [items, setItems] = useState<Endorsement[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [settleRef, setSettleRef] = useState("");

  // New-endorsement form
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<Kind>("ADD");
  const today = new Date().toISOString().slice(0, 10);
  const [effective, setEffective] = useState(clamp(today, mp.effective_date, mp.expiry_date));
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [quick, setQuick] = useState({ ...BLANK_ROW });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [change, setChange] = useState({ salary: "", grade: "", designation: "", benefit_class: "" });
  const [preview, setPreview] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await api.get<Endorsement[]>(`${base}/endorsements`)).data);
      setMembers((await api.get<GroupMember[]>(`${base}/members`)).data.filter((m) => m.status !== "Removed"));
    } catch (e: any) { setError(errMsg(e, "Could not load the endorsements.")); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { if (live) load(); else setLoading(false); }, [load, live]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(errMsg(e, `Could not ${label.toLowerCase()}.`)); } finally { setBusy(""); }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? members.filter((m) => [m.name, m.cnic, m.employee_id].some((v) => (v ?? "").toLowerCase().includes(q))) : members;
  }, [members, search]);
  const { pageItems, pagination } = usePagination(filtered, 8);

  const body = () => {
    let list: Record<string, any>[];
    if (kind === "ADD") list = rows;
    else if (kind === "DELETE") list = Array.from(picked).map((id) => ({ member_id: id }));
    else {
      const id = Array.from(picked)[0];
      list = id ? [{
        member_id: id,
        ...(change.salary ? { basic_monthly_salary: parseFloat(change.salary) } : {}),
        ...(change.grade ? { grade: change.grade } : {}),
        ...(change.designation ? { designation: change.designation } : {}),
        ...(change.benefit_class ? { benefit_class: change.benefit_class } : {}),
      }] : [];
    }
    return { endorsement_type: kind, effective_date: effective, reason: reason.trim() || undefined, members: list };
  };

  const reset = () => { setCreating(false); setPreview(null); setRows([]); setPicked(new Set()); setChange({ salary: "", grade: "", designation: "", benefit_class: "" }); setReason(""); };
  const doPreview = () => run("Preview", async () => { setPreview((await api.post(`${base}/endorsements/preview`, body())).data); });
  const apply = () => run("Apply", async () => {
    const res = await api.post<Endorsement>(`${base}/endorsements`, body());
    setNotice(`Endorsement ${res.data.number} applied.`);
    reset(); await load(); await reload();
  });

  const onFile = (f: File) => run("Read file", async () => {
    const form = new FormData(); form.append("file", f);
    const res = await api.post(`${base}/census/parse`, form, { headers: { "Content-Type": "multipart/form-data" } });
    setRows((r) => [...r, ...res.data.rows]); setPreview(null);
    if (file.current) file.current.value = "";
  });
  const addQuick = () => {
    const r: Record<string, any> = { ...quick, declared_income: parseFloat(quick.declared_income) || 0 };
    Object.keys(r).forEach((k) => r[k] === "" && delete r[k]);
    setRows((p) => [...p, r]); setQuick({ ...BLANK_ROW }); setPreview(null);
  };
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(kind === "CHANGE" ? [] : p);
    if (p.has(id)) n.delete(id); else n.add(id);
    return n; });

  const resolve = (e: Endorsement) => run("Re-check", async () => { await api.post(`${base}/endorsements/${e.id}/resolve`); await load(); await reload(); });
  const settle = (e: Endorsement) => run("Settle", async () => {
    await api.post(`${base}/endorsements/${e.id}/settle`, { reference: settleRef.trim(), amount: Math.abs(e.premium_delta) });
    setSettleRef(""); setNotice(`${e.number} settled.`); await load();
  });

  if (!live) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 py-12 px-6 text-center text-sm text-slate-500">
        Endorsements change a scheme that is in force. Until cover starts ({mp.status}), change the census and re-quote instead.
      </div>
    );
  }

  const field = "border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50";
  const ready = kind === "ADD" ? rows.length > 0 : kind === "DELETE" ? picked.size > 0 : picked.size === 1 && Object.values(change).some(Boolean);

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`rounded-xl border p-3 text-sm font-medium ${error ? "bg-red-50 border-red-200 text-red-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>{error || notice}</div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-500">Changes to people, salaries and classes during the cover period — each is priced pro rata and issues a document.</p>
        {!creating && <button onClick={() => setCreating(true)} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">New endorsement</button>}
      </div>

      {creating && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button key={k} onClick={() => { setKind(k); setPicked(new Set()); setPreview(null); }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${kind === k ? "bg-blue-600 text-white border-blue-600" : "text-slate-600 border-slate-200 hover:bg-slate-50"}`}>{KIND_LABEL[k]}</button>
            ))}
            <label className="ml-auto text-xs font-semibold text-slate-600 flex items-center gap-2">Effective
              <input type="date" className={field} value={effective} min={mp.effective_date} max={mp.expiry_date ?? undefined} onChange={(e) => { setEffective(e.target.value); setPreview(null); }} /></label>
          </div>
          <input className={`${field} w-full`} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />

          {kind === "ADD" && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <input ref={file} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
                <button onClick={() => file.current?.click()} className="px-3 py-1.5 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50">Upload CSV / Excel</button>
                <span className="text-xs text-slate-400">or add one person:</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <input className={field} placeholder="Name" value={quick.name} onChange={(e) => setQuick({ ...quick, name: e.target.value })} />
                <input className={field} placeholder="CNIC 35201-1234567-1" value={quick.cnic} onChange={(e) => setQuick({ ...quick, cnic: e.target.value })} />
                <input className={field} type="date" value={quick.dob} onChange={(e) => setQuick({ ...quick, dob: e.target.value })} />
                <select className={field} value={quick.gender} onChange={(e) => setQuick({ ...quick, gender: e.target.value })}><option>Male</option><option>Female</option></select>
                <input className={field} placeholder="Occupation" value={quick.occupation} onChange={(e) => setQuick({ ...quick, occupation: e.target.value })} />
                <input className={field} type="number" placeholder="Annual income" value={quick.declared_income} onChange={(e) => setQuick({ ...quick, declared_income: e.target.value })} />
                <input className={field} placeholder="Grade (optional)" value={quick.grade} onChange={(e) => setQuick({ ...quick, grade: e.target.value })} />
                <button onClick={addQuick} disabled={!quick.name || !quick.cnic || !quick.dob} className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-40 rounded-lg">Add to list</button>
              </div>
              {rows.length > 0 && (
                <p className="text-xs text-slate-600">{rows.length} joiner{rows.length === 1 ? "" : "s"}: {rows.slice(0, 5).map((r) => r.name).join(", ")}{rows.length > 5 ? "…" : ""}
                  <button onClick={() => { setRows([]); setPreview(null); }} className="ml-3 text-red-600 font-semibold">Clear</button></p>
              )}
            </div>
          )}

          {kind !== "ADD" && (
            <div className="space-y-2">
              <input className={`${field} w-72`} placeholder="Search members…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="border border-slate-100 rounded-lg divide-y divide-slate-100">
                {pageItems.map((m) => (
                  <label key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                    <input type={kind === "CHANGE" ? "radio" : "checkbox"} checked={picked.has(m.id)} onChange={() => { toggle(m.id); setPreview(null); }} />
                    <span className="font-semibold text-slate-800">{m.name}</span>
                    <span className="text-xs text-slate-400">{m.benefit_class ?? "Standard"} · {pkr(m.coverage_amount)}{m.certificate_number ? ` · ${m.certificate_number}` : ""}</span>
                  </label>
                ))}
              </div>
              <Pagination pagination={pagination} noun="members" />
              {kind === "CHANGE" && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <input className={field} type="number" placeholder="New monthly salary" value={change.salary} onChange={(e) => { setChange({ ...change, salary: e.target.value }); setPreview(null); }} />
                  <input className={field} placeholder="Grade" value={change.grade} onChange={(e) => { setChange({ ...change, grade: e.target.value }); setPreview(null); }} />
                  <input className={field} placeholder="Designation" value={change.designation} onChange={(e) => setChange({ ...change, designation: e.target.value })} />
                  <input className={field} placeholder="Benefit class" value={change.benefit_class} onChange={(e) => { setChange({ ...change, benefit_class: e.target.value }); setPreview(null); }} />
                </div>
              )}
            </div>
          )}

          {preview && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
              <p className="text-sm font-semibold text-slate-800">What this does</p>
              {preview.lines.map((l: any, i: number) => (
                <p key={i} className="text-xs text-slate-700">
                  <strong>{l.action.toLowerCase()}</strong> {l.name} · {l.action === "CHANGE" ? `${pkr(l.before?.cover)} → ${pkr(l.after?.cover)}` : pkr(l.action === "ADD" ? l.after?.cover : l.before?.cover)}
                  {l.status !== "Applied" && <span className="text-amber-700"> — {l.status === "PendingUnderwriting" ? "waits for an underwriting decision" : l.status}</span>}
                  <span className="text-slate-400"> · {signedPkr(l.risk_delta)}</span>
                </p>
              ))}
              <p className="text-xs text-slate-500">Pro rata: {preview.days_remaining} of {preview.period_days} days · stamp duty {signedPkr(preview.stamp_duty_delta)}</p>
              {preview.wakala_fee_delta != null && <p className="text-xs text-slate-500">Wakala fee {signedPkr(preview.wakala_fee_delta)} · PTF {signedPkr(preview.ptf_delta)}</p>}
              <p className="text-sm font-bold text-slate-900">{preview.premium_delta >= 0 ? `Additional ${word} to collect` : `${word[0].toUpperCase() + word.slice(1)} to refund`}: {pkr(Math.abs(preview.premium_delta))}</p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={reset} className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg">Cancel</button>
            <button onClick={doPreview} disabled={!ready || !!busy} className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50">{busy === "Preview" ? "Pricing…" : "Preview cost"}</button>
            <button onClick={apply} disabled={!ready || !preview || !!busy} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">{busy === "Apply" ? "Applying…" : "Apply endorsement"}</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <p className="px-5 py-3 border-b border-slate-100 bg-slate-50 text-sm font-semibold text-slate-700">History</p>
        {loading ? <div className="py-10 text-center text-sm text-slate-400">Loading…</div>
          : items.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">No endorsements yet.</div>
          : items.map((e) => (
            <div key={e.id} className="border-b border-slate-100 last:border-0">
              <button onClick={() => setOpen(open === e.id ? null : e.id)} className="w-full px-5 py-3 flex items-center gap-4 text-left hover:bg-slate-50">
                <span className="font-mono text-xs text-slate-500 w-44 truncate">{e.number}</span>
                <span className="text-sm font-semibold text-slate-800 w-28">{KIND_LABEL[e.endorsement_type]}</span>
                <span className="text-xs text-slate-500 w-24">{e.effective_date}</span>
                <Chip status={e.status === "Applied" ? "Active" : e.status === "PendingUnderwriting" ? "Pending" : e.status}>{e.status === "PendingUnderwriting" ? "Awaiting underwriting" : e.status}</Chip>
                <span className="ml-auto text-sm tabular-nums font-semibold text-slate-800">{signedPkr(e.premium_delta)}</span>
                <Chip status={e.settlement_status === "Settled" ? "Active" : e.settlement_status === "Due" ? "Pending" : "Guaranteed"}>{e.settlement_status === "NotDue" ? "No money" : e.settlement_status}</Chip>
              </button>
              {open === e.id && (
                <div className="px-5 pb-4 space-y-3 bg-slate-50/50">
                  <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg bg-white">
                    {e.lines.map((l, i) => (
                      <div key={i} className="px-3 py-2 text-xs flex items-center gap-3">
                        <span className="font-semibold w-14">{l.action}</span>
                        <span className="text-slate-800 w-44 truncate">{l.name}</span>
                        <span className="text-slate-500 flex-1">{l.action === "CHANGE" ? `${pkr(l.before?.cover)} → ${pkr(l.after?.cover)}` : pkr(l.action === "ADD" ? l.after?.cover : l.before?.cover)}{l.certificate_number ? ` · ${l.certificate_number}` : ""}{l.note ? ` · ${l.note}` : ""}</span>
                        <Chip status={l.status === "Applied" ? "Active" : l.status === "PendingUnderwriting" ? "Pending" : "Declined"}>{l.status === "PendingUnderwriting" ? "Pending" : l.status}</Chip>
                        <span className="tabular-nums w-24 text-right">{signedPkr(l.risk_delta)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500">Pro rata {e.days_remaining}/{e.period_days} days · stamp duty {signedPkr(e.stamp_duty_delta)}{e.wakala_fee_delta != null ? ` · Wakala ${signedPkr(e.wakala_fee_delta)} · PTF ${signedPkr(e.ptf_delta ?? 0)}` : ""}{e.reason ? ` · ${e.reason}` : ""}</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button onClick={() => run("Download", () => downloadPdf(`${base}/endorsements/${e.id}/document`, `${e.number}.pdf`))} className="text-xs font-semibold text-blue-600 hover:text-blue-800">Download PDF</button>
                    {e.status === "PendingUnderwriting" && <button onClick={() => resolve(e)} disabled={!!busy} className="text-xs font-semibold text-amber-700 hover:text-amber-900">Re-check underwriting</button>}
                    {e.settlement_status === "Due" && (
                      <span className="flex items-center gap-2">
                        <input className={`${field} !py-1 w-44`} placeholder="Bank reference" value={settleRef} onChange={(ev) => setSettleRef(ev.target.value)} />
                        <button onClick={() => settle(e)} disabled={!settleRef.trim() || !!busy} className="px-3 py-1 text-xs font-semibold text-white bg-blue-600 disabled:opacity-50 rounded-lg">{e.premium_delta >= 0 ? "Record collected" : "Record refunded"} {pkr(Math.abs(e.premium_delta))}</button>
                      </span>
                    )}
                    {e.settlement_status === "Settled" && <span className="text-xs text-slate-500">Settled · ref {e.settlement_reference}</span>}
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
