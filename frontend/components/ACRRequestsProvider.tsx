"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listMyACRRequests, type ACRRequest } from "@/app/services/agentConfidentialReport";
import { useCaseEvents, type CaseEvent } from "@/lib/agent/useCaseEvents";
import { useNotify } from "@/components/NotificationContext";

// The web counterpart of the agent app's ACRRequestsProvider: the Agent's Confidential
// Reports this user has been asked to file. When a case passes Gate 1 the portal
// addresses its ACR to the case's agent (POST /acr/request, or automatically on
// e-application approval) and publishes `ACRRequested`; this re-reads the list on that
// event, toasts each request the user hasn't been told about yet, and feeds the bell
// in the TopBar. "Seen" is remembered per user, so a request raised while they were
// signed out is announced at their next sign-in, once.

const POLL_MS = 60_000; // fallback while the live stream is down
const WATCHED_EVENTS = new Set(["ACRRequested", "ACRSubmitted", "DataChanged"]);

const SEGMENT: Record<ACRRequest["segment"], string> = { individual: "Individual", family: "Family", organization: "Corporate" };

interface ACRRequestsContextValue {
  requests: ACRRequest[];
  refresh: () => void;
}

const ACRRequestsContext = createContext<ACRRequestsContextValue>({ requests: [], refresh: () => {} });

export const useACRRequests = () => useContext(ACRRequestsContext);

const seenKey = () => `acr_requests_seen:${localStorage.getItem("user_email") ?? ""}`;
const readSeen = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(seenKey()) || "[]"));
  } catch {
    return new Set();
  }
};
const writeSeen = (ids: Set<string>) => {
  try {
    localStorage.setItem(seenKey(), JSON.stringify(Array.from(ids)));
  } catch { /* storage unavailable — worst case the toast repeats */ }
};

export function ACRRequestsProvider({ children }: { children: ReactNode }) {
  const { notify } = useNotify();
  const [requests, setRequests] = useState<ACRRequest[]>([]);
  // Only tenant users can be asked for an ACR (a SuperAdmin has no tenant).
  const [enabled, setEnabled] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    setEnabled(!!localStorage.getItem("tenant_id") && !!localStorage.getItem("jwt_token") && localStorage.getItem("user_role") !== "SuperAdmin");
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const incoming = await listMyACRRequests();
      setRequests(incoming);
      const seen = readSeen();
      const fresh = incoming.filter((r) => r.status === "Requested" && !seen.has(r.case_id));
      fresh.forEach((r) => {
        const who = r.applicant_name || r.case_number || "a case";
        const group = r.group_name ? ` (${r.group_name})` : "";
        notify(`ACR requested: ${who}${group} · ${SEGMENT[r.segment] ?? "Case"} ${r.case_number ?? ""} — click to file`, true, `case/${r.case_id}`);
        seen.add(r.case_id);
      });
      // Forget cases that are no longer pending, so a re-request later is announced again.
      const pending = new Set(incoming.map((r) => r.case_id));
      writeSeen(new Set(Array.from(seen).filter((id) => pending.has(id))));
    } catch { /* transient — next event or poll retries */ } finally {
      inFlight.current = false;
    }
  }, [notify]);

  const live = useCaseEvents(
    useCallback((evt: CaseEvent) => {
      if (WATCHED_EVENTS.has(evt.event_type)) load();
    }, [load]),
    enabled,
  );

  useEffect(() => {
    if (!enabled) return;
    load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || live) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, live, load]);

  return <ACRRequestsContext.Provider value={{ requests, refresh: load }}>{children}</ACRRequestsContext.Provider>;
}
