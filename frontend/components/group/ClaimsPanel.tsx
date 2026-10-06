"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/app/services/api";
import { Pagination, usePagination } from "@/components/Pagination";
import { Chip, GroupClaim, GroupMember, PanelProps, PayoutShare, PayoutSplit, RIDER_LABEL, errMsg, mpBase, pkr } from "./groupShared";

const CLAIM_TYPES = ["Death Claim", "Accidental Death", "Disability", "Pay Continuation", "Fee Continuation"];
const CLOSED = new Set(["Settled", "Declined", "Closed"]);
const claimTone = (s: string) => (s === "Settled" || s === "Approved" ? "Active" : s === "Declined" ? "Declined" : "Pending");

interface Dependent { id: string; name: string; relationship: string }
interface OverrideRow { name: string; share_pct: string; relationship: string; cnic: string; is_minor: boolean; guardian_name: string }

export default function ClaimsPanel({ tenantId, orgId, mp }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const live = ["Active", "PendingPayment"].includes(mp.status) && !!mp.policy_number;
  const [claims, setClaims] = useState<GroupClaim[]>([]);
  const [summary, setSummary] = useState<{ count: number; open: number; submitted: number; approved: number; paid: number } | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  // New claim
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [memberId, setMemberId] = useState("");
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [dependentId, setDependentId] = useState("");
  const [form, setForm] = useState({ claim_type: CLAIM_TYPES[0], amount: "", incident_date: "", notes: "" });

  // Payout
  const [split, setSplit] = useState<PayoutSplit | null>(null);
  const [override, setOverride] = useState<OverrideRow[] | null>(null);
  const [reason, setReason] = useState("");
  const [payRef, setPayRef] = useState("");
  const [confirmNoNominee, setConfirmNoNominee] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`${base}/claims`);
      setClaims(res.data.claims); setSummary(res.data.summary);
      setMembers((await api.get<GroupMember[]>(`${base}/members`)).data.filter((m) => m.status !== "Removed"));
    } catch (e: any) { setError(errMsg(e, "Could not load the claims.")); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { if (live) load(); else setLoading(false); }, [load, live]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(errMsg(e, `Could not ${label.toLowerCase()}.`)); } finally { setBusy(""); }
  };

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (q ? members.filter((m) => [m.name, m.cnic, m.employee_id, m.certificate_number].some((v) => (v ?? "").toLowerCase().includes(q))) : members);
  }, [members, search]);
  const { pageItems, pagination } = usePagination(matches, 6);
  const picked = members.find((m) => m.id === memberId);

  const pick = (m: GroupMember) => run("Load dependants", async () => {
    setMemberId(m.id); setDependentId("");
    setForm((f) => ({ ...f, amount: f.amount || String(m.coverage_amount) }));
    setDependents((await api.get<Dependent[]>(`${base}/members/${m.id}/dependents`)).data);
  });

  const register = () => run("Register", async () => {
    const res = await api.post(`${base}/claims`, {
      member_id: memberId, dependent_id: dependentId || undefined, claim_type: form.claim_type,
      submitted_amount: parseFloat(form.amount), incident_date: form.incident_date || undefined, notes: form.notes.trim() || undefined,
    });
    setNotice(`Claim ${res.data.claim.claim_number} registered.`);
    setCreating(false); setMemberId(""); setDependents([]); setDependentId(""); setForm({ claim_type: CLAIM_TYPES[0], amount: "", incident_date: "", notes: "" });
    await load(); setOpen(res.data.claim.id);
  });

  const toRows = (s: PayoutSplit): OverrideRow[] => s.shares.map((x) => ({
    name: x.payee_name, share_pct: String(x.share_pct), relationship: x.relationship ?? "", cnic: x.cnic ?? "", is_minor: x.is_minor, guardian_name: x.guardian_name ?? "",
  }));
  const overrideBody = () => override ? {
    overrides: override.map((o) => ({ name: o.name, share_pct: parseFloat(o.share_pct) || 0, relationship: o.relationship || undefined, cnic: o.cnic || undefined, is_minor: o.is_minor, guardian_name: o.guardian_name || undefined })),
    override_reason: reason.trim(),
  } : {};

  const toggle = (c: GroupClaim) => {
    if (open === c.id) { setOpen(null); return; }
    setOpen(c.id); setSplit(null); setOverride(null); setReason(""); setPayRef(""); setConfirmNoNominee(false);
  };
  const loadSplit = (c: GroupClaim) => run("Work out the split", async () => {
    const res = await api.get<PayoutSplit>(`/tenants/${tenantId}/claims/${c.id}/payout-split`);
    setSplit(res.data); setOverride(null);
  });
  const previewOverride = (c: GroupClaim) => run("Preview the split", async () => {
    setSplit((await api.post<PayoutSplit>(`/tenants/${tenantId}/claims/${c.id}/payout-split`, overrideBody())).data);
  });
  const pay = (c: GroupClaim) => run("Pay", async () => {
    const res = await api.post(`/tenants/${tenantId}/claims/${c.id}/group-payout`, {
      ...overrideBody(), reference_number: payRef.trim() || undefined, confirm_no_nominee: confirmNoNominee,
    });
    setNotice(`${res.data.claim_number} paid: ${pkr(res.data.total)} to ${res.data.payouts.length} payee${res.data.payouts.length === 1 ? "" : "s"}.`);
    setSplit(null); setOverride(null); await load();
  });

  if (!live) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 py-12 px-6 text-center text-sm text-slate-500">
        Claims are registered against a member&apos;s certificate. Issue the master policy first ({mp.status}).
      </div>
    );
  }

  const field = "border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50";
  const needsConfirm = split?.source === "claimant";
  const overrideTotal = override ? override.reduce((n, o) => n + (parseFloat(o.share_pct) || 0), 0) : 100;

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`rounded-xl border p-3 text-sm font-medium ${error ? "bg-red-50 border-red-200 text-red-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>{error || notice}</div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-6 text-xs text-slate-500">
          {summary && <>
            <span><strong className="text-slate-800 tabular-nums">{summary.count}</strong> claims</span>
            <span><strong className="text-slate-800 tabular-nums">{summary.open}</strong> open</span>
            <span>Claimed <strong className="text-slate-800 tabular-nums">{pkr(summary.submitted)}</strong></span>
            <span>Paid <strong className="text-slate-800 tabular-nums">{pkr(summary.paid)}</strong></span>
          </>}
        </div>
        {!creating && <button onClick={() => setCreating(true)} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">Register a claim</button>}
      </div>

      {creating && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <p className="text-sm font-semibold text-slate-700">Register a claim</p>
          <input className={`${field} w-72`} placeholder="Find the member…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="border border-slate-100 rounded-lg divide-y divide-slate-100">
            {pageItems.map((m) => (
              <label key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                <input type="radio" checked={memberId === m.id} onChange={() => pick(m)} />
                <span className="font-semibold text-slate-800">{m.name}</span>
                <span className="text-xs text-slate-400">{m.certificate_number ?? "No certificate"} · cover {pkr(m.coverage_amount)}</span>
              </label>
            ))}
          </div>
          <Pagination pagination={pagination} noun="members" />
          {picked && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <select className={field} value={form.claim_type} onChange={(e) => setForm({ ...form, claim_type: e.target.value })}>
                {CLAIM_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <select className={field} value={dependentId} onChange={(e) => setDependentId(e.target.value)} disabled={dependents.length === 0}>
                <option value="">The employee</option>
                {dependents.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.relationship})</option>)}
              </select>
              <input className={field} type="number" placeholder="Amount claimed (PKR)" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              <input className={field} type="date" value={form.incident_date} onChange={(e) => setForm({ ...form, incident_date: e.target.value })} />
              <input className={`${field} col-span-2 md:col-span-4`} placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreating(false)} className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg">Cancel</button>
            <button onClick={register} disabled={!memberId || !(parseFloat(form.amount) > 0) || !!busy}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">{busy === "Register" ? "Registering…" : "Register claim"}</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <p className="px-5 py-3 border-b border-slate-100 bg-slate-50 text-sm font-semibold text-slate-700">Claims on this scheme</p>
        {loading ? <div className="py-10 text-center text-sm text-slate-400">Loading…</div>
          : claims.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">No claims yet.</div>
          : claims.map((c) => (
            <div key={c.id} className="border-b border-slate-100 last:border-0">
              <button onClick={() => toggle(c)} className="w-full px-5 py-3 flex items-center gap-4 text-left hover:bg-slate-50">
                <span className="font-mono text-xs text-slate-500 w-28 truncate">{c.claim_number}</span>
                <span className="text-sm font-semibold text-slate-800 w-44 truncate">{c.member}{c.dependent ? ` · for ${c.dependent}` : ""}</span>
                <span className="text-xs text-slate-500 w-36">{RIDER_LABEL[c.coverage_type ?? ""] ?? c.claim_type}</span>
                <Chip status={claimTone(c.status)}>{c.status}</Chip>
                {(c.missing_documents?.length ?? 0) > 0 && !CLOSED.has(c.status) && <span className="text-[11px] text-amber-700 font-medium">{c.missing_documents!.length} document{c.missing_documents!.length === 1 ? "" : "s"} missing</span>}
                <span className="ml-auto text-sm tabular-nums font-semibold text-slate-800">{pkr(c.submitted_amount)}</span>
              </button>

              {open === c.id && (
                <div className="px-5 pb-4 space-y-3 bg-slate-50/50">
                  <div className="grid md:grid-cols-2 gap-3">
                    <div className="bg-white border border-slate-100 rounded-lg p-3 space-y-1">
                      <p className="text-xs font-semibold text-slate-600">Documents for this benefit</p>
                      {(c.required_documents ?? []).map((d) => {
                        const missing = (c.missing_documents ?? []).includes(d);
                        return <p key={d} className={`text-xs flex items-center gap-2 ${missing ? "text-amber-700" : "text-emerald-700"}`}><span>{missing ? "○" : "✓"}</span>{d}</p>;
                      })}
                      {(c.required_documents ?? []).length === 0 && <p className="text-xs text-slate-400">None listed.</p>}
                    </div>
                    <div className="bg-white border border-slate-100 rounded-lg p-3 space-y-1 text-xs text-slate-600">
                      <p><span className="text-slate-400">Certificate</span> {c.certificate_number ?? "—"}</p>
                      <p><span className="text-slate-400">Incident</span> {c.incident_date ?? "—"}</p>
                      <p><span className="text-slate-400">Approved</span> {c.approved_amount ? pkr(c.approved_amount) : "—"} · <span className="text-slate-400">Paid</span> {c.settlement_amount ? pkr(c.settlement_amount) : "—"}</p>
                      <Link href={`/claims/${c.id}`} className="inline-block pt-1 font-semibold text-blue-600 hover:text-blue-800">Open in Claims — adjudicate and attach documents →</Link>
                    </div>
                  </div>

                  {!CLOSED.has(c.status) && (
                    <div className="bg-white border border-slate-100 rounded-lg p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-800">Payout to nominees</p>
                        <button onClick={() => loadSplit(c)} disabled={!!busy} className="text-xs font-semibold text-blue-600 hover:text-blue-800">{split ? "Refresh split" : "Work out the split"}</button>
                      </div>
                      {split && (
                        <>
                          <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                            {override ? override.map((o, i) => (
                              <div key={i} className="px-3 py-2 grid grid-cols-12 gap-2 items-center">
                                <input className={`${field} col-span-4 !py-1`} value={o.name} onChange={(e) => setOverride(override.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                                <input className={`${field} col-span-3 !py-1`} placeholder="Relationship" value={o.relationship} onChange={(e) => setOverride(override.map((x, j) => j === i ? { ...x, relationship: e.target.value } : x))} />
                                <input className={`${field} col-span-2 !py-1`} type="number" value={o.share_pct} onChange={(e) => setOverride(override.map((x, j) => j === i ? { ...x, share_pct: e.target.value } : x))} />
                                <label className="col-span-2 text-[11px] text-slate-500 flex items-center gap-1"><input type="checkbox" checked={o.is_minor} onChange={(e) => setOverride(override.map((x, j) => j === i ? { ...x, is_minor: e.target.checked } : x))} />Minor</label>
                                <button onClick={() => setOverride(override.filter((_, j) => j !== i))} className="col-span-1 text-xs text-slate-400 hover:text-red-600">✕</button>
                                {o.is_minor && <input className={`${field} col-span-12 !py-1`} placeholder="Guardian name" value={o.guardian_name} onChange={(e) => setOverride(override.map((x, j) => j === i ? { ...x, guardian_name: e.target.value } : x))} />}
                              </div>
                            )) : split.shares.map((s: PayoutShare, i) => (
                              <div key={i} className="px-3 py-2 text-xs flex items-center gap-3">
                                <span className="font-semibold text-slate-800 w-44 truncate">{s.payee_name}</span>
                                <span className="text-slate-500 w-24">{s.relationship ?? "—"}</span>
                                <span className="tabular-nums w-14 text-right">{s.share_pct}%</span>
                                <span className="tabular-nums font-semibold w-28 text-right">{pkr(s.amount)}</span>
                                {s.is_minor && <span className="text-amber-700">{s.guardian_name ? `paid to guardian ${s.guardian_name}` : "minor — guardian needed"}</span>}
                              </div>
                            ))}
                          </div>
                          {split.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700">⚠ {w}</p>)}
                          {split.source === "override" && split.override_reason && <p className="text-xs text-slate-500">Overridden: {split.override_reason}</p>}

                          {override ? (
                            <div className="space-y-2">
                              <p className={`text-xs ${Math.abs(overrideTotal - 100) < 0.01 ? "text-slate-500" : "text-red-600"}`}>Shares total {overrideTotal}% — must be 100%.</p>
                              <input className={`${field} w-full`} placeholder="Why is the split being changed? (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                              <div className="flex gap-2">
                                <button onClick={() => setOverride([...override, { name: "", share_pct: "0", relationship: "", cnic: "", is_minor: false, guardian_name: "" }])} className="text-xs font-semibold text-blue-600">+ Add payee</button>
                                <button onClick={() => previewOverride(c)} disabled={!reason.trim() || Math.abs(overrideTotal - 100) > 0.01 || !!busy} className="text-xs font-semibold text-slate-700 disabled:opacity-40">Preview</button>
                                <button onClick={() => { setOverride(null); loadSplit(c); }} className="text-xs text-slate-400 hover:text-slate-700">Cancel override</button>
                              </div>
                            </div>
                          ) : (
                            <button onClick={() => setOverride(toRows(split))} className="text-xs font-semibold text-slate-600 hover:text-slate-900">Override the split…</button>
                          )}

                          <div className="flex items-end gap-3 flex-wrap pt-1 border-t border-slate-100">
                            <label className="text-xs font-semibold text-slate-600 space-y-1"><span className="block">Bank reference</span>
                              <input className={`${field} w-52`} value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="IBFT-123456" /></label>
                            {needsConfirm && <label className="text-xs text-amber-700 flex items-center gap-2"><input type="checkbox" checked={confirmNoNominee} onChange={(e) => setConfirmNoNominee(e.target.checked)} />No nominee on file — pay the claimant in full</label>}
                            <button onClick={() => pay(c)} disabled={!!busy || !payRef.trim() || (needsConfirm && !confirmNoNominee) || (!!override && !reason.trim())}
                              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">{busy === "Pay" ? "Paying…" : `Pay ${pkr(split.amount)}`}</button>
                          </div>
                          <p className="text-[11px] text-slate-400">The claim must be approved in Claims first, with a document attached.</p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
