"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { portalUrl } from "@/lib/appLinks";
import { api, type Me, type Status, type Ticket } from "@/lib/api";
import { CATEGORY_ICON, CATEGORY_LABEL, STATUS_HELP, STATUS_LABEL, STATUS_TONE, STEPS, TRANSITIONS, parseStatusEvent, stepIndex } from "@/lib/labels";
import {
  Avatar, Badge, DueLabel, ErrorNote, Field, Priority, Spinner, formatDate, inputClass, primaryButton, relativeTime, secondaryButton,
} from "@/components/satellite/ui";

// One ticket, for someone who has never used the desk: what it is, where it stands, the ONE thing to do next (in a plain
// box at the top), the other things they may do, and the conversation. Only actions the service allows this user are offered;
// the service checks them again.

type Kind = "assign" | "release" | "status";
interface Action { kind: Kind; label: string; status?: Status; /** Pre-filled reason; "" means the person must write it. */ reason?: string; ask?: string; tone?: "primary" | "good" | "danger" | "plain" }

/** What moving a ticket to `to` is called, from where it is now. */
function statusAction(from: Status, to: Status, staff: boolean): Action {
  switch (to) {
    case "IN_PROGRESS":
      return from === "OPEN" ? { kind: "status", status: to, label: "Start working", reason: "Started working on this ticket" }
        : from === "WAITING_CUSTOMER" ? { kind: "status", status: to, label: "Continue working", reason: "The customer replied" }
          : { kind: "status", status: to, label: "Reopen", reason: staff ? "Reopened to continue" : "Not resolved: reopening", ask: staff ? undefined : tx("What is still not sorted?") };
    case "WAITING_CUSTOMER": return { kind: "status", status: to, label: "Wait for the customer", reason: "", ask: tx("What do you need from the customer?") };
    case "RESOLVED": return { kind: "status", status: to, label: "Mark solved", reason: "", ask: tx("What was done? The customer will read this."), tone: "good" };
    case "CLOSED": return { kind: "status", status: to, label: "Close ticket", reason: "Outcome confirmed, closing the ticket" };
    default: return { kind: "status", status: "CANCELLED", label: staff ? "Cancel this ticket" : "Withdraw my request", reason: "", ask: tx("Why is it not needed any more?"), tone: "danger" };
  }
}

