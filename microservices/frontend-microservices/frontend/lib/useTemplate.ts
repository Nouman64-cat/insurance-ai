"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPublished, type TemplateContent } from "@/lib/templates";

/** The published version of a template, kept fresh: read when the form opens, again whenever the window regains focus, and on a timer while
 *  it is open, so an edit a Super Admin just published appears without reloading the page. */
export function usePublishedTemplate(key: string, opts: { enabled?: boolean; refreshMs?: number } = {}) {
  const { enabled = true, refreshMs = 15000 } = opts;
  const [state, setState] = useState<{ content: TemplateContent | null; version: number | null; error: string | null; loadedAt: number | null }>({ content: null, version: null, error: null, loadedAt: null });
  const lastVersion = useRef<number | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await getPublished(key);
      if (lastVersion.current !== null && t.version !== lastVersion.current) setChanged(true);
      lastVersion.current = t.version;
      setState({ content: t.content, version: t.version, error: null, loadedAt: Date.now() });
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Could not load the template." }));
    }
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const timer = refreshMs > 0 ? window.setInterval(load, refreshMs) : undefined;
    return () => { window.removeEventListener("focus", onFocus); if (timer) window.clearInterval(timer); };
  }, [enabled, load, refreshMs]);

  return { ...state, changed, acknowledge: () => setChanged(false), reload: load };
}
