"use client";

import { useEffect, useRef, useState } from 'react';
import * as service from '@/app/services/commissionEarnings';
import { displayDate, displayDateTime } from '@/lib/dateDisplay';
import { tx } from '@/lib/i18n/tx';
import { CommissionStatus, money } from './CommissionRecords';

const input = 'mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';

export default function CommissionRecordDrawer({ earning, edit, admin, onClose, onSaved }: {
  earning: service.Earning; edit: boolean; admin: boolean; onClose: () => void; onSaved: (earning: service.Earning) => Promise<void>;
}) {
  const [editing, setEditing] = useState(edit);
  const [rate, setRate] = useState(String(Number(earning.rate_pct)));
  const [date, setDate] = useState(earning.disburse_date || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; close.current?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busyRef.current) closeRef.current();
      if (e.key === 'Tab' && dialog.current) {
        const nodes = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]')).filter(el => el.offsetParent !== null);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  const editable = admin && earning.disbursement_status === 'ACCRUED';
  const changed = Number(rate) !== Number(earning.rate_pct) || date !== (earning.disburse_date || '');
  const preview = Number(earning.basis_amount) * Number(rate) * Number(earning.split_pct) / 10000;
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const updated = await service.updateEarning(earning.id, { rate_pct: rate, disburse_date: date, reason: reason.trim(), expected_revision: earning.snapshot.adjustment_revision || 0 });
      await onSaved(updated);
    } catch (err) { setError(err instanceof Error ? err.message : tx('Unable to save commission record')); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[80] flex justify-end bg-slate-900/30 backdrop-blur-[2px]">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="commission-record-title" className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5"><div><p className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">{tx('Commission record')}</p><h2 id="commission-record-title" className="mt-1 text-xl font-semibold text-slate-900">{tx(editing && editable ? 'Edit commission' : 'Commission details')}</h2><p className="mt-1 text-xs text-slate-400">{earning.snapshot.receipt_no} · {earning.snapshot.policy_number || '—'}</p></div><button ref={close} aria-label={tx('Close commission record')} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40" disabled={busy} onClick={onClose}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-6 flex items-start justify-between rounded-xl border border-slate-100 bg-slate-50 p-4"><div><p className="text-xs text-slate-500">{tx('Commission amount')}</p><p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{money(earning.gross_amount)}</p><p className="mt-1 text-xs text-slate-400">{tx('Gross commission')}</p></div><CommissionStatus status={earning.disbursement_status}/></div>
        <dl className="mb-6 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">{[
          ['Agent / producer', `${earning.snapshot.payee_name} · ${earning.snapshot.payee_code}`],
          ['Customer', earning.snapshot.customer_name], ['Premium basis', money(earning.basis_amount)],
          ['Producer split', `${Number(earning.split_pct)}%`], ['Commission rate', `${Number(earning.rate_pct)}%`],
          ['Payable from', displayDate(earning.disburse_date)], ['Recorded', displayDateTime(earning.created_at)],
          ['Original rule', earning.rule_code ? `${earning.rule_code} · v${earning.rule_version}` : earning.snapshot.agreement_code || '—'],
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-400">{tx(label)}</dt><dd className="mt-1 break-words font-medium text-slate-700">{value || '—'}</dd></div>)}</dl>
        {editable && !editing && <button className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-600" onClick={() => setEditing(true)}>{tx('Edit commission record')}</button>}
        {!editable && admin && <p className="mb-6 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">{tx('This record is locked while included in a payout batch. Unpaid batches can be cancelled or rejected before making a correction.')}</p>}
        {editing && editable && <form id="commission-edit-form" onSubmit={save} className="space-y-4 border-t border-slate-100 pt-5">
          <p className="text-xs leading-relaxed text-slate-500">{tx('This corrects this earning only. Future commissions continue to use the Rule Engine. The premium basis, producer split and original rule are preserved.')}</p>
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <fieldset disabled={busy} className="space-y-4">
            <div className="grid grid-cols-2 gap-4"><label className="text-xs font-medium text-slate-600">{tx('Commission rate (%)')}<input className={input} required type="number" min="0" max="100" step="0.0001" value={rate} onChange={e => setRate(e.target.value)}/></label><label className="text-xs font-medium text-slate-600">{tx('Payable from')}<input className={input} required type="date" value={date} onChange={e => setDate(e.target.value)}/></label></div>
            <div className="flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-sm"><span className="text-blue-700">{tx('Updated commission')}</span><strong className="tabular-nums text-blue-800">{Number.isFinite(preview) && rate !== '' ? money(preview) : '—'}</strong></div>
            <label className="block text-xs font-medium text-slate-600">{tx('Reason for change')}<textarea className={`${input} min-h-[90px] resize-y`} required minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder={tx('Explain this correction for the record history')}/></label>
          </fieldset>
        </form>}
        <section className="mt-6 border-t border-slate-100 pt-5"><h3 className="text-sm font-semibold text-slate-800">{tx('Record history')}</h3>
          {[...(earning.snapshot.adjustments || [])].reverse().map(change => <div key={change.revision} className="mt-4 border-l-2 border-amber-200 pl-3"><p className="text-xs font-medium text-slate-700">{change.actor_name} · {displayDateTime(change.at)}</p><p className="mt-1 text-sm text-slate-600">{change.reason}</p><p className="mt-1 text-xs text-slate-400">{tx('Rate')}: {Number(change.before.rate_pct)}% → {Number(change.after.rate_pct)}% · {money(change.before.gross_amount)} → {money(change.after.gross_amount)}</p><p className="mt-1 text-xs text-slate-400">{tx('Payable from')}: {displayDate(change.before.disburse_date)} → {displayDate(change.after.disburse_date)}</p></div>)}
          <div className="mt-4 border-l-2 border-emerald-200 pl-3"><p className="text-xs font-medium text-slate-700">{tx('Created automatically from premium receipts')}</p><p className="mt-1 text-xs text-slate-400">{displayDateTime(earning.created_at)} · {earning.snapshot.receipt_no}</p>{earning.snapshot.original_posting && <p className="mt-1 text-xs text-slate-400">{Number(earning.snapshot.original_posting.rate_pct)}% · {money(earning.snapshot.original_posting.gross_amount)} · {displayDate(earning.snapshot.original_posting.disburse_date)}</p>}</div>
        </section>
      </div>
      <div className="flex justify-end gap-3 border-t border-slate-100 bg-white px-6 py-4"><button disabled={busy} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600" onClick={onClose}>{tx('Close')}</button>{editing && editable && <button form="commission-edit-form" type="submit" disabled={busy || !changed || !rate || !date || reason.trim().length < 5} className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">{tx(busy ? 'Saving…' : 'Save changes')}</button>}</div>
    </div>
  </div>;
}
