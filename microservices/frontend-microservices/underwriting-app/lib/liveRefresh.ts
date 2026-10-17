"use client";

import { useCallback, useEffect, useRef } from "react";
import type { CaseEvent } from "@/lib/agent/useCaseEvents";

// Live updates for the underwriting screens, kept cheap.
//
// The gateway's event stream carries every write in the tenant: a "DataChanged" event follows any successful
// POST/PUT/PATCH/DELETE under /tenants/<id>/<resource>, including commissions, claims, rule edits and user admin.
// Re-reading the whole underwriting queue for each of those cost a full /cases request per write anywhere in the
// company, and bursts (a census upload, a bulk status change) fired many at once. Tab focus, visibility and a
// reconnect could also each trigger their own refresh at the same moment.

/** Resources whose writes cannot change what the underwriting screens show. Anything else does refresh, including
 *  resources added later: missing an update is worse than an extra request. */
const UNRELATED_RESOURCES = new Set([
  "claims",
  "commissions",
  "commission-rules",
  "bonus-plans",
  "payees",
  "payout-runs",
  "statements",
  "rules",
  "rule-sets",
  "categories",
  "users",
  "roles",
  "branches",
  "acquisition-sources",
  "insurance-plans",
  "tokens",
  "llm-config",
  "search",
]);

/** Whether a live event can change the underwriting queue or a case's gates. */
export function affectsUnderwriting(evt: CaseEvent): boolean {
  if (evt.case_id) return true; // EApplicationSubmitted, ACRSubmitted, MedicalExamCompleted, ...
  if (evt.event_type !== "DataChanged") return false;
  const resource = typeof evt.detail?.resource === "string" ? evt.detail.resource : "";
  return !UNRELATED_RESOURCES.has(resource);
}

/**
 * Wraps a refresh so that calls arriving close together run it once (after `delayMs`), and a call made while one
 * is running queues exactly one more run afterwards: never two requests in flight for the same data, and never a
 * stale result winning because it was the last to arrive. Returns the request function.
 */
export function useCoalescedRefresh(refresh: () => Promise<unknown> | void, delayMs = 300): () => void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const again = useRef(false);

  const run = useCallback(async () => {
    timer.current = null;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      await refreshRef.current();
    } catch {
      /* the caller keeps its last good data */
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        timer.current = setTimeout(run, delayMs);
      }
    }
  }, [delayMs]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return useCallback(() => {
    if (running.current) {
      again.current = true;
      return;
    }
    if (timer.current) return; // already scheduled: this call is covered by it
    timer.current = setTimeout(run, delayMs);
  }, [run, delayMs]);
}
