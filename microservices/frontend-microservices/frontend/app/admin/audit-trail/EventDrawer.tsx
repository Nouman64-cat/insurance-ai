"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  AuditEvent, AuditEventDetail, EMPTY_FILTERS, auditApi, errorMessage, formatTime, shortHash, titleCase,
} from "@/lib/audit";
import EventDetails from "./EventDetails";
import { ModuleBadge, OutcomeBadge, actorLabel } from "./EventTable";

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={tx("Copy {0}", { 0: label })}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable */ }
      }}
      className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
    >
      {done ? tx("Copied") : tx("Copy")}
    </button>
  );
}

function HashLine({ label, hash }: { label: string; hash: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{tx(label)}</span>
        <Copy value={hash} label={label} />
      </div>
      <p className="break-all rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11px] leading-snug text-slate-700">{hash}</p>
    </div>
  );
}

interface Props {
  eventId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNarrow: (patch: Partial<typeof EMPTY_FILTERS>) => void;
  tenantLabel: (tenantId: string | null) => string;
  /** Demo only (ENV_VAR=demo): show a button that deletes this event so the integrity checks can be seen catching it. */
  demo?: boolean;
  onDeleted?: () => void;
}

export default function EventDrawer({ eventId, onClose, onOpen, onNarrow, tenantLabel, demo = false, onDeleted }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteEvent = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await auditApi.demoDelete(eventId);
      onDeleted?.();
    } catch (err) {
      setDeleteError(errorMessage(err, tx("Could not delete this event.")));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };
  const [event, setEvent] = useState<AuditEventDetail | null>(null);
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setEvent(null);
    setTimeline([]);
    setError("");
    (async () => {
      try {
        const detail = await auditApi.event(eventId);
        if (cancelled) return;
        setEvent(detail);
        const related = detail.entity_id
          ? await auditApi.events({ ...EMPTY_FILTERS, entity_type: detail.entity_type, entity_id: detail.entity_id, tenant: "" }, 1, 50)
          : null;
        if (!cancelled && related) setTimeline([...related.items].sort((a, b) => a.sequence_number - b.sequence_number));
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, tx("Could not load this event.")));
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const previousLinked = event && (event.previous_event ? event.previous_event.current_hash === event.previous_hash : true);
  const nextLinked = event && (event.next_event ? event.next_event.previous_hash === event.current_hash : true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={tx("Audit event details")}>
      <button type="button" aria-label={tx("Close details")} className="absolute inset-0 bg-slate-900/30" onClick={onClose} tabIndex={-1} />
      <aside className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:max-h-[85dvh]">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{tx("Audit event")}{event ? ` · #${event.sequence_number.toLocaleString()}` : ""}</p>
            <h2 className="break-all font-mono text-sm font-semibold text-slate-900">{event?.action ?? "…"}</h2>
            {event && (
              <div className="flex flex-wrap items-center gap-2">
                <ModuleBadge module={event.module} />
                <OutcomeBadge outcome={event.outcome} />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {demo && event && (confirming ? (
              <>
                <button type="button" disabled={deleting} onClick={deleteEvent} className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
                  {deleting ? tx("Deleting…") : tx("Confirm delete")}
                </button>
                <button type="button" disabled={deleting} onClick={() => setConfirming(false)} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                  {tx("Cancel")}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} title={tx("Demo only: removes this event from the ledger so you can watch verification catch it. It can be restored from the recycle bin.")}
                className="rounded-md border border-rose-300 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50">
                {tx("Delete event")}
              </button>
            ))}
            <button ref={closeRef} type="button" onClick={onClose} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              {tx("Close")}
            </button>
          </div>
        </header>
        {deleteError && <p role="alert" className="border-b border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-700">{deleteError}</p>}

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
          {!event && !error && <p className="text-xs text-slate-400">{tx("Loading…")}</p>}

          {event && (
            <>
              <EventDetails event={event} onNarrow={onNarrow} tenantLabel={tenantLabel} />

              <section aria-label={tx("Hash chain")} className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-700">{tx("Hash chain")} <span className="font-normal text-slate-400">· SHA-256 · v{event.hash_version}</span></h3>
                <HashLine label="Previous hash" hash={event.previous_hash} />
                <HashLine label="Current hash" hash={event.current_hash} />
                <ul className="space-y-1 text-xs">
                  <li className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">{event.previous_event ? tx("Event #{0} (before)", { 0: event.previous_event.sequence_number }) : tx("First event in the chain")}</span>
                    <span className="flex items-center gap-2">
                      <span className={previousLinked ? "text-emerald-700" : "text-rose-700"}>{previousLinked ? tx("Linked") : tx("Link broken")}</span>
                      {event.previous_event && <button type="button" className="font-semibold text-slate-700 underline-offset-2 hover:underline" onClick={() => onOpen(event.previous_event!.event_id)}>{tx("Open")}</button>}
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">{event.next_event ? tx("Event #{0} (after)", { 0: event.next_event.sequence_number }) : tx("Latest event in the chain")}</span>
                    <span className="flex items-center gap-2">
                      <span className={nextLinked ? "text-emerald-700" : "text-rose-700"}>{nextLinked ? tx("Linked") : tx("Link broken")}</span>
                      {event.next_event && <button type="button" className="font-semibold text-slate-700 underline-offset-2 hover:underline" onClick={() => onOpen(event.next_event!.event_id)}>{tx("Open")}</button>}
                    </span>
                  </li>
                </ul>
                <p className="text-[11px] text-slate-400">{tx("This neighbour check is a quick indicator. Use “Verify chain” for the authoritative result, which recomputes every hash.")}</p>
              </section>

              {timeline.length > 1 && (
                <section aria-label={tx("Timeline")}>
                  <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("Timeline for this {0}", { 0: titleCase(event.entity_type).toLowerCase() })}</h3>
                  <ol className="relative space-y-3 border-s border-slate-200 ps-4">
                    {timeline.map((t) => (
                      <li key={t.event_id} className="relative">
                        <span className={`absolute -start-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white ${t.event_id === event.event_id ? "bg-slate-900" : "bg-slate-300"}`} aria-hidden="true" />
                        <button type="button" onClick={() => onOpen(t.event_id)} aria-current={t.event_id === event.event_id}
                          className={`block w-full text-start text-xs ${t.event_id === event.event_id ? "font-semibold text-slate-900" : "text-slate-600 hover:text-slate-900"}`}>
                          <span className="font-mono">{t.action}</span>
                          <span className="block text-[11px] font-normal text-slate-400">{formatTime(t.timestamp)} · {actorLabel(t)} · #{t.sequence_number}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </div>
        {event && <footer className="shrink-0 border-t border-slate-200 px-5 py-2 text-[11px] text-slate-400" title={event.chain_id}>{tx("Chain")} {shortHash(event.chain_id, 8)}</footer>}
      </aside>
    </div>
  );
}
