"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Two changes made in the same moment (open results = set the benchmark AND the tab) must both reach the address: the second starts from the first.
let pending: string | null = null;

/**
 * One piece of page state kept in the address bar, so it survives a reload, can be shared as a link, and works with the browser's back and
 * forward buttons. A value equal to its default is left out of the address, which keeps links short.
 *
 *   const [tab, setTab] = useQueryState("tab", "cases");            // choosing a tab is a step the back button undoes
 *   const [q, setQ] = useQueryState("q", "", { replace: true });     // typing in a filter does not fill the history
 */
export function useQueryState(name: string, fallback = "", opts: { replace?: boolean } = {}): [string, (value: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = params.get(name) ?? fallback;
  const set = useCallback((next: string) => {
    const sp = new URLSearchParams(pending ?? (typeof window !== "undefined" ? window.location.search : params.toString()));
    if (next === fallback || next === "") sp.delete(name);
    else sp.set(name, next);
    const qs = sp.toString();
    pending = qs;
    setTimeout(() => { pending = null; }, 150);
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (opts.replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }, [name, fallback, opts.replace, params, pathname, router]);
  return [value, set];
}
