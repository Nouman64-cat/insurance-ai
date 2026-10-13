"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { portalUrl } from "@/lib/appLinks";
import { api, type Me, type Status, type Ticket } from "@/lib/api";
import { ACTION_LABEL, CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE, TRANSITIONS, parseStatusEvent } from "@/lib/labels";
import {
  Avatar, Badge, DueLabel, ErrorNote, Field, Priority, Spinner, formatDate, inputClass, primaryButton, relativeTime, secondaryButton,
} from "@/components/satellite/ui";

// One ticket: what was asked, who has it, what's next, and the conversation. Only the actions the service allows
// this user are offered; the service checks them again.

const ACTION_STYLE: Partial<Record<Status, string>> = {
  RESOLVED: "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
  CANCELLED: "border-red-200 bg-white text-red-700 hover:bg-red-50",
};

export default function TicketPanel({ id, me, onChanged, onClose }: { id: string; me: Me; onChanged: () => void; onClose: () => void }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<Status | null>(null);
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);

  const load = async () => {
    try {
      setTicket((await api.get(`/tickets/${id}`)).data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setTicket(null); setTarget(null); setReason(""); setReply(""); setInternal(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const act = async (path: string, payload: unknown, after?: () => void) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/tickets/${id}/${path}`, payload);
      after?.();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      if ((e as Error & { status?: number }).status === 409) await load(); // changed by someone else: show the latest
    } finally {
      setBusy(false);
    }
  };

  if (!ticket) {
    return <div className="flex h-full items-center justify-center">{error ? <div className="p-6"><ErrorNote message={error} onRetry={load} /></div> : <Spinner />}</div>;
  }

  const closed = ticket.status === "CLOSED" || ticket.status === "CANCELLED";
  const mine = ticket.assignee_id === me.id || ticket.assignee_name === (me.full_name || me.email);
  const allowed = me.staff
    ? TRANSITIONS[ticket.status]
    : TRANSITIONS[ticket.status].filter((s) => (s === "CANCELLED" && ticket.status === "OPEN") || (s === "IN_PROGRESS" && ["RESOLVED", "CLOSED"].includes(ticket.status)));
  const reasonLabel = target === "RESOLVED" ? tx("Resolution (the customer-facing outcome)") : tx("Reason");

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[ticket.status]}>{tx(STATUS_LABEL[ticket.status])}</Badge>
              <Priority value={ticket.priority} />
              <span className="text-[11px] text-slate-500">{tx(CATEGORY_LABEL[ticket.category] ?? ticket.category)}</span>
            </div>
            <h2 className="mt-2 text-lg font-bold leading-snug text-slate-900">{ticket.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label={tx("Raised by")}>{ticket.requester_name}</Field>
          <Field label={tx("Handled by")}>{ticket.assignee_name ?? <span className="text-slate-400">{tx("Unassigned")}</span>}</Field>
          <Field label={tx("Due")}><DueLabel due={ticket.due_at} open={!["RESOLVED", "CLOSED", "CANCELLED"].includes(ticket.status)} overdue={ticket.overdue} /></Field>
          <Field label={tx("Opened")}>{ticket.created_at ? relativeTime(ticket.created_at) : "—"}</Field>
        </dl>
        {(ticket.customer_id || ticket.policy_id) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {ticket.customer_id && (
              <a href={portalUrl(`/admin/customers/${ticket.customer_id}/plans`)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200">
                {tx("Customer record")} ↗
              </a>
            )}
            {ticket.policy_id && (
              <a href={portalUrl(`/post-issuance/${ticket.policy_id}`)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200">
                {tx("Policy servicing")} ↗
              </a>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {error && <ErrorNote message={error} />}

        {ticket.resolution && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">{tx("Resolution")}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-900">{ticket.resolution}</p>
          </div>
        )}

        {(me.staff && !closed) || allowed.length > 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Next step")}</p>
            <div className="flex flex-wrap gap-2">
              {me.staff && !closed && (mine
                ? <button type="button" className={`${secondaryButton} !py-1.5 text-xs`} disabled={busy} onClick={() => act("assignment", { version: ticket.version, user_id: null })}>{tx("Release")}</button>
                : <button type="button" className={`${primaryButton} !py-1.5 text-xs`} disabled={busy} onClick={() => act("assignment", { version: ticket.version, user_id: me.id })}>{ticket.assignee_name ? tx("Take over") : tx("Assign to me")}</button>)}
              {allowed.map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => { setTarget(target === s ? null : s); setReason(""); }} aria-pressed={target === s}
                  className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-semibold ${target === s ? "border-blue-500 bg-blue-50 text-blue-800" : ACTION_STYLE[s] ?? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                  {tx(ticket.status === "RESOLVED" || ticket.status === "CLOSED" ? (s === "IN_PROGRESS" ? "Reopen" : ACTION_LABEL[s]) : ACTION_LABEL[s])}
                </button>
              ))}
            </div>
            {target && (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-semibold text-slate-600" htmlFor="reason">{reasonLabel}</label>
                <textarea id="reason" rows={2} maxLength={2000} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">{tx("At least 5 characters. Recorded in the history.")}</span>
                  <button type="button" className={`${primaryButton} !py-1.5 text-xs`} disabled={busy || reason.trim().length < 5}
                    onClick={() => act("status", { version: ticket.version, status: target, reason: reason.trim() }, () => { setTarget(null); setReason(""); })}>
                    {busy ? tx("Saving…") : tx(ACTION_LABEL[target])}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Conversation and history")}</p>
          <ol className="space-y-3">
            {(ticket.events ?? []).map((e) => {
              if (e.kind === "STATUS" || e.kind === "ASSIGNMENT") {
                const s = e.kind === "STATUS" ? parseStatusEvent(e.body) : null;
                return (
                  <li key={e.id} className="flex items-start gap-2 ps-10 text-xs text-slate-500">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                    <span>
                      <span className="font-semibold text-slate-700">{e.actor_name}</span>{" "}
                      {s?.to ? tx("moved it to {status}", { status: tx(STATUS_LABEL[s.to] ?? s.to) }) : e.body === "Claimed" ? tx("took the ticket") : e.body === "Released" ? tx("released the ticket") : e.body}
                      {s?.reason && s.to ? <span className="text-slate-600"> — “{s.reason}”</span> : null}
                      <span className="ms-1 text-slate-400">· {formatDate(e.created_at, true)}</span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={e.id} className="flex items-start gap-2">
                  <Avatar name={e.actor_name} internal={e.internal} />
                  <div className={`min-w-0 flex-1 rounded-lg px-3 py-2 ${e.internal ? "border border-amber-200 bg-amber-50" : "bg-slate-100"}`}>
                    <p className="text-[11px] text-slate-500">
                      <span className="font-semibold text-slate-700">{e.actor_name}</span>
                      {e.kind === "CREATED" ? ` · ${tx("opened the ticket")}` : ""}
                      {e.internal ? ` · ${tx("Internal note")}` : ""} · {formatDate(e.created_at, true)}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{e.body}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {!closed ? (
        <div className="border-t border-slate-100 bg-white px-5 py-3">
          <textarea rows={2} maxLength={5000} className={`${inputClass} ${internal ? "!border-amber-300 !bg-amber-50" : ""}`} value={reply}
            onChange={(e) => setReply(e.target.value)} placeholder={internal ? tx("Internal note for the service desk…") : tx("Write a reply…")} aria-label={tx("Reply")} />
          <div className="mt-2 flex items-center justify-between">
            {me.staff ? (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                {tx("Internal note (staff only)")}
              </label>
            ) : <span />}
            <button type="button" className={`${primaryButton} !py-1.5 text-xs`} disabled={busy || !reply.trim()}
              onClick={() => act("comments", { body: reply.trim(), internal }, () => { setReply(""); setInternal(false); })}>
              {internal ? tx("Add note") : tx("Send reply")}
            </button>
          </div>
        </div>
      ) : (
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{tx("This ticket is closed. Reopen it to reply.")}</p>
      )}
    </div>
  );
}
