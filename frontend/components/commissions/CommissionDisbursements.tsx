"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import * as service from '@/app/services/commissionEarnings';

const money = (v: string | number) => new Intl.NumberFormat('en-PK', {style:'currency', currency:'PKR'}).format(Number(v));
const button = 'rounded-lg bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-50';

export default function CommissionDisbursements({actorId, onChange}: {actorId: string; onChange: () => Promise<void>}) {
  const [candidates, setCandidates] = useState<service.DisbursementCandidates | null>(null);
  const [batches, setBatches] = useState<service.Disbursement[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [batchOffset, setBatchOffset] = useState(0);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [detail, setDetail] = useState<service.DisbursementDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const load = useCallback(async () => {
    const [items, list, current] = await Promise.all([service.loadDisbursementCandidates(offset), service.loadDisbursements(batchOffset), selected ? service.loadDisbursement(selected) : null]);
    setCandidates(items); setBatches(list); if (selectedRef.current === selected) setDetail(current);
    setChosen(ids => ids.filter(id => items.items.some(i => i.earning.id === id && !i.hold_reason)));
  }, [offset, batchOffset, selected]);
  useEffect(() => {setBusy(true); load().catch(e => setError(e.message)).finally(() => setBusy(false));}, [load]);
  useEffect(() => {setReference(''); setConfirmed(false); setReason('');}, [selected]);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try {await action(); await load(); await onChange(); setNotice(message);}
    catch (e) {setError(e instanceof Error ? e.message : 'Request failed');}
    finally {setBusy(false);}
  }
  const batch = detail?.batch;
  return <section className="rounded-xl border bg-white p-5 space-y-4">
    <div className="flex justify-between gap-3"><div><h2 className="font-semibold">Disbursement approval</h2><p className="text-sm text-slate-600 mt-1">Accrued → Draft batch → Submitted → Approved → Payment recorded</p></div><button className={button} disabled={busy} onClick={() => void run(async () => {}, 'Refreshed')}>Refresh batches</button></div>
    <p className="text-sm text-slate-500">Only unreserved positive earnings on in-force policies past free-look can be selected. Eligibility is checked again at submission, approval and payment recording. Amounts are gross; this page records external payments and does not transfer money or calculate withholding tax.</p>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50"><tr><th className="p-3">Select</th><th className="p-3">Agent / policy</th><th className="p-3">Receipt</th><th className="p-3">Gross</th><th className="p-3">Eligibility</th></tr></thead><tbody>
      {candidates?.items.map(({earning:e, hold_reason:hold}) => <tr key={e.id} className="border-t"><td className="p-3"><input type="checkbox" aria-label={`Select earning ${e.snapshot.receipt_no} for ${e.snapshot.payee_name}`} disabled={busy || !!hold} checked={chosen.includes(e.id)} onChange={ev => setChosen(ids => ev.target.checked ? [...ids,e.id] : ids.filter(id => id !== e.id))}/></td><td className="p-3">{e.snapshot.payee_name}<span className="block text-xs text-slate-500">{e.snapshot.policy_number || e.policy_id} · {e.snapshot.customer_name}</span></td><td className="p-3">{e.snapshot.receipt_no}</td><td className="p-3">{money(e.gross_amount)}</td><td className="p-3">{hold || 'Eligible for batch'}</td></tr>)}
    </tbody></table></div>
    {!candidates?.items.length && <p className="text-sm text-slate-500">No unreserved earnings on this page.</p>}
    <div className="flex flex-wrap gap-3 items-center"><button className={button} disabled={busy || !chosen.length} onClick={() => void run(async () => {const row = await service.createDisbursement(chosen); setSelected(row.id); setChosen([]);}, 'Draft batch created; submit it for independent approval.')}>Create draft batch ({chosen.length})</button><button disabled={busy || offset === 0} onClick={() => {setChosen([]);setOffset(Math.max(0,offset-100));}}>Previous earnings</button><button disabled={busy || !candidates?.has_more} onClick={() => {setChosen([]);setOffset(offset+100);}}>Next earnings</button></div>
    <h3 className="font-medium pt-3 border-t">Batches</h3>
    <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50"><tr><th className="p-3">Batch</th><th className="p-3">Status</th><th className="p-3">Gross total</th><th className="p-3">Payment reference</th><th className="p-3">Review</th></tr></thead><tbody>{batches.map(b => <tr key={b.id} className="border-t"><td className="p-3 font-mono text-xs">{b.id.slice(0,8)}</td><td className="p-3">{b.status}</td><td className="p-3">{money(b.gross_amount)}</td><td className="p-3">{b.payment_reference || '—'}</td><td className="p-3"><button disabled={busy} className="text-blue-700 underline" onClick={() => {setDetail(null);setSelected(b.id);}}>View batch</button></td></tr>)}</tbody></table></div>
    {!batches.length && <p className="text-sm text-slate-500">No disbursement batches on this page.</p>}
    <div className="flex gap-3 text-sm"><button disabled={busy || batchOffset === 0} onClick={() => setBatchOffset(Math.max(0,batchOffset-50))}>Previous batches</button><button disabled={busy || batches.length < 50} onClick={() => setBatchOffset(batchOffset+50)}>Next batches</button></div>
    {detail && batch && batch.id === selected && <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
      <h3 className="font-semibold">Batch {batch.id.slice(0,8)} · {batch.status} · {money(batch.gross_amount)}</h3>
      <p className="text-xs text-slate-500 font-mono break-all">{batch.id}</p>
      {detail.earnings.map(e => <p className="text-sm" key={e.id}>{e.snapshot.payee_name} · {e.snapshot.receipt_no} · {money(e.gross_amount)}</p>)}
      {batch.status === 'DRAFT' && batch.created_by === actorId && <button className={button} disabled={busy} onClick={() => void run(() => service.submitDisbursement(batch.id), 'Submitted for independent approval.')}>Submit for approval</button>}
      {batch.status === 'SUBMITTED' && <button className={button} disabled={busy || batch.created_by === actorId} onClick={() => void run(() => service.approveDisbursement(batch.id), 'Disbursement approved; payment has not been recorded.')}>{batch.created_by === actorId ? 'Awaiting another administrator' : 'Approve disbursement'}</button>}
      {['DRAFT','SUBMITTED','APPROVED'].includes(batch.status) && (batch.status === 'DRAFT' || batch.created_by !== actorId) && <form className="flex gap-3" onSubmit={e => {e.preventDefault(); void run(() => service.rejectDisbursement(batch.id, reason), 'Batch closed; earnings released for a new batch.');}}><input required maxLength={500} aria-label="Batch rejection reason" placeholder={batch.status === 'DRAFT' ? 'Cancellation reason' : 'Rejection reason'} className="grow border rounded-lg p-2 text-sm min-w-0" value={reason} onChange={e => setReason(e.target.value)}/><button disabled={busy || !reason.trim()} className="text-red-700 text-sm">{batch.status === 'DRAFT' ? 'Cancel draft' : 'Reject batch'}</button></form>}
      {batch.status === 'APPROVED' && <form className="space-y-3 border-t pt-3" onSubmit={e => {e.preventDefault(); void run(() => service.recordDisbursementPayment(batch.id, reference, confirmed), 'External payment recorded. No money was transferred by this application.');}}><label className="block text-sm">External payment reference<input required maxLength={150} value={reference} onChange={e => setReference(e.target.value)} className="block w-full border rounded-lg p-2 mt-1"/></label><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I confirm the external payment of {money(batch.gross_amount)} has completed.</label><button className={button} disabled={busy || !confirmed || !reference.trim()}>Record completed payment</button></form>}
      {batch.status === 'PAID' && <p className="text-sm text-emerald-800">Payment recorded: {batch.payment_reference}</p>}
      <h4 className="font-medium text-sm border-t pt-3">Audit history</h4>
      {detail.events.map(e => <p key={e.id} className="text-xs text-slate-600 break-all">{new Date(e.created_at+'Z').toLocaleString()} · {e.action} · Actor {e.actor_id}{e.detail ? ` · ${e.detail}` : ''}</p>)}
    </div>}
  </section>;
}
