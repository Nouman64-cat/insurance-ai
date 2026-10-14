"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { api, type Category, type Priority } from "@/lib/api";
import { CATEGORY_HINT, CATEGORY_ICON, CATEGORY_LABEL } from "@/lib/labels";
import { Dialog, ErrorNote, PRIORITY_LABEL, inputClass, labelClass, primaryButton, secondaryButton } from "@/components/satellite/ui";
import CustomerPicker, { type Picked } from "@/components/CustomerPicker";

const NONE: Picked = { customer: null, policy: null };
const EMPTY = { title: "", description: "", category: "GENERAL" as Category, priority: "NORMAL" as Priority };
const RESPONSE: Record<Priority, string> = { URGENT: "within 4 hours", HIGH: "within 1 day", NORMAL: "within 3 days", LOW: "within 5 days" };
const PRIORITY_HELP: Record<Priority, string> = { URGENT: "Customer is in distress or money is at risk", HIGH: "Needs attention soon", NORMAL: "A normal request", LOW: "No rush" };

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-slate-900">{title}</p>
        {hint && <p className="mb-2 text-xs text-slate-500">{hint}</p>}
        {children}
      </div>
    </section>
  );
}

export default function NewTicketDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [picked, setPicked] = useState<Picked>(NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per ticket being written: a double click or a retry after a network error creates one ticket.
  const key = useRef("");

  useEffect(() => {
    if (open) { setForm(EMPTY); setPicked(NONE); setError(null); key.current = crypto.randomUUID(); }
  }, [open]);

  const title = form.title.trim(), description = form.description.trim();
  const problems = {
    title: title.length > 0 && title.length < 3 ? tx("Use at least 3 characters.") : null,
    description: description.length > 0 && description.length < 10 ? tx("Add a little more detail (at least 10 characters).") : null,
  };
  const ready = title.length >= 3 && description.length >= 10;
  const missing = !title ? tx("Write a short subject to continue.") : !ready ? tx("Describe what the customer needs to continue.") : "";

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post("/tickets", {
        ...form, title, description, customer_id: picked.customer?.id ?? null, policy_id: picked.policy?.id ?? null, idempotency_key: key.current,
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
    <Dialog open={open} onClose={onClose} wide title={tx("New ticket")}
      subtitle={tx("A ticket is one customer request. Fill in the four steps; the service team picks it up from the list.")}
      footer={<>
        {!ready && !busy && <span className="me-auto self-center text-xs text-slate-500">{missing}</span>}
        <button type="button" className={secondaryButton} onClick={onClose} disabled={busy}>{tx("Cancel")}</button>
        <button type="button" className={primaryButton} onClick={submit} disabled={!ready || busy}>{busy ? tx("Creating…") : tx("Create ticket")}</button>
      </>}>
      <div className="space-y-6">
        <Step n={1} title={tx("What is it about?")} hint={tx("Pick the closest match. It helps the right person find it.")}>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <button key={c} type="button" onClick={() => setForm({ ...form, category: c })} aria-pressed={form.category === c}
                className={`rounded-lg border px-3 py-2 text-start transition-colors ${form.category === c ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-slate-200 hover:bg-slate-50"}`}>
                <span className="block text-xs font-semibold text-slate-800"><span aria-hidden="true">{CATEGORY_ICON[c]}</span> {tx(CATEGORY_LABEL[c])}</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-slate-500">{tx(CATEGORY_HINT[c])}</span>
              </button>
            ))}
          </div>
        </Step>

        <Step n={2} title={tx("Give it a short subject")} hint={tx("A few words anyone can understand at a glance.")}>
          <input id="t-title" className={inputClass} maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={tx("e.g. Premium receipt not received")} aria-label={tx("Subject")} />
          {hint(problems.title)}
        </Step>

        <Step n={3} title={tx("What does the customer need?")} hint={tx("Say what happened and what they are asking for. Include dates, amounts or names if you have them.")}>
          <textarea id="t-desc" rows={4} maxLength={5000} className={inputClass} value={form.description} aria-label={tx("Description")}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="flex justify-between">{hint(problems.description) ?? <span />}<span className="mt-1 text-[10px] text-slate-400">{form.description.length}/5000</span></div>
        </Step>

        <Step n={4} title={tx("How urgent is it?")} hint={tx("This sets the time the team has to respond. If unsure, leave it on Normal.")}>
          <div className="grid gap-2 sm:grid-cols-4">
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <button key={p} type="button" onClick={() => setForm({ ...form, priority: p })} aria-pressed={form.priority === p}
                className={`rounded-lg border px-3 py-2 text-start ${form.priority === p ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-slate-200 hover:bg-slate-50"}`}>
                <span className="block text-xs font-semibold text-slate-800">{tx(PRIORITY_LABEL[p])}</span>
                <span className="block text-[10.5px] text-slate-500">{tx(PRIORITY_HELP[p])}</span>
                <span className="mt-0.5 block text-[10.5px] font-semibold text-blue-700">{tx("Reply {when}", { when: tx(RESPONSE[p]) })}</span>
              </button>
            ))}
          </div>
        </Step>

        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <p className="text-xs font-bold text-slate-800">{tx("Is it about a particular customer? (optional)")}</p>
          <p className="mb-2 text-[11px] text-slate-500">{tx("Linking the customer lets the team open their record straight from the ticket.")}</p>
          <CustomerPicker value={picked} onChange={setPicked} />
        </div>
        {error && <ErrorNote message={error} />}
      </div>
    </Dialog>
  );
}
