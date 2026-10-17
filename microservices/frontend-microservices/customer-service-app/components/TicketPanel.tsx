"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { portalUrl } from "@/lib/appLinks";
import { api, core, type LinkedCustomer, type LinkedPolicy, type Me, type Status, type Ticket } from "@/lib/api";
import { CATEGORY_ICON, CATEGORY_LABEL, SLA_LABEL, SLA_TONE, STATUS_HELP, STATUS_LABEL, STATUS_TONE, STEPS, TRANSITIONS, isOpenStatus, parseStatusEvent, shortId, slaState, stepIndex } from "@/lib/labels";
import {
  Avatar, Badge, DueLabel, ErrorNote, Field, Priority, Spinner, formatDate, inputClass, primaryButton, relativeTime, secondaryButton,
} from "@/components/satellite/ui";

// One ticket as a workspace: its status, assignment and SLA (three separate things), the next step and other quick actions, the
// conversation, internal notes and activity, and who and what it is about. Only actions the service allows this user are offered;
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

type Tab = "conversation" | "notes" | "activity";
const money = (n?: number | null) => (n == null ? "—" : `PKR ${Math.round(n).toLocaleString()}`);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-b border-slate-100 px-4 py-3.5"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>{children}</section>;
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-3 py-1 text-xs"><dt className="shrink-0 text-slate-500">{label}</dt><dd className="min-w-0 text-end font-medium text-slate-800">{children}</dd></div>;
}

