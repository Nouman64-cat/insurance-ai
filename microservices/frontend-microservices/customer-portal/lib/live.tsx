"use client";
// Live updates for the signed-in customer (Server-Sent Events, through the portal's own /api/portal/stream). A page gives it one
// function to call when something of the customer's changes; it reports whether the connection is open, for the "Live" badge.
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface LiveClaim { id: string; claim_number: string | null; status_key: string; approved_amount: number | null; settled_amount: number | null; kind: "status" | "update" | "new"; previous: string | null }
export interface LiveTicket { id: string; title: string; status: string; kind: "status" | "update" | "new"; previous: string | null }
export type LiveEvent = { type: "claim"; data: LiveClaim } | { type: "ticket"; data: LiveTicket };

export function useLive(onEvent: (e: LiveEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      es = new EventSource("/api/portal/stream");
      es.addEventListener("ready", () => { delay = 2000; setConnected(true); });
      for (const type of ["claim", "ticket"] as const) {
        es.addEventListener(type, (m) => {
          try { handler.current({ type, data: JSON.parse((m as MessageEvent).data) } as LiveEvent); } catch { /* a malformed event is ignored */ }
        });
      }
      es.onerror = () => {
        // The stream ends on its own every few minutes, and a session may have expired. Quietly renew the session (any API call does that,
        // or sends the customer to sign in), then reconnect with a growing pause.
        es?.close(); setConnected(false);
        if (stopped) return;
        api("me").catch(() => undefined).finally(() => { timer = setTimeout(open, delay); delay = Math.min(delay * 2, 30_000); });
      };
    };
    open();
    return () => { stopped = true; es?.close(); if (timer) clearTimeout(timer); };
  }, []);

  return connected;
}

/** The small "Live" indicator: a pulsing dot while updates are arriving, a quiet "reconnecting" state while they are not. */
export function LiveBadge({ connected, label, offLabel }: { connected: boolean; label: string; offLabel: string }) {
  return (
    <span role="status" title={connected ? label : offLabel} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${connected ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200"}`}>
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-slate-400"}`} />
      </span>
      {connected ? label : offLabel}
    </span>
  );
}
