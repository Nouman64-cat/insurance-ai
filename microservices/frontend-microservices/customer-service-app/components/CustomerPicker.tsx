"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { inputClass, labelClass, useDebounced } from "@/components/satellite/ui";
import { customerPolicies, searchCustomers, type CustomerHit, type PolicyHit } from "@/lib/records";

// "Who is this about?" Type a name or CNIC, pick the customer, optionally pick one of their policies.
export interface Picked { customer: CustomerHit | null; policy: PolicyHit | null }

export default function CustomerPicker({ value, onChange }: { value: Picked; onChange: (v: Picked) => void }) {
  const [term, setTerm] = useState("");
  const q = useDebounced(term, 300);
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [policies, setPolicies] = useState<PolicyHit[] | null>(null);

  useEffect(() => {
    if (value.customer || q.trim().length < 2) { setHits(null); return; }
    let alive = true;
    setFailed(false);
    searchCustomers(q.trim()).then((r) => alive && setHits(r)).catch(() => alive && (setHits([]), setFailed(true)));
    return () => { alive = false; };
  }, [q, value.customer]);

  useEffect(() => {
    if (!value.customer) { setPolicies(null); return; }
    let alive = true;
    customerPolicies(value.customer.id).then((r) => alive && setPolicies(r)).catch(() => alive && setPolicies([]));
    return () => { alive = false; };
  }, [value.customer]);

  if (value.customer) {
    const c = value.customer;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <span className="min-w-0 text-sm"><span className="font-semibold text-slate-900">{c.name}</span><span className="ms-2 text-xs text-slate-500">{[c.cnic, c.city].filter(Boolean).join(" · ")}</span></span>
          <button type="button" className="shrink-0 text-xs font-semibold text-blue-700 hover:underline" onClick={() => { onChange({ customer: null, policy: null }); setTerm(""); }}>{tx("Change")}</button>
        </div>
        <div>
          <label className={labelClass} htmlFor="t-policy">{tx("Which policy? (optional)")}</label>
          <select id="t-policy" className={inputClass} value={value.policy?.id ?? ""} disabled={!policies}
            onChange={(e) => onChange({ customer: c, policy: policies?.find((p) => p.id === e.target.value) ?? null })}>
            <option value="">{!policies ? tx("Loading…") : policies.length ? tx("Not about a specific policy") : tx("This customer has no policies yet")}</option>
            {(policies ?? []).map((p) => <option key={p.id} value={p.id}>{p.policy_number ? `${p.policy_number} · ` : ""}{p.product_name} ({p.status})</option>)}
          </select>
        </div>
      </div>
    );
  }
  return (
    <div>
      <input className={inputClass} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tx("Type a customer's name or CNIC…")} aria-label={tx("Find a customer")} />
      {q.trim().length >= 2 && hits && (
        <ul className="mt-1.5 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
          {hits.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">{failed ? tx("Could not search right now. You can still create the ticket without a customer.") : tx("No customer found. You can still create the ticket without one.")}</li>}
          {hits.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => { onChange({ customer: c, policy: null }); setHits(null); }} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-blue-50">
                <span className="font-semibold text-slate-800">{c.name}</span>
                <span className="text-xs text-slate-500">{[c.cnic, c.city].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