export default function TicketPanel({ id, me, onChanged, onClose, notify }: { id: string; me: Me; onChanged: () => void; onClose: () => void; notify?: (tone: "ok" | "err", text: string) => void }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState("");
  const [tab, setTab] = useState<Tab>("conversation");
  const [customer, setCustomer] = useState<LinkedCustomer | null>(null);
  const [policy, setPolicy] = useState<LinkedPolicy | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      setTicket((await api.get(`/tickets/${id}`)).data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setTicket(null); setPending(null); setReason(""); setReply(""); setTab("conversation"); setCustomer(null); setPolicy(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Linked records are read from tenant-service with the person's own token, so its access rules apply. If they can't be read,
  // the section simply shows the link instead.
  useEffect(() => {
    if (!ticket || !me.staff || !me.tenant_id) return;
    if (ticket.customer_id) core.get(`/tenants/${me.tenant_id}/customers/${ticket.customer_id}`).then((r) => setCustomer(r.data)).catch(() => undefined);
    if (ticket.policy_id) core.get(`/tenants/${me.tenant_id}/policies/${ticket.policy_id}`).then((r) => setPolicy(r.data)).catch(() => undefined);
  }, [ticket?.customer_id, ticket?.policy_id, me.staff, me.tenant_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (tab !== "activity") endRef.current?.scrollIntoView({ block: "end" }); }, [ticket?.events?.length, tab]);

  const act = async (path: string, payload: unknown, after?: () => void, done?: string) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/tickets/${id}/${path}`, payload);
      after?.();
      await load();
      onChanged();
      if (done) notify?.("ok", done);
    } catch (e) {
      setError((e as Error).message);
      notify?.("err", (e as Error).message);
      if ((e as Error & { status?: number }).status === 409) await load(); // changed by someone else: show the latest
    } finally {
      setBusy(false);
    }
  };

  if (!ticket) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex justify-end p-3"><button type="button" onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">✕</button></div>
        <div className="flex flex-1 items-center justify-center">{error ? <div className="p-6"><ErrorNote message={error} onRetry={load} /></div> : <Spinner />}</div>
      </div>
    );
  }

  const closed = ticket.status === "CLOSED" || ticket.status === "CANCELLED";
  const isOpen = isOpenStatus(ticket.status);
  const sla = slaState(ticket);
  const mine = ticket.assignee_id === me.id || (!!ticket.assignee_name && ticket.assignee_name === (me.full_name || me.email));
  const admin = me.role_name === "Admin";
  const taken = !!ticket.assignee_name;
  const allowedStatuses = me.staff
    ? TRANSITIONS[ticket.status]
    : TRANSITIONS[ticket.status].filter((s) => (s === "CANCELLED" && ticket.status === "OPEN") || (s === "IN_PROGRESS" && ["RESOLVED", "CLOSED"].includes(ticket.status)));
  // Staff can change a ticket only if it is theirs, or nobody's (an admin may take over from anyone).
  const viewOnly = me.staff && me.can_work === false;                 // an admin: sees everything, the service desk works the tickets
  const canWork = me.staff && !viewOnly && !closed && (mine || !taken);
  const take: Action = { kind: "assign", label: taken ? "Take over" : "Take this ticket", tone: "primary" };
  const release: Action = { kind: "release", label: "Hand back", tone: "plain" };

  // The one recommended next step, as a single line.
  let next: { text: string; primary?: Action; tone: string };
  if (viewOnly) next = { text: ticket.assignee_name ? tx("{name} is handling this. Admins can view tickets; the service desk works them.", { name: ticket.assignee_name }) : tx("Admins can view tickets. The service desk works them."), tone: "slate" };
  else if (me.staff) {
    if (closed) next = { text: tx("This ticket is finished. Reopen it if the customer comes back."), tone: "slate", primary: allowedStatuses.includes("IN_PROGRESS") ? statusAction(ticket.status, "IN_PROGRESS", true) : undefined };
    else if (!taken) next = { text: tx("Nobody is handling this yet."), tone: "amber", primary: take };
    else if (!mine) next = { text: admin ? tx("{name} is handling this. As an admin you can take it over.", { name: ticket.assignee_name! }) : tx("{name} is handling this. You can add internal notes.", { name: ticket.assignee_name! }), tone: "slate", primary: admin ? take : undefined };
    else if (ticket.status === "OPEN") next = { text: tx("It is yours. Start working when you begin."), tone: "blue", primary: statusAction("OPEN", "IN_PROGRESS", true) };
    else if (ticket.status === "IN_PROGRESS") next = { text: tx("Reply to the customer, then mark it solved."), tone: "blue", primary: statusAction("IN_PROGRESS", "RESOLVED", true) };
    else if (ticket.status === "WAITING_CUSTOMER") next = { text: tx("Waiting for the customer to reply."), tone: "amber", primary: statusAction("WAITING_CUSTOMER", "IN_PROGRESS", true) };
    else next = { text: tx("Solved. Close it once the customer is happy."), tone: "emerald", primary: statusAction("RESOLVED", "CLOSED", true) };
  } else if (closed) next = { text: ticket.resolution ? tx("Finished. The outcome is shown below.") : tx("Finished."), tone: "slate" };
  else if (ticket.status === "OPEN") next = { text: tx("We have your request. Service staff will pick it up."), tone: "blue" };
  else if (ticket.status === "IN_PROGRESS") next = { text: tx("Staff are working on it."), tone: "blue" };
  else if (ticket.status === "WAITING_CUSTOMER") next = { text: tx("We need an answer from you. Reply below."), tone: "amber" };
  else next = { text: tx("Solved. If it is not sorted, reopen it."), tone: "emerald" };

  const others: Action[] = [
    ...(canWork && mine ? [release] : []),
    ...(canWork || !me.staff ? allowedStatuses.map((s) => statusAction(ticket.status, s, me.staff)) : []),
  ].filter((a) => !(next.primary && a.kind === "status" && next.primary.kind === "status" && a.status === next.primary.status));

  const start = (a: Action) => {
    if (a.kind === "assign") return act("assignment", { version: ticket.version, user_id: me.id }, undefined, tx("You took this ticket."));
    if (a.kind === "release") return act("assignment", { version: ticket.version, user_id: null }, undefined, tx("Ticket handed back."));
    setPending(a); setReason(a.reason ?? "");
  };
  const confirm = () => pending && act("status", { version: ticket.version, status: pending.status, reason: reason.trim() }, () => { setPending(null); setReason(""); }, tx("Ticket updated."));
  const toneBox: Record<string, string> = { amber: "border-amber-200 bg-amber-50", blue: "border-blue-200 bg-blue-50", emerald: "border-emerald-200 bg-emerald-50", slate: "border-slate-200 bg-slate-50" };
  const btn = (a: Action, big = false) => (
    <button key={a.label} type="button" disabled={busy} onClick={() => start(a)}
      className={a.tone === "primary" || (big && a.tone !== "danger" && a.tone !== "good") ? `${primaryButton} !py-1.5 text-xs` :
        a.tone === "good" ? "inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50" :
        a.tone === "danger" ? "inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50" :
        `${secondaryButton} !py-1.5 text-xs`}>
      {tx(a.label)}
    </button>
  );

  const events = ticket.events ?? [];
  const isLog = (k: string) => k === "STATUS" || k === "ASSIGNMENT";
  const messages = events.filter((e) => !isLog(e.kind) && !e.internal);
  const notes = events.filter((e) => !isLog(e.kind) && e.internal);
  const log = events.filter((e) => isLog(e.kind));
  const step = stepIndex(ticket.status);
  const asNote = me.staff && tab === "notes";
  const canWrite = !closed && !viewOnly && (tab === "conversation" || (tab === "notes" && me.staff));
  const tabs: { v: Tab; label: string; n?: number }[] = [
    { v: "conversation", label: tx("Conversation"), n: messages.length },
    ...(me.staff ? [{ v: "notes" as Tab, label: tx("Internal notes"), n: notes.length }] : []),
    { v: "activity", label: tx("Activity"), n: log.length },
  ];

  const bubble = (e: (typeof events)[number]) => (
    <li key={e.id} className="flex items-start gap-2.5">
      <Avatar name={e.actor_name} internal={e.internal} />
      <div className={`min-w-0 flex-1 rounded-xl px-3.5 py-2.5 ${e.internal ? "border border-amber-200 bg-amber-50" : "bg-slate-100"}`}>
        <p className="text-[11px] text-slate-500"><span className="font-semibold text-slate-700">{e.actor_name}</span>{e.kind === "CREATED" ? ` · ${tx("opened the ticket")}` : ""} · {formatDate(e.created_at, true)}</p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{e.body}</p>
      </div>
    </li>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 px-5 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[11px] font-semibold text-blue-700">{shortId(ticket.id)} · <span className="font-sans text-slate-500">{CATEGORY_ICON[ticket.category]} {tx(CATEGORY_LABEL[ticket.category] ?? ticket.category)}</span></p>
            <h2 className="mt-0.5 text-lg font-bold leading-snug text-slate-900">{ticket.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">{tx("Status")}<Badge tone={STATUS_TONE[ticket.status]}>{tx(STATUS_LABEL[ticket.status])}</Badge></span>
              <span className="flex items-center gap-1.5">{tx("Assignment")}{taken ? <Badge tone="blue" dot={false}>{ticket.assignee_name}</Badge> : <Badge tone={isOpen ? "amber" : "slate"} dot={false}>{tx("Unassigned")}</Badge>}</span>
              <span className="flex items-center gap-1.5">{tx("SLA")}<Badge tone={SLA_TONE[sla]} dot={false}>{tx(SLA_LABEL[sla])}</Badge></span>
              <Priority value={ticket.priority} />
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>

        <div className={`mt-3 rounded-lg border px-3 py-2.5 ${toneBox[next.tone]}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-700"><span className="font-bold text-slate-900">{tx("Next")}:</span> {next.text}</p>
            {!pending && (
              <div className="flex flex-wrap items-center gap-1.5">
                {next.primary && btn(next.primary, true)}
                {others.map((a) => btn(a))}
              </div>
            )}
          </div>
          {pending && (
            <div className="mt-2.5 space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
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
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div role="tablist" aria-label={tx("Ticket sections")} className="flex gap-1 border-b border-slate-100 px-4">
            {tabs.map((t) => (
              <button key={t.v} type="button" role="tab" aria-selected={tab === t.v} onClick={() => setTab(t.v)}
                className={`-mb-px border-b-2 px-3 py-2.5 text-xs font-semibold ${tab === t.v ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
                {t.label}{t.n ? <span className="ms-1.5 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-600">{t.n}</span> : null}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {error && <ErrorNote message={error} />}
            {ticket.resolution && tab === "conversation" && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">{tx("Outcome")}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-900">{ticket.resolution}</p>
              </div>
            )}
            {tab === "conversation" && (messages.length ? <ol className="space-y-3">{messages.map(bubble)}</ol> : <p className="py-8 text-center text-xs text-slate-400">{tx("No messages yet.")}</p>)}
            {tab === "notes" && (
              <>
                <p className="text-[11px] text-slate-500">{tx("Only your team can see these notes. The customer cannot.")}</p>
                {notes.length ? <ol className="space-y-3">{notes.map(bubble)}</ol> : <p className="py-8 text-center text-xs text-slate-400">{tx("No internal notes yet.")}</p>}
              </>
            )}
            {tab === "activity" && (
              log.length ? (
                <ol className="relative ms-2 space-y-4 border-s border-slate-200 ps-5">
                  {log.map((e) => {
                    const s = e.kind === "STATUS" ? parseStatusEvent(e.body) : null;
                    return (
                      <li key={e.id} className="relative text-xs text-slate-600">
                        <span className="absolute -start-[1.6rem] top-1 h-2.5 w-2.5 rounded-full bg-blue-500 ring-4 ring-white" />
                        <span className="font-semibold text-slate-800">{e.actor_name}</span>{" "}
                        {s?.to ? tx("moved it to {status}", { status: tx(STATUS_LABEL[s.to] ?? s.to) }) : e.body === "Claimed" ? tx("took the ticket") : e.body === "Released" ? tx("handed the ticket back") : e.body}
                        {s?.reason && s.to ? <span className="block text-slate-500">“{s.reason}”</span> : null}
                        <span className="block text-[11px] text-slate-400">{formatDate(e.created_at, true)}</span>
                      </li>
                    );
                  })}
                </ol>
              ) : <p className="py-8 text-center text-xs text-slate-400">{tx("No activity yet.")}</p>
            )}
            <div ref={endRef} />
          </div>

          {canWrite ? (
            <div className="border-t border-slate-100 bg-white px-5 py-3">
              <textarea rows={2} maxLength={5000} className={`${inputClass} ${asNote ? "!border-amber-300 !bg-amber-50" : ""}`} value={reply} onChange={(e) => setReply(e.target.value)} aria-label={tx("Message")}
                placeholder={asNote ? tx("A note for your team…") : me.staff ? tx("Write your reply to the customer…") : tx("Write a message to the service team…")}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && reply.trim() && !busy) act("comments", { body: reply.trim(), internal: asNote }, () => setReply(""), asNote ? tx("Note saved.") : tx("Reply sent.")); }} />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">{asNote ? tx("Only your team can see this note.") : me.staff ? tx("The customer will see this reply.") : tx("The service team will see this.")}</span>
                <button type="button" className={`${primaryButton} !py-1.5 text-xs`} disabled={busy || !reply.trim()}
                  onClick={() => act("comments", { body: reply.trim(), internal: asNote }, () => setReply(""), asNote ? tx("Note saved.") : tx("Reply sent."))}>
                  {busy ? tx("Saving…") : asNote ? tx("Save note") : tx("Send reply")}
                </button>
              </div>
            </div>
          ) : closed && tab !== "activity" ? (
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{tx("This ticket is finished, so replies are switched off. Reopen it to write again.")}</p>
          ) : null}
        </div>

        <aside className="max-h-72 shrink-0 overflow-y-auto border-t border-slate-200 bg-slate-50/60 lg:max-h-none lg:w-72 lg:border-s lg:border-t-0" aria-label={tx("Ticket details")}>
          <Section title={tx("Progress")}>
            {ticket.status === "CANCELLED" ? <p className="text-xs font-semibold text-slate-500">{tx("This ticket was cancelled.")}</p> : (
              <ol className="space-y-1.5">
                {STEPS.map((s, i) => (
                  <li key={s.status} className={`flex items-center gap-2 text-xs font-medium ${i <= step ? "text-blue-700" : "text-slate-400"}`} aria-current={i === step ? "step" : undefined}>
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${i < step ? "bg-blue-600 text-white" : i === step ? "bg-blue-600 text-white ring-4 ring-blue-100" : "bg-slate-200 text-slate-500"}`}>{i < step ? "✓" : i + 1}</span>
                    {tx(s.label)}
                  </li>
                ))}
              </ol>
            )}
            {ticket.status === "WAITING_CUSTOMER" && <p className="mt-2 text-[11px] text-amber-700">{tx(STATUS_HELP.WAITING_CUSTOMER)}</p>}
          </Section>
          <Section title={tx("Details")}>
            <dl>
              <Row label={tx("Raised by")}>{ticket.requester_name}</Row>
              <Row label={tx("Assigned to")}>{ticket.assignee_name ?? <span className="text-amber-700">{tx("Unassigned")}</span>}</Row>
              <Row label={tx("Answer due")}><DueLabel due={ticket.due_at} open={isOpen} overdue={ticket.overdue} /></Row>
              <Row label={tx("Opened")}>{ticket.created_at ? relativeTime(ticket.created_at) : "—"}</Row>
              <Row label={tx("Updated")}>{ticket.updated_at ? relativeTime(ticket.updated_at) : "—"}</Row>
            </dl>
          </Section>
          {(ticket.customer_id || ticket.policy_id) && (
            <Section title={tx("Linked records")}>
              {ticket.customer_id && (
                <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Customer")}</p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900">{customer?.name ?? tx("Customer record")}</p>
                  {customer && <p className="text-[11px] text-slate-500">{[customer.city, customer.details?.contact_email ?? customer.details?.contact?.email, customer.details?.contact_phone ?? customer.details?.contact?.mobile_number].filter(Boolean).join(" · ")}</p>}
                  <a href={portalUrl(`/admin/customers/${ticket.customer_id}/plans`)} className="mt-1.5 inline-block text-[11px] font-semibold text-blue-600 hover:text-blue-800">{tx("Open customer record")} ↗</a>
                </div>
              )}
              {ticket.policy_id && (
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Policy")}</p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900">{policy ? `${policy.policy_number ?? tx("Number pending")} · ${policy.product_name}` : tx("Policy record")}</p>
                  {policy && <p className="text-[11px] text-slate-500">{[policy.status, money(policy.coverage_amount), policy.term_years ? `${policy.term_years} ${tx("years")}` : null].filter(Boolean).join(" · ")}</p>}
                  <a href={portalUrl(`/post-issuance/${ticket.policy_id}`)} className="mt-1.5 inline-block text-[11px] font-semibold text-blue-600 hover:text-blue-800">{tx("Open policy servicing")} ↗</a>
                </div>
              )}
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}
