"use client";
import { useState } from "react";
import { Banner, Card, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, errorText, useToast } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { PolicyCard, SupportTicket, SupportTicketDetail, TicketStatus } from "@/lib/types";

// Raise a request to the insurer's service team, follow it, reply, and withdraw or reopen it. The tickets are kept by Customer Service;
// the customer sees only their own, and only the messages meant for them.

const CATEGORIES = ["GENERAL", "POLICY_SERVICING", "BILLING", "CLAIM_ENQUIRY", "COMPLAINT", "DOCUMENTS"] as const;
const TONE: Record<TicketStatus, string> = {
  OPEN: "bg-blue-50 text-blue-700 ring-blue-200", IN_PROGRESS: "bg-indigo-50 text-indigo-700 ring-indigo-200", WAITING_CUSTOMER: "bg-amber-50 text-amber-800 ring-amber-200",
  RESOLVED: "bg-emerald-50 text-emerald-700 ring-emerald-200", CLOSED: "bg-slate-100 text-slate-600 ring-slate-200", CANCELLED: "bg-slate-100 text-slate-600 ring-slate-200",
};
const Status = ({ s }: { s: TicketStatus }) => { const { t } = useI18n(); return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONE[s]}`}>{t(`ticket.status.${s}`)}</span>; };

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const policies = useApi<{ items: PolicyCard[] }>("policies");
  const [f, setF] = useState({ title: "", description: "", category: "GENERAL", policy_id: "" });
  const [key] = useState(newIdempotencyKey);                // one key per form: a double click or retry creates one ticket
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ok = f.title.trim().length >= 3 && f.description.trim().length >= 10;
  const demo = () => setF({ title: "Change my contact address", description: "I have moved to a new house and need my address updated on all my policies. Please tell me what documents you need.", category: "POLICY_SERVICING", policy_id: policies.data?.items[0]?.id ?? "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { title: f.title.trim(), description: f.description.trim(), category: f.category };
      if (f.policy_id) body.policy_id = f.policy_id;
      const r = await api<{ id: string }>("support/tickets", { method: "POST", body, idempotencyKey: key });
      onCreated(r.id);
    } catch (err) { setError(err as ApiError); setBusy(false); }
  }
  return (
    <Modal title={t("ticket.new")} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="danger" title={errorText(t, error)} />}
        <div className="flex justify-end"><button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={demo}>{t("ticket.demo")}</button></div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label={t("ticket.category")} htmlFor="t_cat">
            <select id="t_cat" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{t(`ticket.cat.${c}`)}</option>)}</select>
          </Field>
          <Field label={t("ticket.policy")} htmlFor="t_pol" hint={t("ticket.policyHint")}>
            <select id="t_pol" className="input" value={f.policy_id} onChange={(e) => setF({ ...f, policy_id: e.target.value })}>
              <option value="">{t("ticket.noPolicy")}</option>
              {(policies.data?.items || []).map((p) => <option key={p.id} value={p.id}>{p.policy_number} — {p.product_name}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t("ticket.subject")} htmlFor="t_title"><input id="t_title" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} required /></Field>
        <Field label={t("ticket.details")} htmlFor="t_desc" hint={f.description.trim().length > 0 && f.description.trim().length < 10 ? t("ticket.moreChars", { n: 10 - f.description.trim().length }) : t("ticket.detailsHint")}>
          <textarea id="t_desc" className="input min-h-[120px]" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} required />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="submit" className="btn-primary" disabled={!ok || busy}>{busy ? <><Spinner />{t("common.submitting")}</> : t("ticket.submit")}</button>
        </div>
      </form>
    </Modal>
  );
}

function TicketView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data: d, error, loading, reload } = useApi<SupportTicketDetail>(`support/tickets/${id}`);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function act(path: string, body?: unknown, done?: string) {
    setBusy(true); setErr(null);
    try { await api(`support/tickets/${id}/${path}`, { method: "POST", body: body ?? {} }); setText(""); reload(); onChanged(); if (done) toast(done, "success"); }
    catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const finished = d && ["CLOSED", "CANCELLED"].includes(d.status);
  return (
    <Modal title={d?.title || t("ticket.title")} onClose={onClose} busy={busy} wide>
      {loading && !d ? <Skeleton className="h-40" /> : error && !d ? <ErrorState error={error} onRetry={reload} /> : d && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><Status s={d.status} /><span>{t(`ticket.cat.${d.category}`)}</span><span>· {t("ticket.opened", { when: dateTime(d.created_at) })}</span></div>
          {d.status === "WAITING_CUSTOMER" && <Banner tone="warning" title={t("ticket.waiting")}>{t("ticket.waitingText")}</Banner>}
          {d.resolution && <Banner tone="success" title={t("ticket.outcome")}>{d.resolution}</Banner>}
          {err && <Banner tone="danger" title={errorText(t, err)} />}
          <ol className="space-y-2.5">
            {d.events.filter((e) => e.kind !== "STATUS" || true).map((e) => e.kind === "STATUS" ? (
              <li key={e.id} className="text-xs text-slate-400 ps-2">{e.actor_name} — {t("ticket.statusChanged")} · {dateTime(e.created_at)}</li>
            ) : (
              <li key={e.id} className="rounded-xl bg-slate-100 px-3.5 py-2.5">
                <p className="text-[11px] text-slate-500"><span className="font-semibold text-slate-700">{e.actor_name}</span> · {dateTime(e.created_at)}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{e.body}</p>
              </li>
            ))}
          </ol>
          {!finished && (
            <div className="space-y-2">
              <textarea className="input min-h-[80px]" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} placeholder={t("ticket.replyPh")} aria-label={t("ticket.reply")} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {d.status === "OPEN" ? <button type="button" className="btn-danger" disabled={busy} onClick={() => window.confirm(t("ticket.withdrawConfirm")) && act("withdraw", {}, t("ticket.withdrawn"))}>{t("ticket.withdraw")}</button> : <span />}
                <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={() => act("reply", { body: text.trim() }, t("ticket.sent"))}>{busy ? <Spinner /> : t("ticket.send")}</button>
              </div>
            </div>
          )}
          {d.status === "RESOLVED" && <div className="flex justify-end"><button type="button" className="btn-secondary" disabled={busy || text.trim().length < 5} title={t("ticket.reopenHint")} onClick={() => act("reopen", { body: text.trim() }, t("ticket.reopened"))}>{t("ticket.reopen")}</button></div>}
          {finished && <p className="text-xs text-slate-500">{t("ticket.finished")}</p>}
        </div>
      )}
    </Modal>
  );
}

export function SupportTickets() {
  const { t } = useI18n();
  const toast = useToast();
  const list = useApi<{ items: SupportTicket[] }>("support/tickets");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const items = list.data?.items || [];
  return (
    <>
      <Card title={t("ticket.mine")} action={<button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => setCreating(true)}>+ {t("ticket.new")}</button>}>
        {list.loading && !list.data ? <Skeleton className="h-20" /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
          : items.length === 0 ? <EmptyState title={t("ticket.none")} text={t("ticket.noneText")} action={<button type="button" className="btn-primary" onClick={() => setCreating(true)}>{t("ticket.new")}</button>} />
          : (
            <ul className="divide-y divide-slate-100 -my-2">
              {items.map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => setOpen(x.id)} className="w-full flex items-center justify-between gap-3 py-3 text-start hover:bg-slate-50 rounded-lg px-1">
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-800">{x.title}</span>
                      <span className="block text-[11px] text-slate-500">{t(`ticket.cat.${x.category}`)} · {t("ticket.updated", { when: dateTime(x.updated_at) })}</span></span>
                    <Status s={x.status} />
                  </button>
                </li>))}
            </ul>)}
      </Card>
      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); list.reload(); setOpen(id); toast(t("ticket.created"), "success"); }} />}
      {open && <TicketView id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </>
  );
}
