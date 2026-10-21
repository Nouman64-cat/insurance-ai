"use client";

import { useEffect, useRef } from "react";
import { tx } from "@/lib/i18n/tx";
import { EMPTY_FILTERS, SequenceInfo, formatTime, shortHash } from "@/lib/audit";

import EventDetails from "./EventDetails";
import { ModuleBadge, OutcomeBadge } from "./EventTable";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-1.5 text-xs">
      <dt className="text-slate-500">{tx(label)}</dt>
      <dd className="min-w-0 break-words text-slate-800">{children}</dd>
    </div>
  );
}

interface Props {
  info: SequenceInfo;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNarrow: (patch: Partial<typeof EMPTY_FILTERS>) => void;
  tenantLabel: (tenantId: string | null) => string;
}

/** Shown when a verification names a sequence number whose event is no longer in the ledger. */
export default function MissingEventDrawer({ info, onClose, onOpen, onNarrow, tenantLabel }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { recorded, expected_hash: expected, previous_event: before, next_event: after } = info;

  const recovered = info.recovered;
  const event = recovered?.hash_verified ? recovered.event : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={tx("Missing audit event")}>
      <button type="button" aria-label={tx("Close details")} className="absolute inset-0 bg-slate-900/30" onClick={onClose} tabIndex={-1} />
      <aside className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:max-h-[85dvh]">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{tx("Audit event")} · #{info.sequence_number.toLocaleString()}</p>
            <h2 className="break-all font-mono text-sm font-semibold text-slate-900">{event?.action ?? tx("This event is missing from the ledger")}</h2>
            {event && <div className="flex flex-wrap items-center gap-2"><ModuleBadge module={event.module} /><OutcomeBadge outcome={event.outcome} /></div>}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            {tx("Close")}
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {info.archived && (
            <p role="status" className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              {tx("This event is not missing: it is in cold storage, archive #{0} (sequences {1}–{2}). Use Archive & retention to retrieve and verify it.", { 0: info.archived.archive_number, 1: info.archived.start_sequence, 2: info.archived.end_sequence })}
            </p>
          )}
          <p role="status" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
            {tx("This event is missing from the ledger. Viewing recovered details does not restore it or repair the audit chain.")}
          </p>
          {event ? (
            <>
              <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                {recovered!.source === "recycle_bin"
                  ? tx("Full event details from the demo recycle bin. Their hash matches the surviving ledger record.")
                  : tx("Full event details recovered from the original source message. Their hash matches the surviving ledger record.")}
                {recovered!.source === "kafka" && (
                  <span className="mt-1 block">{tx("Source: Kafka · partition {0} · offset {1}", { 0: recovered!.partition ?? "—", 1: recovered!.offset ?? "—" })}</span>
                )}
              </p>
              <EventDetails event={event} onNarrow={onNarrow} tenantLabel={tenantLabel} />
            </>
          ) : <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            {recovered ? tx("A source message was found, but its contents do not match the stored event hash. Unverified details are withheld.") : tx("Full details could not be recovered. The source message may have expired or be temporarily unavailable. The surviving record is shown below.")}
          </p>}

          <section aria-label={tx("Surviving record")}>
            <h3 className="mb-1 text-xs font-semibold text-slate-700">{tx("Surviving record")}</h3>
            {recorded ? (
              <dl className="divide-y divide-slate-100">
                <Row label="Event id"><span className="font-mono text-[11px]">{recorded.event_id}</span></Row>
                <Row label="Source service">{recorded.service_name}</Row>
                <Row label="Source event id"><span className="font-mono text-[11px]">{recorded.source_event_id}</span></Row>
                <Row label="Recorded in ledger">{formatTime(recorded.recorded_at)}</Row>
                <Row label="Hash it had"><span className="break-all font-mono text-[11px]">{recorded.current_hash}</span></Row>
              </dl>
            ) : (
              <p className="text-xs text-slate-500">{tx("No identifying record survives for this sequence number.")}</p>
            )}
          </section>

          <section aria-label={tx("Hash chain")} className="space-y-2">
            <h3 className="text-xs font-semibold text-slate-700">{tx("Hash chain")}</h3>
            {expected ? (
              <>
                <p className="text-xs text-slate-600">{tx("Event #{0} was written to link to this hash, so the deleted event must have had it:", { 0: after?.sequence_number ?? info.sequence_number + 1 })}</p>
                <p className="break-all rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-700">{expected}</p>
                {recorded && (
                  <p className={`text-xs font-medium ${info.hash_confirmed ? "text-emerald-700" : "text-rose-700"}`}>
                    {info.hash_confirmed ? tx("Matches the surviving record: exactly this event was removed.") : tx("Does not match the surviving record.")}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-slate-500">{tx("No later event survives to confirm the hash.")}</p>
            )}
            <ul className="space-y-1 text-xs">
              {([[before, "before"], [after, "after"]] as const).map(([n, where]) => n && (
                <li key={where} className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">
                    {where === "before" ? tx("Event #{0} (before)", { 0: n.sequence_number }) : tx("Event #{0} (after)", { 0: n.sequence_number })}
                    <span className="ms-2 font-mono text-[11px] text-slate-400">{n.action}</span>
                  </span>
                  <button type="button" className="font-semibold text-slate-700 underline-offset-2 hover:underline" onClick={() => onOpen(n.event_id)}>{tx("Open")}</button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <footer className="shrink-0 border-t border-slate-200 px-5 py-2 text-[11px] text-slate-400" title={info.chain_id}>{tx("Chain")} {shortHash(info.chain_id, 8)}</footer>
      </aside>
    </div>
  );
}
