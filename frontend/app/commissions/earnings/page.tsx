"use client";

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import * as service from '@/app/services/commissionEarnings';
import { tx } from "@/lib/i18n/tx";

const money = (value: string | number) => new Intl.NumberFormat('en-PK', {style: 'currency', currency: 'PKR'}).format(Number(value));
const field = 'border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white w-full';
const button = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const blankProducer = (): service.Producer => ({source_id: '', agreement_id: '', split_pct: '100'});

export default function EarningsPage() {
  const [entries, setEntries] = useState<service.Earning[]>([]);
  const [summary, setSummary] = useState<service.Summary | null>(null);
  const [agreements, setAgreements] = useState<service.Agreement[]>([]);
  const [payees, setPayees] = useState<service.Payee[]>([]);
  const [exceptions, setExceptions] = useState<service.AccrualException[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [policy, setPolicy] = useState('');
  const [receipt, setReceipt] = useState('');
  const [producers, setProducers] = useState<service.Producer[]>([blankProducer()]);
  const refresh = useCallback(async () => {
    const isAdmin = ['Admin', 'SuperAdmin'].includes(localStorage.getItem('user_role') || '');
    setAdmin(isAdmin);
    const [ledger, totals] = await Promise.all([service.loadEarnings(offset), service.loadSummary()]);
    setEntries(ledger.items); setTotal(ledger.total); setSummary(totals);
    if (isAdmin) {
      const [a, p, e] = await Promise.all([service.loadAgreements(), service.loadPayees(), service.loadExceptions()]);
      setAgreements(a); setPayees(p); setExceptions(e);
    }
  }, [offset]);
  useEffect(() => { setBusy(true); refresh().catch(e => setError(e.message)).finally(() => setBusy(false)); }, [refresh]);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : tx("Request failed")); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => service.createAgreement({code: String(data.get('code')), name: String(data.get('name')),
      version: Number(data.get('version')), first_year_pct: String(data.get('first_year_pct')),
      renewal_pct: String(data.get('renewal_pct')), effective_from: String(data.get('effective_from')),
      effective_to: String(data.get('effective_to')) || null}), 'Draft saved. A different administrator must approve it.');
  }
  return <div className="max-w-7xl mx-auto p-6 space-y-6 text-slate-800">
    <div className="flex flex-wrap justify-between gap-3 items-start">
      <div><h1 className="text-2xl font-bold">{tx("Commission earnings")}</h1><p className="text-sm text-slate-500 mt-1">{tx("Recorded premium receipts and approved producer agreements.")}</p></div>
      <button className={button} disabled={busy} onClick={() => run(async () => {}, 'Refreshed')}>{tx("Refresh")}</button>
    </div>
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm">{tx("Accrued gross earnings only. Tax, release eligibility, payouts, and group/family allocations are not enabled in this release.")}{" "}<Link className="underline" href="/commissions/preview">{tx("View illustrative dashboard")}</Link></div>
    {error && <p role="alert" className="bg-red-50 text-red-800 p-4 rounded-lg">{error}</p>}
    {notice && <p role="status" className="bg-emerald-50 text-emerald-800 p-4 rounded-lg">{notice}</p>}
    <div className="grid sm:grid-cols-3 gap-4">
      <div className="border rounded-xl bg-white p-5"><p className="text-sm text-slate-500">{tx("Accrued gross · all entries")}</p><p className="text-2xl font-semibold">{summary ? money(summary.accrued_gross) : '—'}</p></div>
      <div className="border rounded-xl bg-white p-5"><p className="text-sm text-slate-500">{tx("Posted allocations")}</p><p className="text-2xl font-semibold">{summary?.entries ?? '—'}</p></div>
      <div className="border rounded-xl bg-white p-5"><p className="text-sm text-slate-500">{tx("Settlement")}</p><p className="text-xl font-semibold">{tx("Not enabled")}</p></div>
    </div>
    <section className="rounded-xl border bg-white overflow-hidden">
      <h2 className="font-semibold p-4 border-b">{tx("Earnings ledger")}</h2>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50"><tr>{['Receipt / policy', 'Producer', 'Basis', 'Rate / split', 'Gross accrued', 'Agreement'].map(x => <th key={x} className="p-3">{x}</th>)}</tr></thead>
      <tbody>{entries.map(e => <tr key={e.id} className="border-t">
        <td className="p-3"><div>{e.snapshot.receipt_no}</div><div className="text-xs text-slate-500">{e.snapshot.policy_number || e.policy_id}</div></td>
        <td className="p-3">{e.snapshot.payee_name}<div className="text-xs text-slate-500">{e.snapshot.customer_name}</div></td>
        <td className="p-3" title={e.snapshot.basis_description}>{money(e.basis_amount)}</td>
        <td className="p-3">{Number(e.rate_pct)}% / {Number(e.split_pct)}%<div className="text-xs">{tx("Policy year")}{" "}{e.policy_year}</div></td>
        <td className="p-3 font-semibold">{money(e.gross_amount)}</td><td className="p-3">{e.snapshot.agreement_code} v{e.snapshot.agreement_version}</td>
      </tr>)}</tbody></table></div>
      {!entries.length && <p className="p-8 text-center text-slate-500">{busy ? tx("Loading…") : tx("No posted earnings. Configure an agreement and producer assignment, then collect a premium or reconcile an existing receipt.")}</p>}
      <div className="p-3 flex gap-4 items-center"><button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{tx("Previous")}</button><span>{total ? offset + 1 : 0}–{Math.min(offset + entries.length, total)}{" "}{tx("of")}{" "}{total}</span><button disabled={busy || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>{tx("Next")}</button></div>
    </section>
    {admin && <>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="font-semibold">{tx("1. Contractual agreements")}</h2>
        <p className="text-sm text-slate-500">{tx("Rates are explicit contractual inputs, not statutory defaults. Basis: receipt base including fees and duty, excluding surcharge. Approved versions cannot be edited.")}</p>
        <form onSubmit={create} className="grid sm:grid-cols-4 gap-3">
          <label className="text-sm">{tx("Code")}<input name="code" required pattern="[A-Za-z0-9_-]+" className={field}/></label>
          <label className="text-sm">{tx("Name")}<input name="name" required className={field}/></label>
          <label className="text-sm">{tx("Version")}<input name="version" type="number" min="1" defaultValue="1" required className={field}/></label>
          <label className="text-sm">{tx("First-year rate %")}<input name="first_year_pct" type="number" min="0" max="100" step="0.0001" required className={field}/></label>
          <label className="text-sm">{tx("Renewal rate %")}<input name="renewal_pct" type="number" min="0" max="100" step="0.0001" required className={field}/></label>
          <label className="text-sm">{tx("Effective from")}<input name="effective_from" type="date" required className={field}/></label>
          <label className="text-sm">{tx("Effective to (optional)")}<input name="effective_to" type="date" className={field}/></label>
          <button disabled={busy} className={`${button} self-end`}>{tx("Save draft")}</button>
        </form>
        {agreements.map(a => <div key={a.id} className="flex flex-wrap gap-3 justify-between border-t pt-3 text-sm"><span>{a.code} v{a.version} · {a.name} · {Number(a.first_year_pct)}% / {Number(a.renewal_pct)}% · {a.status}</span>{a.status === 'DRAFT' && <button disabled={busy} className={button} onClick={() => run(() => service.approveAgreement(a.id), 'Agreement approved')}>{tx("Approve")}</button>}</div>)}
      </section>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="font-semibold">{tx("2. Assign producers to an individual policy")}</h2>
        <p className="text-sm text-slate-500">{tx("Use the policy ID from its record. Producer splits must total 100%. Assignments freeze after the first posting. Manage producers in")}{" "}<Link className="underline" href="/admin/acquisition-sources">{tx("Acquisition Sources")}</Link>.</p>
        <div className="flex gap-3"><label className="grow text-sm">{tx("Policy ID")}<input aria-label={tx("Policy ID")} value={policy} onChange={e => setPolicy(e.target.value)} className={field}/></label><button disabled={busy || !policy} className={`${button} self-end`} onClick={() => run(async () => { const p = await service.loadAssignments(policy); setProducers(p.length ? p : [blankProducer()]); }, 'Assignments loaded')}>{tx("Load")}</button></div>
        {producers.map((p, i) => <div key={i} className="grid sm:grid-cols-4 gap-3">
          <select aria-label={tx("Producer {0}", { 0: i + 1 })} className={field} value={p.source_id} onChange={e => setProducers(producers.map((x, j) => j === i ? {...x, source_id: e.target.value} : x))}><option value="">{tx("Select producer")}</option>{payees.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select>
          <select aria-label={tx("Agreement {0}", { 0: i + 1 })} className={field} value={p.agreement_id} onChange={e => setProducers(producers.map((x, j) => j === i ? {...x, agreement_id: e.target.value} : x))}><option value="">{tx("Select approved agreement")}</option>{agreements.filter(x => x.status === 'APPROVED').map(x => <option key={x.id} value={x.id}>{x.code} v{x.version}</option>)}</select>
          <input aria-label={tx("Split percentage {0}", { 0: i + 1 })} className={field} type="number" min="0.0001" max="100" step="0.0001" value={p.split_pct} onChange={e => setProducers(producers.map((x, j) => j === i ? {...x, split_pct: e.target.value} : x))}/>
          <button disabled={busy || producers.length === 1} onClick={() => setProducers(producers.filter((_, j) => j !== i))}>{tx("Remove")}</button>
        </div>)}
        <div className="flex gap-3"><button disabled={busy || producers.length >= 20} onClick={() => setProducers([...producers, {...blankProducer(), split_pct: ''}])}>{tx("Add producer")}</button><button disabled={busy || !policy} className={button} onClick={() => run(() => service.saveAssignments(policy, producers), 'Producer assignments saved')}>{tx("Save assignments")}</button></div>
      </section>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="font-semibold">{tx("3. Reconcile receipts and resolve exceptions")}</h2>
        <p className="text-sm text-slate-500">{tx("Reconcile an existing receipt after configuration is corrected. Repeating a posted receipt does not create another earning. Showing up to 100 open exceptions.")}</p>
        <form className="flex gap-3" onSubmit={e => {e.preventDefault(); void run(async () => { const results = await service.reconcileReceipts([receipt]); const failed = results.find(x => x.status === 'EXCEPTION'); if (failed) throw new Error(failed.reason); }, 'Receipt reconciled');}}><input aria-label={tx("Receipt ID")} className={field} placeholder={tx("Receipt ID")} required value={receipt} onChange={e => setReceipt(e.target.value)}/><button disabled={busy} className={button}>{tx("Reconcile")}</button></form>
        {exceptions.map(e => <div key={e.id} className="border-t pt-3 text-sm flex flex-wrap justify-between gap-3"><div>{e.reason}<div className="text-xs text-slate-500">{tx("Receipt")}{" "}{e.receipt_id}{" "}{tx("· Policy")}{" "}{e.policy_id}</div></div><button disabled={busy} onClick={() => {setReceipt(e.receipt_id); setPolicy(e.policy_id);}}>{tx("Use these IDs")}</button></div>)}
      </section>
    </>}
  </div>;
}
