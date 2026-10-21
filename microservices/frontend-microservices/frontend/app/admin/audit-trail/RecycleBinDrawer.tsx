"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { EMPTY_FILTERS, RecycledEvent, auditApi, errorMessage, formatTime } from "@/lib/audit";
import EventDetails from "./EventDetails";
import { ModuleBadge, OutcomeBadge, actorLabel } from "./EventTable";

interface Props {
  onClose: () => void;
  /** Called after an event has been put back, so the page can reload the list and the integrity panels. */
  onRestored: () => void;
  tenantLabel: (tenantId: string | null) => string;
}

/** Demo only (ENV_VAR=demo): events deleted with the demo "Delete event" button, restorable exactly as they were. */
export default function RecycleBinDrawer({ onClose, onRestored, tenantLabel }: Props) {
  const [items, setItems] = useState<RecycledEvent[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await auditApi.demoBin());
    } catch (err) {
      setError(errorMessage(err, tx("Could not load the recycle bin.")));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (binId: string) => {
    setBusy(binId);
    setError("");
    try {
      await auditApi.demoRestore(binId);
      await load();
      onRestored();
    } catch (err) {
      setError(errorMessage(err, tx("Could not restore this event.")));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={tx("Recycle bin")}>
      <button type="button" aria-label={tx("Close recycle bin")} className="absolute inset-0 bg-slate-900/30" onClick={onClose} tabIndex={-1} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-amber-700">{tx("Demo only")}</p>
            <h2 className="text-sm font-semibold text-slate-900">{tx("Recycle bin")}</h2>
            <p className="text-xs text-slate-500">{tx("Events deleted for testing. Restoring puts an event back at its original position, exactly as it was, and the chain verifies again.")}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            {tx("Close")}
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p role="alert" className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
          {items === null && !error && <p className="text-xs text-slate-400">{tx("Loading…")}</p>}
          {items?.length === 0 && <p className="py-10 text-center text-sm text-slate-500">{tx("The recycle bin is empty.")}</p>}
          <ul className="space-y-3">
            {items?.map((item) => {
              const e = item.event;
              const expanded = open === item.bin_id;
              return (
                <li key={item.bin_id} className="rounded-lg border border-slate-200">
                  <div className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-[11px] text-slate-500 tabular-nums">{tx("Event")} #{e.sequence_number.toLocaleString()} · {formatTime(e.timestamp)}</p>
                      <p className="break-all font-mono text-sm font-semibold text-slate-900">{e.action}</p>
                      <div className="flex flex-wrap items-center gap-2"><ModuleBadge module={e.module} /><OutcomeBadge outcome={e.outcome} /></div>
                      <p className="text-[11px] text-slate-500">{actorLabel(e)} · {tx("deleted")} {formatTime(item.deleted_at)}{item.deleted_by ? ` · ${item.deleted_by}` : ""}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <button type="button" disabled={busy !== null} onClick={() => restore(item.bin_id)}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
                        {busy === item.bin_id ? tx("Restoring…") : tx("Restore")}
                      </button>
                      <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.bin_id)}
                        className="text-xs font-semibold text-slate-600 underline-offset-2 hover:underline">
                        {expanded ? tx("Hide details") : tx("Details")}
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="space-y-4 border-t border-slate-100 p-3">
                      <EventDetails event={e} onNarrow={(_patch: Partial<typeof EMPTY_FILTERS>) => undefined} tenantLabel={tenantLabel} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}
