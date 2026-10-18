"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import * as service from '@/app/services/commissionEarnings';
import { tx } from "@/lib/i18n/tx";
import CommissionDisbursements from '@/components/commissions/CommissionDisbursements';
import CommissionRecords from '@/components/commissions/CommissionRecords';
import CommissionRecordDrawer from '@/components/commissions/CommissionRecordDrawer';

const money = (value: string | number) => new Intl.NumberFormat('en-PK', {style: 'currency', currency: 'PKR'}).format(Number(value));
const field = 'border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white w-full';
const button = 'rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const blankProducer = (): service.Producer => ({source_id: '', split_pct: '100'});

export default function EarningsPage() {
  const [activeTab, setActiveTab] = useState<'records' | 'payouts' | 'exceptions' | 'setup'>('records');
  const [filters, setFilters] = useState<service.EarningFilters>({});
  const [selectedRecord, setSelectedRecord] = useState<{earning: service.Earning; edit: boolean} | null>(null);
  const requestRevision = useRef(0);
  const [entries, setEntries] = useState<service.Earning[]>([]);
  const [summary, setSummary] = useState<service.Summary | null>(null);
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
  const [setup, setSetup] = useState<service.Setup | null>(null);
  const [policySearch, setPolicySearch] = useState('');
  const [policySearchInput, setPolicySearchInput] = useState('');
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [actorId, setActorId] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCustomerId(params.get('customer_id') || undefined);
    if (params.get('customer_id')) setActiveTab('setup');
  }, []);
  const selectedPolicy = setup?.policies.find(p => p.id === policy);
  const splitTotal = producers.reduce((total, p) => total + Math.round(Number(p.split_pct) * 10000), 0);
  const validSplit = splitTotal === 1000000 && producers.every(p => p.source_id && Number(p.split_pct) > 0)
    && new Set(producers.map(p => p.source_id)).size === producers.length;
  function choosePolicy(id: string, data = setup) {
    setPolicy(id);
    const chosen = data?.policies.find(p => p.id === id);
    setProducers(chosen?.assignments.length ? chosen.assignments : [{...blankProducer(), source_id: chosen?.automatic?.source_id || chosen?.recommended_source_id || ''}]);
  }
  async function reviewException(exception: service.AccrualException) {
    setBusy(true); setError('');
    try {
      const configuration = await service.loadSetup(exception.policy_id);
      setCustomerId(undefined); setPolicySearch(exception.policy_id); setPolicySearchInput(exception.policy_id);
      setSetup(configuration); choosePolicy(exception.policy_id, configuration); setReceipt(exception.receipt_id); setActiveTab('setup');
      if (!configuration.policies.length) setNotice('This receipt’s policy is not an individual policy available for commission setup.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load policy setup'); }
    finally { setBusy(false); }
  }
  const refresh = useCallback(async () => {
    const revision = ++requestRevision.current;
    const isAdmin = ['Admin', 'SuperAdmin'].includes(localStorage.getItem('user_role') || '');
    setAdmin(isAdmin);
    const [ledger, totals] = await Promise.all([service.loadEarnings(offset, filters), service.loadSummary(filters)]);
    if (revision !== requestRevision.current) return;
    setEntries(ledger.items); setTotal(ledger.total); setSummary(totals);
    if (isAdmin) {
      const [p, e, configuration] = await Promise.all([service.loadPayees(), service.loadExceptions(), service.loadSetup(policySearch, customerId)]);
      if (revision !== requestRevision.current) return;
      setPayees(p); setExceptions(e); setSetup(configuration); setActorId(configuration.actor_id);
    }
  }, [offset, policySearch, customerId, filters]);
  useEffect(() => {
    let current = true;
    setBusy(true); setError('');
    refresh().catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [refresh]);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : tx("Request failed")); }
    finally { setBusy(false); }
  }
  async function savedRecord(updated: service.Earning) {
    setEntries(rows => rows.map(row => row.id === updated.id ? updated : row));
    setSelectedRecord(null); setNotice(tx('Commission record updated. The change is saved in its history.'));
    try { await refresh(); } catch (e) { setError(e instanceof Error ? e.message : tx('Unable to refresh records')); }
  }
  return <div className="mx-auto max-w-[1600px] space-y-5 p-4 text-slate-800 sm:p-6 lg:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-1.5 flex items-center gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{tx('Finance')}</span><span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">{tx('Automatic accrual')}</span></div><h1 className="text-2xl font-semibold tracking-tight text-slate-900">{tx('Commissions')}</h1><p className="mt-1.5 text-sm text-slate-500">{tx('Track agent commissions generated from received premiums.')}</p></div>
      <div className="flex flex-wrap items-center gap-2">{admin && <Link className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" href="/admin/rule-engine">{tx('Commission rules')} ↗</Link>}<button className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50" disabled={busy} onClick={() => void run(async () => {}, tx('Records refreshed'))}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg>{tx('Refresh')}</button></div>
    </div>
    <div className="grid gap-4 sm:grid-cols-3">{[
      [tx('Accrued commission'), summary ? money(summary.accrued_gross) : '—', tx('Gross across matching records')],
      [tx('Commission records'), summary?.entries ?? '—', tx('Generated from premium receipts')],
      [tx('Paid commission'), summary ? money(summary.paid_gross || '0') : '—', tx('External payments recorded · gross')],
    ].map(([label, value, hint]) => <div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm"><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p><p className="mt-1.5 text-[11px] text-slate-400">{hint}</p></div>)}</div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200"><nav aria-label={tx('Commission views')} className="flex gap-5 overflow-x-auto">{([
      ['records', 'Records'], ...(admin ? [['payouts', 'Payouts'], ['exceptions', 'Exceptions'], ['setup', 'Setup']] : []),
    ] as [typeof activeTab, string][]).map(([id, label]) => <button key={id} aria-current={activeTab === id ? 'page' : undefined} onClick={() => setActiveTab(id)} className={`relative whitespace-nowrap border-b-2 px-0.5 pb-3 pt-1 text-sm font-medium transition-colors ${activeTab === id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-700'}`}>{tx(label)}{id === 'exceptions' && exceptions.length > 0 && <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{exceptions.length}</span>}</button>)}</nav></div>
    {error && <p role="alert" className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p>}
    {activeTab === 'records' && <CommissionRecords entries={entries} total={total} offset={offset} busy={busy} admin={admin} payees={payees} filters={filters} onFilters={next => {setOffset(0); setFilters(next);}} onOffset={setOffset} onOpen={(earning, edit) => setSelectedRecord({earning, edit})}/>}
    {admin && activeTab === 'setup' && <>

      <section className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-2">
        <h2 className="font-semibold">Commission setup</h2>
        <p className="text-sm">Assign the customer’s agent. Premium receipts then create earnings automatically at the rate set by rule set {setup?.commission_rule_set_code || 'RS-COM-002'}: percentage of premium, and whether later premiums also earn. Edit rates in the <Link className="underline" href="/admin/rule-engine">Rule Engine</Link>. Set each agent’s start date (their payout day) in <Link className="underline" href="/admin/acquisition-sources">Acquisition Sources</Link>. Policy-specific splits below are optional overrides.</p>
        <p className="text-sm font-medium">{exceptions.length} receipt exceptions shown</p>
        {setup?.customer && <p className="text-sm">{setup.customer.name} · Agent: {setup.customer.assigned_agent_name || 'Unassigned'} · Source: {setup.customer.acquisition_source_name || 'Unassigned'} <button className="underline ml-2" onClick={() => {setCustomerId(undefined); choosePolicy('');}}>Show all customers</button></p>}
      </section>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="font-semibold">Optional: override producers on an individual policy</h2>
        <p className="text-sm text-slate-500">Select an individual policy by customer, plan or policy number. The customer’s source is suggested; save to confirm it. Manage producers in <Link className="underline" href="/admin/acquisition-sources">Acquisition Sources</Link>.</p>
        <form className="flex gap-3 items-end" onSubmit={e => {e.preventDefault(); choosePolicy(''); setPolicySearch(policySearchInput);}}><label className="grow text-sm">Search policies<input className={field} value={policySearchInput} onChange={e => setPolicySearchInput(e.target.value)} placeholder="Customer, plan or policy number" /></label><button disabled={busy} className={button}>Search</button></form>
        <label className="block text-sm">Individual policy<select className={field} value={policy} disabled={busy} onChange={e => choosePolicy(e.target.value)}><option value="">Select a policy</option>{setup?.policies.map(p => <option key={p.id} value={p.id}>{p.customer_name} · {p.product_name} · {p.policy_number || 'Draft'} · {p.ready ? 'Configured' : 'Needs setup'}</option>)}</select></label>
        {setup?.has_more && <p className="text-sm text-slate-500">Showing 50 policies. Search to narrow the results.</p>}
        {setup && !setup.policies.length && <p className="text-sm text-slate-500">No individual policies found. Create a proposal for the customer first.</p>}
        {selectedPolicy && <div className="rounded-lg bg-slate-50 border p-3 text-sm"><p className="font-medium">{selectedPolicy.customer_name} · {selectedPolicy.status}</p><p>{selectedPolicy.frozen ? 'Assignments are frozen because commission has already posted.' : selectedPolicy.automatic ? 'Automatic agent allocation is ready. No policy setup is required; the next premium receipt creates the assignment and earning.' : selectedPolicy.ready ? 'Configured. Collect a premium to accrue commission.' : selectedPolicy.blocking_reasons.join('. ')}</p><p className="text-xs text-slate-500 mt-1">Policy {selectedPolicy.id}.</p></div>}
        <fieldset disabled={busy || !selectedPolicy || selectedPolicy.frozen} className="space-y-3 disabled:opacity-60">
        {producers.map((p, i) => <div key={i} className="grid sm:grid-cols-3 gap-3">
          <select aria-label={tx("Producer {0}", { 0: i + 1 })} className={field} value={p.source_id} onChange={e => setProducers(producers.map((x, j) => j === i ? {...x, source_id: e.target.value} : x))}><option value="">{tx("Select producer")}</option>{payees.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select>
          <input aria-label={tx("Split percentage {0}", { 0: i + 1 })} className={field} type="number" min="0.0001" max="100" step="0.0001" value={p.split_pct} onChange={e => setProducers(producers.map((x, j) => j === i ? {...x, split_pct: e.target.value} : x))}/>
          <button disabled={busy || producers.length === 1} onClick={() => setProducers(producers.filter((_, j) => j !== i))}>{tx("Remove")}</button>
        </div>)}
        <p className="text-sm">Total split: {Number.isFinite(splitTotal) ? splitTotal / 10000 : '—'}% · must equal 100%</p>
        <div className="flex gap-3"><button disabled={producers.length >= 20} onClick={() => setProducers([...producers, {...blankProducer(), split_pct: ''}])}>{tx("Add producer")}</button><button disabled={!validSplit} className={button} onClick={() => run(() => service.saveAssignments(policy, producers), 'Producer assignments saved')}>{tx("Save assignments")}</button></div>
        </fieldset>
      </section>
    </>}
    {admin && activeTab === 'exceptions' && <>
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="font-semibold">{tx("Reconcile receipts and resolve exceptions")}</h2>
        <p className="text-sm text-slate-500">{tx("Reconcile an existing receipt after configuration is corrected. Repeating a posted receipt does not create another earning. Showing up to 100 open exceptions.")}</p>
        <form className="flex gap-3" onSubmit={e => {e.preventDefault(); void run(async () => { const results = await service.reconcileReceipts([receipt]); const failed = results.find(x => x.status === 'EXCEPTION'); if (failed) throw new Error(failed.reason); }, 'Receipt reconciled');}}><input aria-label={tx("Receipt ID")} className={field} placeholder={tx("Receipt ID")} required value={receipt} onChange={e => setReceipt(e.target.value)}/><button disabled={busy} className={button}>{tx("Reconcile")}</button></form>
        {exceptions.map(e => <div key={e.id} className="border-t pt-3 text-sm flex flex-wrap justify-between gap-3"><div>{e.reason}<div className="text-xs text-slate-500">{tx("Receipt")}{" "}{e.receipt_id}{" "}{tx("· Policy")}{" "}{e.policy_id}</div></div><button disabled={busy} onClick={() => void reviewException(e)}>Review setup</button></div>)}
      </section>
    </>}
    {admin && activeTab === 'payouts' && <CommissionDisbursements actorId={actorId} onChange={refresh}/>}
    {selectedRecord && <CommissionRecordDrawer key={selectedRecord.earning.id} earning={selectedRecord.earning} edit={selectedRecord.edit} admin={admin} onClose={() => setSelectedRecord(null)} onSaved={savedRecord}/>}
  </div>;
}
