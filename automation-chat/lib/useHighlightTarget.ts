"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Record highlighting — the "land on the row and make it pop" half of the
 * chatbot's show-record UX.
 *
 * Two cooperating pieces:
 *
 *  1. `requestHighlight(id)` + `useRecordHighlighter()` — a global watcher
 *     (mounted once in ClientLayout). The chatbot stores the target id just
 *     before navigating; after the route change the watcher polls the DOM
 *     (lists load async) for a matching row and pops it. Matching is
 *     `[data-entity-id]` first, then a text-content fallback so pages that
 *     never adopted the data attribute still highlight correctly.
 *
 *  2. `useHighlightTarget(paramName, ready)` — the original per-page hook
 *     (admin/users) that self-selects off its own query param. Upgraded to
 *     the same pop animation.
 */

const STORAGE_KEY = "agent_highlight_target";
const WATCH_TIMEOUT_MS = 12_000; // list pages fetch after mount — be patient
const POLL_INTERVAL_MS = 350;

// Query params list pages already use to self-select a record. The watcher
// also honours these, so a plain link with ?case_id=… pops even when the
// chatbot didn't call requestHighlight.
const HIGHLIGHT_PARAMS = ["highlight", "case_id", "cnic", "userId"];

export function requestHighlight(entityId: string) {
  if (!entityId || typeof window === "undefined") return;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: entityId, ts: Date.now() }));
}

/**
 * Immediately hunt the CURRENT page for the record and pop it. Complements
 * requestHighlight: router.push to a URL identical to the current one is a
 * no-op (no pathname/searchParams change), so the navigation-driven watcher
 * never re-fires — e.g. asking to see the same record twice in a row. Runs
 * the same poll-and-pop directly; if the record isn't on this page the
 * watcher quietly times out while the post-navigation path takes over.
 */
export function triggerHighlight(entityId: string): () => void {
  if (!entityId || typeof window === "undefined") return () => {};
  return watchAndPop(entityId);
}

function popElement(el: HTMLElement) {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("record-pop"); // restart the animation if re-triggered
  // Force a reflow so removing+re-adding the class replays the keyframes.
  void el.offsetWidth;
  el.classList.add("record-pop");
  window.setTimeout(() => el.classList.remove("record-pop"), 3200);
}

function findRecordElement(id: string): HTMLElement | null {
  const exact = document.querySelector<HTMLElement>(`[data-entity-id="${CSS.escape(id)}"]`);
  if (exact) return exact;

  // Fallback: the smallest row-like container whose text mentions the id.
  // Guard against absurdly short ids matching everything.
  if (id.length < 4) return null;
  const candidates = document.querySelectorAll<HTMLElement>("tr, li, [class*='card'], [class*='row']");
  let best: HTMLElement | null = null;
  candidates.forEach((el) => {
    if (!el.textContent?.includes(id)) return;
    // Prefer the deepest (smallest) matching container.
    if (!best || best.contains(el)) best = el;
  });
  return best;
}

function watchAndPop(id: string): () => void {
  const startedAt = Date.now();
  let timer: number | undefined;

  const attempt = () => {
    const el = findRecordElement(id);
    if (el) {
      popElement(el);
      return;
    }
    if (Date.now() - startedAt < WATCH_TIMEOUT_MS) {
      timer = window.setTimeout(attempt, POLL_INTERVAL_MS);
    }
  };
  attempt();
  return () => window.clearTimeout(timer);
}

/** Mount once (ClientLayout). Watches every navigation for a pending
 * highlight request or a recognised query param, then pops the row. */
export function useRecordHighlighter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    let id: string | null = null;

    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { id: string; ts: number };
        // Stale requests (old tab, abandoned nav) shouldn't fire forever.
        if (Date.now() - parsed.ts < 30_000) id = parsed.id;
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }

    if (!id) {
      for (const param of HIGHLIGHT_PARAMS) {
        const v = searchParams.get(param);
        if (v) {
          id = v;
          break;
        }
      }
    }

    if (!id) return;
    return watchAndPop(id);
  }, [pathname, searchParams]);
}

/** Per-page variant: pop the row whose data-entity-id matches `paramName`
 * once the page reports its list is rendered (`ready`). */
export function useHighlightTarget(paramName: string, ready: boolean) {
  const searchParams = useSearchParams();
  const targetId = searchParams.get(paramName);

  useEffect(() => {
    if (!targetId || !ready) return;
    const el = document.querySelector<HTMLElement>(`[data-entity-id="${CSS.escape(targetId)}"]`);
    if (!el) return;
    popElement(el);
  }, [targetId, ready]);
}
