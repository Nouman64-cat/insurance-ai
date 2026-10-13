"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { api, type Category, type Priority } from "@/lib/api";
import { CATEGORY_HINT, CATEGORY_LABEL } from "@/lib/labels";
import { Dialog, ErrorNote, PRIORITY_LABEL, inputClass, labelClass, primaryButton, secondaryButton } from "@/components/satellite/ui";

const EMPTY = { title: "", description: "", category: "GENERAL" as Category, priority: "NORMAL" as Priority, customer_id: "", policy_id: "" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function NewTicketDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per ticket being written: a double click or a retry after a network error creates one ticket.
  const key = useRef("");

  useEffect(() => {
    if (open) { setForm(EMPTY); setError(null); key.current = crypto.randomUUID(); }
  }, [open]);

  const problems = {
    title: form.title.trim().length > 0 && form.title.trim().length < 3 ? tx("At least 3 characters.") : null,
    description: form.description.trim().length > 0 && form.description.trim().length < 10 ? tx("At least 10 characters.") : null,
    customer_id: form.customer_id.trim() && !UUID.test(form.customer_id.trim()) ? tx("That isn't a record id.") : null,
    policy_id: form.policy_id.trim() && !UUID.test(form.policy_id.trim()) ? tx("That isn't a record id.") : null,
  };
  const ready = form.title.trim().length >= 3 && form.description.trim().length >= 10 && !Object.values(problems).some(Boolean);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post("/tickets", {
        ...form, title: form.title.trim(), description: form.description.trim(),
        customer_id: form.customer_id.trim() || null, policy_id: form.policy_id.trim() || null, idempotency_key: key.current,
      });
      onCreated(r.data.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hint = (text: string | null) => text ? <p className="mt-1 text-xs text-red-600">{text}</p> : null;

  return (
    <Dialog open={open} onClose={onClose} wide title={tx("New service ticket")}
      subtitle={tx("Log a customer's enquiry or complaint. The service desk picks it up from the queue.")}
      footer={<>
        <button type="button" className={secondaryButton} onClick={onClose} disabled={busy}>{tx("Cancel")}</button>
        <button type="button" className={primaryButton} onClick={submit} disabled={!ready || busy}>{busy ? tx("Creating…") : tx("Create ticket")}</button>
      </>}>
      <div className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="t-title">{tx("Subject")}</label>
          <input id="t-title" className={inputClass} maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={tx("e.g. Premium receipt not received")} />
          {hint(problems.title)}
        </div>
        <div>
          <p className={labelClass}>{tx("Category")}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <button key={c} type="button" onClick={() => setForm({ ...form, category: c })} aria-pressed={form.category === c}
                className={`rounded-lg border px-3 py-2 text-start text-xs transition-colors ${form.category === c ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
                <span className="block font-semibold">{tx(CATEGORY_LABEL[c])}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">{tx(CATEGORY_HINT[form.category])}</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="t-desc">{tx("What does the customer need?")}</label>
          <textarea id="t-desc" rows={5} maxLength={5000} className={inputClass} value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="flex justify-between">{hint(problems.description) ?? <span />}<span className="mt-1 text-[10px] text-slate-400">{form.description.length}/5000</span></div>
        </div>
        <div>
          <p className={labelClass}>{tx("Priority")}</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <button key={p} type="button" onClick={() => setForm({ ...form, priority: p })} aria-pressed={form.priority === p}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${form.priority === p ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                {tx(PRIORITY_LABEL[p])}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">{tx("Target response: Urgent 4 h · High 24 h · Normal 3 days · Low 5 days.")}</p>
        </div>
        <details className="rounded-lg border border-slate-200 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600">{tx("Link a customer or policy (optional)")}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="t-customer">{tx("Customer id")}</label>
              <input id="t-customer" className={inputClass} value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} />
              {hint(problems.customer_id)}
            </div>
            <div>
              <label className={labelClass} htmlFor="t-policy">{tx("Policy id")}</label>
              <input id="t-policy" className={inputClass} value={form.policy_id} onChange={(e) => setForm({ ...form, policy_id: e.target.value })} />
              {hint(problems.policy_id)}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">{tx("Linked records are checked against what you're allowed to see, and open in the portal from the ticket.")}</p>
        </details>
        {error && <ErrorNote message={error} />}
      </div>
    </Dialog>
  );
}
