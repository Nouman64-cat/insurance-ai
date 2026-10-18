"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import * as service from '@/app/services/commissionEarnings';
import { tx } from "@/lib/i18n/tx";
import CommissionDisbursements from '@/components/commissions/CommissionDisbursements';

const money = (value: string | number) => new Intl.NumberFormat('en-PK', {style: 'currency', currency: 'PKR'}).format(Number(value));
const field = 'border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white w-full';
const button = 'rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const blankProducer = (): service.Producer => ({source_id: '', split_pct: '100'});

export default function EarningsPage() {
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
      setSetup(configuration); choosePolicy(exception.policy_id, configuration); setReceipt(exception.receipt_id);
      if (!configuration.policies.length) setNotice('This receipt’s policy is not an individual policy available for commission setup.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load policy setup'); }
    finally { setBusy(false); }
  }
  const refresh = useCallback(async () => {
    const isAdmin = ['Admin', 'SuperAdmin'].includes(localStorage.getItem('user_role') || '');
    setAdmin(isAdmin);
    const [ledger, totals] = await Promise.all([service.loadEarnings(offset), service.loadSummary()]);
    setEntries(ledger.items); setTotal(ledger.total); setSummary(totals);
    if (isAdmin) {
      const [p, e, configuration] = await Promise.all([service.loadPayees(), service.loadExceptions(), service.loadSetup(policySearch, customerId)]);
      setPayees(p); setExceptions(e); setSetup(configuration); setActorId(configuration.actor_id);
    }
  }, [offset, policySearch, customerId]);
  useEffect(() => { setBusy(true); refresh().catch(e => setError(e.message)).finally(() => setBusy(false)); }, [refresh]);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : tx("Request failed")); }
    finally { setBusy(false); }
  }
  return <div className="max-w-7xl mx-auto p-6 space-y-6 text-slate-800">
    <div className="flex flex-wrap justify-between gap-3 items-start">
      <div><h1 className="text-2xl font-bold">{tx("Commission earnings")}</h1><p className="text-sm text-slate-500 mt-1">{tx("Recorded premium receipts and the Rule Engine commission rates applied to them.")}</p></div>
      <button className={button} disabled={busy} onClick={() => run(async () => {}, 'Refreshed')}>{tx("Refresh")}</button>
    </div>
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm">Commission accrues automatically on the first premium after issuance, at the rate set by the agent commission rules in the Rule Engine; later premiums earn only if the rule is recurring. Each earning is payable from the agent’s start day in the following month. Disbursement requires independent approval and external payment confirmation. Tax calculation, bank transfers and group/family allocation are not enabled.</div>
    {error && <p role="alert" className="bg-red-50 text-red-800 p-4 rounded-lg">{error}</p>}
    {notice && <p role="status" className="bg-emerald-50 text-emerald-800 p-4 rounded-lg">{notice}</p>}
    <div className="grid sm:grid-cols-3 gap-4">
      <div className="border rounded-xl bg-white p-5"><p className="text-sm text-slate-500">{tx("Accrued gross · all entries")}</p><p className="text-2xl font-semibold">{summary ? money(summary.accrued_gross) : '—'}</p></div>
      <div className="border rounded-xl bg-white p-5"><p className="text-sm text-slate-500">{tx("Posted allocations")}</p><p className="text-2xl font-semibold">{summary?.entries ?? '—'}</p></div>
      <div className="border rounded-xl bg-white p-5"><p className="text-sm text-slate-500">External payments recorded · gross</p><p className="text-2xl font-semibold">{summary ? money(summary.paid_gross || '0') : '—'}</p></div>
    </div>
    <section className="rounded-xl border bg-white overflow-hidden">
      <h2 className="font-semibold p-4 border-b">{tx("Earnings ledger")}</h2>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50"><tr>{['Receipt / policy', 'Producer', 'Basis', 'Rate / split', 'Gross accrued', 'Rule', 'Payable from'].map(x => <th key={x} className="p-3">{x}</th>)}</tr></thead>
      <tbody>{entries.map(e => <tr key={e.id} className="border-t">
        <td className="p-3"><div>{e.snapshot.receipt_no}</div><div className="text-xs text-slate-500">{e.snapshot.policy_number || e.policy_id}</div></td>
        <td className="p-3">{e.snapshot.payee_name}<div className="text-xs text-slate-500">{e.snapshot.customer_name}</div></td>
        <td className="p-3" title={e.snapshot.basis_description}>{money(e.basis_amount)}</td>
        <td className="p-3">{Number(e.rate_pct)}% / {Number(e.split_pct)}%<div className="text-xs">{tx("Policy year")}{" "}{e.policy_year}</div></td>
        <td className="p-3 font-semibold">{money(e.gross_amount)}<div className="text-xs font-normal text-slate-500">{e.disbursement_status || 'ACCRUED'}</div></td><td className="p-3">{e.rule_code ? `${e.rule_code} v${e.rule_version}` : `${e.snapshot.agreement_code} v${e.snapshot.agreement_version}`}<div className="text-xs text-slate-500">{e.snapshot.is_first_premium === false ? tx("Recurring") : tx("First premium")}</div></td><td className="p-3">{e.disburse_date || '—'}</td>
      </tr>)}</tbody></table></div>
      {!entries.length && <p className="p-8 text-center text-slate-500">{busy ? tx("Loading…") : 'No posted earnings. Assign the customer’s agent and check the agent commission rules in the Rule Engine, then collect a premium or reconcile a receipt.'}</p>}
      <div className="p-3 flex gap-4 items-center"><button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{tx("Previous")}</button><span>{total ? offset + 1 : 0}–{Math.min(offset + entries.length, total)}{" "}{tx("of")}{" "}{total}</span><button disabled={busy || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>{tx("Next")}</button></div>
    </section>
    {admin && <>
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
      <section className="rounded-xl border bg-white p-5 space-y-4">
        <h2 className="font-semibold">{tx("Reconcile receipts and resolve exceptions")}</h2>
        <p className="text-sm text-slate-500">{tx("Reconcile an existing receipt after configuration is corrected. Repeating a posted receipt does not create another earning. Showing up to 100 open exceptions.")}</p>
        <form className="flex gap-3" onSubmit={e => {e.preventDefault(); void run(async () => { const results = await service.reconcileReceipts([receipt]); const failed = results.find(x => x.status === 'EXCEPTION'); if (failed) throw new Error(failed.reason); }, 'Receipt reconciled');}}><input aria-label={tx("Receipt ID")} className={field} placeholder={tx("Receipt ID")} required value={receipt} onChange={e => setReceipt(e.target.value)}/><button disabled={busy} className={button}>{tx("Reconcile")}</button></form>
        {exceptions.map(e => <div key={e.id} className="border-t pt-3 text-sm flex flex-wrap justify-between gap-3"><div>{e.reason}<div className="text-xs text-slate-500">{tx("Receipt")}{" "}{e.receipt_id}{" "}{tx("· Policy")}{" "}{e.policy_id}</div></div><button disabled={busy} onClick={() => void reviewException(e)}>Review setup</button></div>)}
      </section>
      <CommissionDisbursements actorId={actorId} onChange={refresh}/>
    </>}
  </div>;
}
