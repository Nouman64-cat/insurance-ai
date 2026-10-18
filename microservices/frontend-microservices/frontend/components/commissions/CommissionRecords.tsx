"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Earning, EarningFilters, Payee } from '@/app/services/commissionEarnings';
import { displayDate } from '@/lib/dateDisplay';
import { tx } from '@/lib/i18n/tx';

export const money = (value: string | number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR' }).format(Number(value));
const input = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';
const statuses: Record<string, { label: string; color: string }> = {
  ACCRUED: { label: 'Accrued', color: 'bg-slate-100 text-slate-600' },
  DRAFT: { label: 'Draft batch', color: 'bg-amber-50 text-amber-700' },
  SUBMITTED: { label: 'Awaiting approval', color: 'bg-amber-50 text-amber-700' },
  APPROVED: { label: 'Approved', color: 'bg-blue-50 text-blue-700' },
  PAID: { label: 'Paid', color: 'bg-emerald-50 text-emerald-700' },
};
export function CommissionStatus({ status = 'ACCRUED' }: { status?: string }) {
  const s = statuses[status] || statuses.ACCRUED;
  return <span className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ${s.color}`}>{tx(s.label)}</span>;
}

export default function CommissionRecords({ entries, total, offset, busy, admin, payees, filters, onFilters, onOffset, onOpen }: {
  entries: Earning[]; total: number; offset: number; busy: boolean; admin: boolean; payees: Payee[]; filters: EarningFilters;
  onFilters: (filters: EarningFilters) => void; onOffset: (offset: number) => void; onOpen: (earning: Earning, edit: boolean) => void;
}) {
  const [query, setQuery] = useState(filters.search || '');
  useEffect(() => setQuery(filters.search || ''), [filters.search]);
  const filtered = Object.values(filters).some(Boolean);
  return <section aria-label={tx('Commission records')} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="flex items-center gap-2"><h2 className="font-semibold text-slate-900">{tx('Commission records')}</h2><span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{total}</span></div>
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>{tx('Created automatically from premium receipts')}</span>
    </div>
    <form className="grid gap-3 border-b border-slate-100 bg-slate-50/60 p-4 sm:grid-cols-2 lg:grid-cols-6" onSubmit={e => { e.preventDefault(); onFilters({ ...filters, search: query.trim() || undefined }); }}>
      <label className="text-xs font-medium text-slate-600 lg:col-span-2">{tx('Search records')}<div className="mt-1 flex gap-2"><input aria-label={tx('Search records')} className={input} value={query} maxLength={200} onChange={e => setQuery(e.target.value)} placeholder={tx('Agent, customer, policy or receipt')}/><button type="submit" className="rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium hover:bg-slate-50" disabled={busy}>{tx('Search')}</button></div></label>
      {admin && <label className="text-xs font-medium text-slate-600">{tx('Agent / producer')}<select className={`${input} mt-1`} value={filters.source_id || ''} onChange={e => onFilters({ ...filters, source_id: e.target.value || undefined })}><option value="">{tx('All producers')}</option>{payees.map(p => <option key={p.id} value={p.id}>{p.name} · {p.code}</option>)}</select></label>}
      <label className="text-xs font-medium text-slate-600">{tx('Payment status')}<select className={`${input} mt-1`} value={filters.disbursement_status || ''} onChange={e => onFilters({ ...filters, disbursement_status: e.target.value || undefined })}><option value="">{tx('All statuses')}</option>{Object.entries(statuses).map(([key, s]) => <option key={key} value={key}>{tx(s.label)}</option>)}</select></label>
      <label className="text-xs font-medium text-slate-600">{tx('Recorded from')}<input type="date" className={`${input} mt-1`} value={filters.date_from || ''} max={filters.date_to} onChange={e => onFilters({ ...filters, date_from: e.target.value || undefined })}/></label>
      <label className="text-xs font-medium text-slate-600">{tx('Recorded to')}<input type="date" className={`${input} mt-1`} value={filters.date_to || ''} min={filters.date_from} onChange={e => onFilters({ ...filters, date_to: e.target.value || undefined })}/></label>
      {filtered && <button type="button" className="justify-self-start text-xs font-medium text-blue-600" onClick={() => onFilters({})}>{tx('Clear filters')}</button>}
    </form>
    <div className="overflow-x-auto" aria-busy={busy}><table className="w-full min-w-[1120px] text-left text-sm"><caption className="sr-only">{tx('Commission earnings generated from received premiums')}</caption>
      <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>{['Recorded / receipt', 'Policy / customer', 'Agent / producer', 'Premium basis', 'Rate / split', 'Commission', 'Payable from', 'Payment status', 'Actions'].map(h => <th scope="col" className={`px-4 py-3 font-medium ${['Premium basis', 'Commission'].includes(h) ? 'text-right' : ''}`} key={h}>{tx(h)}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100">{entries.map(e => <tr key={e.id} className="transition-colors hover:bg-blue-50/30">
        <td className="px-4 py-4"><div className="whitespace-nowrap text-slate-700">{displayDate(e.created_at)}</div><div className="mt-1 font-mono text-xs text-slate-400">{e.snapshot.receipt_no || '—'}</div></td>
        <td className="px-4 py-4"><Link className="font-medium text-blue-600 hover:underline" href={`/post-issuance/${e.policy_id}`}>{e.snapshot.policy_number || tx('View policy')}</Link><div className="mt-1 text-xs text-slate-500">{e.snapshot.customer_name || '—'}</div></td>
        <td className="px-4 py-4"><div className="font-medium text-slate-800">{e.snapshot.payee_name || '—'}</div><div className="mt-1 text-xs text-slate-400">{e.snapshot.payee_code || '—'}</div></td>
        <td title={e.snapshot.basis_description} className="whitespace-nowrap px-4 py-4 text-right tabular-nums text-slate-600">{money(e.basis_amount)}</td>
        <td className="px-4 py-4"><div className="whitespace-nowrap text-slate-700">{Number(e.rate_pct)}% <span className="text-slate-300">/</span> {Number(e.split_pct)}%</div><div className="mt-1 whitespace-nowrap text-xs text-slate-400">{tx(e.snapshot.is_first_premium === false ? 'Recurring' : 'First premium')}{!!e.snapshot.adjustment_revision && <span className="ml-1.5 text-amber-600">· {tx('Adjusted')}</span>}</div></td>
        <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums text-slate-900">{money(e.gross_amount)}</td>
        <td className="whitespace-nowrap px-4 py-4 text-slate-600">{displayDate(e.disburse_date)}</td>
        <td className="px-4 py-4"><CommissionStatus status={e.disbursement_status}/></td>
        <td className="px-4 py-4"><div className="flex items-center gap-3"><button className="text-xs font-medium text-slate-500 hover:text-blue-600" onClick={() => onOpen(e, false)}>{tx('View')}</button>{admin && <button disabled={busy || e.disbursement_status !== 'ACCRUED'} title={e.disbursement_status !== 'ACCRUED' ? tx('Locked while included in a payout batch') : tx('Edit commission record')} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 disabled:cursor-not-allowed disabled:text-slate-300" onClick={() => onOpen(e, true)}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m16 3 5 5-13 13H3v-5L16 3Z"/><path d="m14 5 5 5"/></svg>{tx('Edit')}</button>}</div></td>
      </tr>)}{!entries.length && <tr><td colSpan={9} className="px-6 py-16 text-center"><p className="font-medium text-slate-600">{tx(busy ? 'Loading commission records…' : filtered ? 'No records match these filters' : 'No commission records yet')}</p><p className="mt-2 text-xs text-slate-400">{tx(filtered ? 'Try another search or clear the filters.' : 'Records appear automatically after an issued policy receives an eligible premium.')}</p></td></tr>}</tbody>
    </table></div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 text-xs text-slate-500"><span>{total ? offset + 1 : 0}–{Math.min(offset + entries.length, total)} {tx('of')} {total} {tx('records')}</span><div className="flex gap-2"><button className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40" disabled={busy || offset === 0} onClick={() => onOffset(Math.max(0, offset - 50))}>{tx('Previous')}</button><button className="rounded-md border border-slate-200 px-3 py-1.5 disabled:opacity-40" disabled={busy || offset + 50 >= total} onClick={() => onOffset(offset + 50)}>{tx('Next')}</button></div></div>
  </section>;
}
