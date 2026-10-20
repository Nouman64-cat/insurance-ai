"use client";

import { useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  AuditEvent, AuditEventDetail, EMPTY_FILTERS, auditApi, changeRows, errorMessage, formatTime, shortHash, showValue, titleCase,
} from "@/lib/audit";
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-1.5 text-xs">
      <dt className="text-slate-500">{tx(label)}</dt>
      <dd className="min-w-0 break-words text-slate-800">{children}</dd>
    </div>
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
}

export default function EventDrawer({ eventId, onClose, onOpen, onNarrow, tenantLabel }: Props) {
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
  const rows = event ? changeRows(event.previous_value, event.new_value) : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={tx("Audit event details")}>
      <button type="button" aria-label={tx("Close details")} className="absolute inset-0 bg-slate-900/30" onClick={onClose} tabIndex={-1} />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-hidden bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
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
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            {tx("Close")}
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
          {!event && !error && <p className="text-xs text-slate-400">{tx("Loading…")}</p>}

          {event && (
            <>
              <section aria-label={tx("Event")}>
                <dl className="divide-y divide-slate-100">
                  <Row label="Occurred">{formatTime(event.timestamp)}</Row>
                  <Row label="Recorded in ledger">{formatTime(event.recorded_at)}</Row>
                  <Row label="Actor">
                    {actorLabel(event)} <span className="text-slate-400">· {titleCase(event.actor_type)}{event.actor_role ? ` · ${event.actor_role}` : ""}</span>
                    {event.actor_id && <div className="font-mono text-[11px] text-slate-400">{event.actor_id}</div>}
                  </Row>
                  <Row label="Entity">
                    {titleCase(event.entity_type)}
                    {event.entity_id && (
                      <> <button type="button" className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:underline" onClick={() => onNarrow({ entity_type: event.entity_type, entity_id: event.entity_id ?? "" })}>{event.entity_id}</button></>
                    )}
                  </Row>
                  {event.case_id && (
                    <Row label="Case"><button type="button" className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:underline" onClick={() => onNarrow({ case_id: event.case_id ?? "" })}>{event.case_id}</button></Row>
                  )}
                  <Row label="Tenant">{event.tenant_id ? tenantLabel(event.tenant_id) : tx("Platform (system events)")}</Row>
                  <Row label="Source service">{event.service_name}</Row>
                  {event.correlation_id && (
                    <Row label="Request id">
                      <button type="button" className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:underline" title={tx("Show everything from this request")} onClick={() => onNarrow({ correlation_id: event.correlation_id ?? "" })}>{event.correlation_id}</button>
                    </Row>
                  )}
                  <Row label="Event id"><span className="font-mono text-[11px]">{event.event_id}</span></Row>
                </dl>
              </section>

              {rows.length > 0 && (
                <section aria-label={tx("What changed")}>
                  <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("What changed")}</h3>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                        <tr>
                          <th scope="col" className="px-3 py-2 text-left font-medium">{tx("Field")}</th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">{tx("Before")}</th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">{tx("After")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rows.map((r) => (
                          <tr key={r.field} className={r.kind === "same" ? "text-slate-400" : ""}>
                            <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px]">{r.field}</td>
                            <td className={`max-w-[11rem] break-words px-3 py-1.5 ${r.kind === "removed" || r.kind === "changed" ? "text-rose-700" : ""}`}>{showValue(r.before)}</td>
                            <td className={`max-w-[11rem] break-words px-3 py-1.5 ${r.kind === "added" || r.kind === "changed" ? "text-emerald-700" : ""}`}>{showValue(r.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{tx("Credentials, tokens, personal identifiers and document contents are masked or withheld before they reach the audit trail.")}</p>
                </section>
              )}

              {Object.keys(event.metadata ?? {}).length > 0 && (
                <section aria-label={tx("Metadata")}>
                  <h3 className="mb-2 text-xs font-semibold text-slate-700">{tx("Metadata")}</h3>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-snug text-slate-700">{JSON.stringify(event.metadata, null, 2)}</pre>
                </section>
              )}

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
        {event && <footer className="border-t border-slate-200 px-5 py-2 text-[11px] text-slate-400" title={event.chain_id}>{tx("Chain")} {shortHash(event.chain_id, 8)}</footer>}
      </aside>
    </div>
  );
}
