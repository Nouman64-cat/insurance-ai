"use client";

import {useEffect, useState} from 'react';
import * as service from '@/app/services/commissionEarnings';

export default function PlanCommissionRules({agreements, onChange}: {agreements: service.Agreement[]; onChange: () => Promise<void>}) {
  const [data, setData] = useState<service.PlanRules | null>(null);
  const [plan, setPlan] = useState('');
  const [agreement, setAgreement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {let current = true; service.loadPlanRules().then(d => {if (current) setData(d);}).catch(e => {if (current) setError(e.message);}); return () => {current = false;};}, [agreements]);
  return <section className="rounded-xl border border-indigo-200 bg-white p-5 space-y-4">
    <h2 className="font-semibold">Automatic commission by plan</h2>
    <p className="text-sm text-slate-600">Link an approved rate agreement once. When a premium receipt is recorded, the customer’s assigned agent receives a 100% allocation automatically. Existing policy splits take priority.</p>
    <p className="text-xs text-slate-500">New policies use the latest rate version effective on their first receipt date. Existing posted allocations keep their agreed rate and producer. Expired versions create an exception.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <form className="flex flex-wrap gap-3 items-end" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {await service.linkPlanAgreement(plan, agreement); setData(await service.loadPlanRules()); setAgreement(''); await onChange();}
      catch (err) {setError(err instanceof Error ? err.message : 'Unable to link plan');} finally {setBusy(false);}
    }}>
      <label className="grow text-sm">Insurance plan<select required aria-label="Commission plan" className="block w-full rounded-lg border p-2 mt-1" value={plan} onChange={e => setPlan(e.target.value)}><option value="">Select individual plan</option>{data?.plans.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="grow text-sm">Approved rate agreement<select required aria-label="Plan rate agreement" className="block w-full rounded-lg border p-2 mt-1" value={agreement} onChange={e => setAgreement(e.target.value)}><option value="">Select approved agreement</option>{agreements.filter(a => a.status === 'APPROVED').map(a => <option key={a.id} value={a.id}>{a.code} v{a.version} · {Number(a.first_year_pct)}% / {Number(a.renewal_pct)}% · from {a.effective_from}</option>)}</select></label>
      <button disabled={busy || !plan || !agreement} className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm disabled:opacity-50">Enable automatic allocation</button>
    </form>
    {!data?.rules.length && <p className="text-sm text-slate-500">No plan rates linked yet. Create and approve an agreement below, then link it here.</p>}
    {data?.rules.map(r => {const p = data.plans.find(p => p.id === r.plan_id); const a = agreements.find(a => a.id === r.agreement_id); return <div key={r.id} className="border-t pt-3 text-sm"><strong>{p?.label || r.plan_id}</strong> · {a ? `${a.code} v${a.version} · first year ${Number(a.first_year_pct)}% · renewal ${Number(a.renewal_pct)}% · ${a.effective_from} – ${a.effective_to || 'open ended'}` : r.agreement_id}</div>;})}
  </section>;
}
