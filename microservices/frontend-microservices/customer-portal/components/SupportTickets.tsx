"use client";
import { useCallback, useRef, useState } from "react";
import { Banner, EmptyState, ErrorState, Field, Icon, Modal, Skeleton, Spinner, errorText, useToast } from "@/components/ui";
import { ApiError, api, useApi } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { LiveBadge, useLive, type LiveEvent } from "@/lib/live";
import { StatTile } from "@/components/DashboardParts";
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
  const replyKey = useRef(newIdempotencyKey());     // a reply typed once is one reply, however many times the request is retried
  async function act(path: string, body?: unknown, done?: string) {
    setBusy(true); setErr(null);
    const keyed = path === "reply" ? { idempotencyKey: replyKey.current } : {};
    try { await api(`support/tickets/${id}/${path}`, { method: "POST", body: body ?? {}, ...keyed }); if (path === "reply") replyKey.current = newIdempotencyKey(); setText(""); reload(); onChanged(); if (done) toast(done, "success"); }
    catch (e) {
      if (path === "reply" && !["NETWORK", "SERVICE_UNAVAILABLE", "DOMAIN_UNAVAILABLE", "REQUEST_IN_PROGRESS"].includes((e as ApiError).code)) replyKey.current = newIdempotencyKey();
      setErr(e as ApiError);
    } finally { setBusy(false); }
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

const ACTIVE = ["IN_PROGRESS"];

/** The customer's support requests: the counts, then each request as a card. Updates from the service team arrive live. */
export function SupportTickets() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const list = useApi<{ items: SupportTicket[] }>("support/tickets");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const items = list.data?.items || [];
  const reload = list.reload;

  const onLive = useCallback((e: LiveEvent) => {
    if (e.type !== "ticket") return;
    const d = e.data;
    reload();
    const title = d.title;
    const status = t(`ticket.status.${d.status}`);
    toast(d.kind === "new" ? t("live.ticket.new", { title }) : d.kind === "status"
      ? (d.status === "IN_PROGRESS" ? t("live.ticket.handling", { title }) : d.status === "RESOLVED" || d.status === "CLOSED" ? t("live.ticket.resolved", { title })
        : d.status === "WAITING_CUSTOMER" ? t("live.ticket.waiting", { title }) : t("live.ticket.status", { title, status }))
      : t("live.ticket.update", { title }), d.status === "WAITING_CUSTOMER" ? "info" : "success");
    setFlash((f) => new Set(f).add(d.id));
    window.setTimeout(() => setFlash((f) => { const n = new Set(f); n.delete(d.id); return n; }), 6000);
  }, [reload, t, toast]);
  const live = useLive(onLive);

  const stats = {
    open: items.filter((x) => x.status === "OPEN").length,
    progress: items.filter((x) => ACTIVE.includes(x.status) || x.status === "WAITING_CUSTOMER").length,
    resolved: items.filter((x) => x.status === "RESOLVED" || x.status === "CLOSED").length,
    reply: items.filter((x) => x.status === "WAITING_CUSTOMER").length,
  };
  const wait = list.loading && !list.data;
  const down = !!list.error && !list.data;

  return (
    <>
      <section aria-label={t("ticket.summary")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t("ticket.stat.open")} value={stats.open} icon="support" tone={stats.open ? "blue" : "muted"} loading={wait} unavailable={down} note={t("ticket.stat.openNote")} />
        <StatTile label={t("ticket.stat.progress")} value={stats.progress} icon="calendar" tone={stats.progress ? "blue" : "muted"} loading={wait} unavailable={down} note={t("ticket.stat.progressNote")} />
        <StatTile label={t("ticket.stat.resolved")} value={stats.resolved} icon="check" tone={stats.resolved ? "emerald" : "muted"} loading={wait} unavailable={down} note={t("ticket.stat.resolvedNote")} />
        <StatTile label={t("ticket.stat.reply")} value={stats.reply || t("ticket.stat.replyNone")} icon="bell" tone={stats.reply ? "amber" : "muted"} loading={wait} unavailable={down} note={stats.reply ? t("ticket.stat.replyNote") : t("ticket.stat.replyOk")} />
      </section>

      <section aria-labelledby="my-tickets" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="my-tickets" className="flex items-center gap-3 text-sm font-bold text-slate-900">{t("ticket.mine")}<LiveBadge connected={live} label={t("live.on")} offLabel={t("live.off")} /></h3>
          <button type="button" className="btn-primary shadow-md shadow-blue-200" onClick={() => setCreating(true)}>+ {t("ticket.new")}</button>
        </div>
        {wait ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
          : down ? <div className="card"><ErrorState error={list.error} onRetry={list.reload} /></div>
          : items.length === 0 ? <div className="card"><EmptyState title={t("ticket.none")} text={t("ticket.noneText")} action={<button type="button" className="btn-primary" onClick={() => setCreating(true)}>{t("ticket.new")}</button>} /></div>
          : (
            <ul className="space-y-3">
              {items.map((x) => {
                const reply = x.status === "WAITING_CUSTOMER", finished = x.status === "RESOLVED" || x.status === "CLOSED" || x.status === "CANCELLED";
                return (
                  <li key={x.id} className={`flex flex-wrap items-center gap-3 rounded-2xl border bg-white p-4 shadow-[0_2px_12px_rgb(15,23,42,0.04)] transition-all duration-300 hover:shadow-[0_8px_24px_rgb(15,23,42,0.08)] ${flash.has(x.id) ? "border-blue-400 ring-2 ring-blue-300/60" : reply ? "border-amber-300" : "border-slate-200/80"}`}>
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${reply ? "bg-amber-50 text-amber-600" : finished ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`} aria-hidden="true"><Icon name={finished ? "check" : reply ? "bell" : "support"} className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-900">{x.title}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">{t(`ticket.cat.${x.category}`)} · {t("ticket.updated", { when: ago(x.updated_at, locale) })}</p>
                    </div>
                    <Status s={x.status} />
                    <button type="button" onClick={() => setOpen(x.id)} className={reply ? "btn-primary !py-1.5 text-xs" : "btn-secondary !py-1.5 text-xs"}>{reply ? t("ticket.act.reply") : finished ? t("ticket.act.view") : t("ticket.act.open")}</button>
                  </li>
                );
              })}
            </ul>)}
      </section>
      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); list.reload(); setOpen(id); toast(t("ticket.created"), "success"); }} />}
      {open && <TicketView id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </>
  );
}