export default function TicketPanel({ id, me, onChanged, onClose }: { id: string; me: Me; onChanged: () => void; onClose: () => void }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const replyBox = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    try {
      setTicket((await api.get(`/tickets/${id}`)).data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setTicket(null); setPending(null); setReason(""); setReply(""); setInternal(false);
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
  const isOpen = !["RESOLVED", "CLOSED", "CANCELLED"].includes(ticket.status);
  const mine = ticket.assignee_id === me.id || (!!ticket.assignee_name && ticket.assignee_name === (me.full_name || me.email));
  const admin = me.role_name === "Admin";
  const taken = !!ticket.assignee_name;
  const allowedStatuses = me.staff
    ? TRANSITIONS[ticket.status]
    : TRANSITIONS[ticket.status].filter((s) => (s === "CANCELLED" && ticket.status === "OPEN") || (s === "IN_PROGRESS" && ["RESOLVED", "CLOSED"].includes(ticket.status)));
  // Staff can change a ticket only if it is theirs, or nobody's (an admin may take over from anyone).
  const canWork = me.staff && !closed && (mine || !taken);
  const take: Action = { kind: "assign", label: taken ? "Take over this ticket" : "Take this ticket", tone: "primary" };
  const release: Action = { kind: "release", label: "Hand it back", tone: "plain" };

  // The one recommended step, and the plain-words box that explains it.
  let guide: { icon: string; title: string; text: string; tone: string; primary?: Action };
  if (me.staff) {
    if (closed) guide = { icon: "✅", title: tx("This ticket is finished"), text: tx("There is nothing more to do. If the customer comes back, you can reopen it."), tone: "slate", primary: allowedStatuses.includes("IN_PROGRESS") ? statusAction(ticket.status, "IN_PROGRESS", true) : undefined };
    else if (!taken) guide = { icon: "🙋", title: tx("Nobody is handling this yet"), text: tx("Press “Take this ticket” so your colleagues know it is yours. Then press “Start working” and reply to the customer."), tone: "amber", primary: take };
    else if (!mine) guide = { icon: "👤", title: tx("{name} is handling this", { name: ticket.assignee_name! }), text: admin ? tx("You can read it and add notes. As an admin you can take it over if {name} is away.", { name: ticket.assignee_name! }) : tx("You can read it and add internal notes. Only {name} can change it.", { name: ticket.assignee_name! }), tone: "slate", primary: admin ? take : undefined };
    else if (ticket.status === "OPEN") guide = { icon: "▶️", title: tx("You have this ticket"), text: tx("Press “Start working” when you begin. That tells everyone someone is on it."), tone: "blue", primary: statusAction("OPEN", "IN_PROGRESS", true) };
    else if (ticket.status === "IN_PROGRESS") guide = { icon: "✍️", title: tx("Work on it and keep the customer updated"), text: tx("Write a reply in the box below. If you need something from the customer, choose “Wait for the customer”. When the problem is sorted, press “Mark solved”."), tone: "blue", primary: statusAction("IN_PROGRESS", "RESOLVED", true) };
    else if (ticket.status === "WAITING_CUSTOMER") guide = { icon: "⏳", title: tx("Waiting for the customer"), text: tx("Nothing to do until they reply. When they do, press “Continue working”."), tone: "amber", primary: statusAction("WAITING_CUSTOMER", "IN_PROGRESS", true) };
    else guide = { icon: "🎉", title: tx("This ticket is solved"), text: tx("Close it once the customer is happy. If they say it is not sorted, reopen it."), tone: "emerald", primary: statusAction("RESOLVED", "CLOSED", true) };
  } else if (closed) guide = { icon: "✅", title: tx("This request is finished"), text: ticket.resolution ? tx("The outcome is shown below.") : tx("Nothing more to do."), tone: "slate" };
  else if (ticket.status === "OPEN") guide = { icon: "📨", title: tx("We have received your request"), text: tx("Service staff will pick it up. You can add more details below at any time."), tone: "blue" };
  else if (ticket.status === "IN_PROGRESS") guide = { icon: "🛠️", title: tx("Staff are working on it"), text: tx("You will see their replies below. You can add more details if you want."), tone: "blue" };
  else if (ticket.status === "WAITING_CUSTOMER") guide = { icon: "💬", title: tx("We need an answer from you"), text: tx("Please read the latest message below and reply."), tone: "amber" };
  else guide = { icon: "🎉", title: tx("Your request is solved"), text: tx("Read the outcome below. If it is not sorted, press “Reopen”."), tone: "emerald" };

  const others: Action[] = [
    ...(canWork && mine ? [release] : []),
    ...(canWork || !me.staff ? allowedStatuses.map((s) => statusAction(ticket.status, s, me.staff)) : []),
  ].filter((a) => !(guide.primary && a.kind === "status" && guide.primary.kind === "status" && a.status === guide.primary.status));

  const start = (a: Action) => {
    if (a.kind === "assign") return act("assignment", { version: ticket.version, user_id: me.id });
    if (a.kind === "release") return act("assignment", { version: ticket.version, user_id: null });
    if (a.reason) return setPending(a), setReason(a.reason);           // pre-filled: one more click to confirm, and it can be edited
    setPending(a); setReason("");
  };
  const confirm = () => pending && act("status", { version: ticket.version, status: pending.status, reason: reason.trim() }, () => { setPending(null); setReason(""); });
  const toneBox: Record<string, string> = { amber: "border-amber-200 bg-amber-50", blue: "border-blue-200 bg-blue-50", emerald: "border-emerald-200 bg-emerald-50", slate: "border-slate-200 bg-slate-50" };
  const btn = (a: Action, big = false) => (
    <button key={a.label} type="button" disabled={busy} onClick={() => start(a)}
      className={a.tone === "primary" || (big && a.tone !== "danger" && a.tone !== "good") ? `${primaryButton} ${big ? "" : "!py-1.5 text-xs"}` :
        a.tone === "good" ? `inline-flex items-center rounded-lg border border-emerald-300 bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50` :
        a.tone === "danger" ? "inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50" :
        `${secondaryButton} !py-1.5 text-xs`}>
      {tx(a.label)}
    </button>
  );
  const step = stepIndex(ticket.status);
  const showReply = !closed;
  const asNote = me.staff && internal;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[ticket.status]}>{tx(STATUS_LABEL[ticket.status])}</Badge>
              <Priority value={ticket.priority} />
              <span className="text-[11px] text-slate-500">{CATEGORY_ICON[ticket.category]} {tx(CATEGORY_LABEL[ticket.category] ?? ticket.category)}</span>
            </div>
            <h2 className="mt-2 text-lg font-bold leading-snug text-slate-900">{ticket.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>

        {ticket.status === "CANCELLED" ? <p className="mt-3 text-xs font-semibold text-slate-500">{tx("This ticket was cancelled.")}</p> : (
          <ol className="mt-3 flex items-center" aria-label={tx("Progress")}>
            {STEPS.map((s, i) => (
              <li key={s.status} className="flex flex-1 items-center last:flex-none">
                <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${i <= step ? "text-blue-700" : "text-slate-400"}`} aria-current={i === step ? "step" : undefined}>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${i < step ? "bg-blue-600 text-white" : i === step ? "bg-blue-600 text-white ring-4 ring-blue-100" : "bg-slate-200 text-slate-500"}`}>{i < step ? "✓" : i + 1}</span>
                  {tx(s.label)}
                </span>
                {i < STEPS.length - 1 && <span className={`mx-2 h-0.5 flex-1 rounded ${i < step ? "bg-blue-600" : "bg-slate-200"}`} />}
              </li>
            ))}
          </ol>
        )}
        {ticket.status === "WAITING_CUSTOMER" && <p className="mt-1.5 text-[11px] text-amber-700">{tx(STATUS_HELP.WAITING_CUSTOMER)}</p>}

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label={tx("Raised by")}>{ticket.requester_name}</Field>
          <Field label={tx("Handled by")}>{ticket.assignee_name ?? <span className="text-amber-700">{tx("Nobody yet")}</span>}</Field>
          <Field label={tx("Answer due")}><DueLabel due={ticket.due_at} open={isOpen} overdue={ticket.overdue} /></Field>
          <Field label={tx("Opened")}>{ticket.created_at ? relativeTime(ticket.created_at) : "—"}</Field>
        </dl>
        {(ticket.customer_id || ticket.policy_id) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-500">{tx("Related:")}</span>
            {ticket.customer_id && (
              <a href={portalUrl(`/admin/customers/${ticket.customer_id}/plans`)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200">{tx("Customer record")} ↗</a>
            )}
            {ticket.policy_id && (
              <a href={portalUrl(`/post-issuance/${ticket.policy_id}`)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200">{tx("Policy servicing")} ↗</a>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {error && <ErrorNote message={error} />}

        <div className={`rounded-xl border p-4 ${toneBox[guide.tone]}`}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{tx("What to do now")}</p>
          <div className="mt-1.5 flex items-start gap-3">
            <span className="text-2xl leading-none" aria-hidden="true">{guide.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-slate-900">{guide.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{guide.text}</p>
              {guide.primary && !pending && <div className="mt-3">{btn(guide.primary, true)}</div>}
            </div>
          </div>

          {pending && (
            <div className="mt-3 space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
              <label className="block text-xs font-semibold text-slate-700" htmlFor="reason">{pending.ask ?? tx("Note for the history (you can change it)")}</label>
              <textarea id="reason" rows={2} maxLength={2000} className={inputClass} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">{tx("At least 5 characters. Saved in the ticket history.")}</span>
                <span className="flex gap-2">
                  <button type="button" className={`${secondaryButton} !py-1.5 text-xs`} disabled={busy} onClick={() => { setPending(null); setReason(""); }}>{tx("Not now")}</button>
                  <button type="button" className={`${primaryButton} !py-1.5 text-xs`} disabled={busy || reason.trim().length < 5} onClick={confirm}>{busy ? tx("Saving…") : `${tx("Confirm")}: ${tx(pending.label)}`}</button>
                </span>
              </div>
            </div>
          )}

          {others.length > 0 && !pending && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">{tx("Other options")}</summary>
              <div className="mt-2 flex flex-wrap gap-2">{others.map((a) => btn(a))}</div>
            </details>
          )}
        </div>

        {ticket.resolution && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">{tx("Outcome")}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-900">{ticket.resolution}</p>
          </div>
        )}

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Messages and history")}</p>
          <p className="mb-3 mt-0.5 text-[11px] text-slate-500">
            {me.staff ? tx("Grey bubbles are shared with the customer. Yellow ones are internal notes only your team can see.") : tx("Everything said on this ticket, oldest first.")}
          </p>
          <ol className="space-y-3">
            {(ticket.events ?? []).map((e) => {
              if (e.kind === "STATUS" || e.kind === "ASSIGNMENT") {
                const s = e.kind === "STATUS" ? parseStatusEvent(e.body) : null;
                return (
                  <li key={e.id} className="flex items-start gap-2 ps-10 text-xs text-slate-500">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                    <span>
                      <span className="font-semibold text-slate-700">{e.actor_name}</span>{" "}
                      {s?.to ? tx("moved it to {status}", { status: tx(STATUS_LABEL[s.to] ?? s.to) }) : e.body === "Claimed" ? tx("took the ticket") : e.body === "Released" ? tx("handed the ticket back") : e.body}
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

      {showReply ? (
        <div className="border-t border-slate-100 bg-white px-5 py-3">
          {me.staff && (
            <div role="tablist" aria-label={tx("Message type")} className="mb-2 flex gap-1">
              {[{ v: false, label: tx("Reply to customer") }, { v: true, label: tx("Internal note") }].map((o) => (
                <button key={String(o.v)} type="button" role="tab" aria-selected={internal === o.v} onClick={() => setInternal(o.v)}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold ${internal === o.v ? (o.v ? "bg-amber-100 text-amber-900" : "bg-slate-900 text-white") : "text-slate-600 hover:bg-slate-100"}`}>{o.label}</button>
              ))}
            </div>
          )}
          <textarea ref={replyBox} rows={2} maxLength={5000} className={`${inputClass} ${asNote ? "!border-amber-300 !bg-amber-50" : ""}`} value={reply}
            onChange={(e) => setReply(e.target.value)} placeholder={asNote ? tx("A note for your team. The customer will not see this…") : me.staff ? tx("Write your reply to the customer…") : tx("Write a message to the service team…")} aria-label={tx("Message")} />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-500">{asNote ? tx("Only your team can see this note.") : me.staff ? tx("The customer will see this reply.") : tx("The service team will see this.")}</span>
            <button type="button" className={`${primaryButton} !py-1.5 text-xs`} disabled={busy || !reply.trim()}
              onClick={() => act("comments", { body: reply.trim(), internal: asNote }, () => { setReply(""); })}>
              {asNote ? tx("Save note") : tx("Send reply")}
            </button>
          </div>
        </div>
      ) : (
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{tx("This ticket is finished, so replies are switched off. Reopen it to write again.")}</p>
      )}
    </div>
  );
}
