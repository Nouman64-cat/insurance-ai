"use client";

import { useEffect, useState } from "react";

/**
 * Per-viewer card show/hide state for a dashboard, persisted to
 * localStorage under `dash-visible:<dashboardKey>`. Defaults every card in
 * `cardIds` to visible; unknown/removed ids are dropped automatically.
 */
export function useCardVisibility(dashboardKey: string, cardIds: string[]) {
  const storageKey = `dash-visible:${dashboardKey}`;
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(cardIds.map((id) => [id, true]))
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      setVisible(Object.fromEntries(cardIds.map((id) => [id, saved[id] !== false])));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    } catch {
      /* ignore malformed/blocked storage, keep defaults */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const toggle = (id: string) => {
    setVisible((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* per-viewer convenience only — safe to drop if storage is unavailable */
      }
      return next;
    });
  };

  const isVisible = (id: string) => visible[id] !== false;

  return { isVisible, toggle };
}
