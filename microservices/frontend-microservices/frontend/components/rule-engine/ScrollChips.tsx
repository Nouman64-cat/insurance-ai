"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";

/** A row of chips that scrolls sideways: arrow buttons appear at whichever end has more to show, the wheel scrolls it
 *  sideways, and the scrollbar stays hidden. Left/right follow the page direction, so it works in Urdu too. */
export default function ScrollChips({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pos = Math.abs(el.scrollLeft);          // negative in RTL
    setMore({ start: pos > 4, end: pos < max - 4 });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [measure, children]);

  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    el.scrollBy({ left: dir * (rtl ? -1 : 1) * el.clientWidth * 0.7, behavior: "smooth" });
  };

  const arrow = "absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-md transition hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
  const chevron = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 rtl:rotate-180"><path d={d} /></svg>;

  return (
    <div className="relative">
      {more.start && <>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 start-0 z-[5] w-12 bg-gradient-to-r from-slate-50 to-transparent rtl:bg-gradient-to-l" />
        <button type="button" aria-label={tx("Scroll left")} onClick={() => step(-1)} className={`${arrow} start-0`}>{chevron("M15 18l-6-6 6-6")}</button>
      </>}
      <div
        ref={ref}
        onScroll={measure}
        onWheel={(e) => { const el = ref.current; if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { el.scrollLeft += e.deltaY; } }}
        className={`flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
      >
        {children}
      </div>
      {more.end && <>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 end-0 z-[5] w-12 bg-gradient-to-l from-slate-50 to-transparent rtl:bg-gradient-to-r" />
        <button type="button" aria-label={tx("Scroll right")} onClick={() => step(1)} className={`${arrow} end-0`}>{chevron("M9 18l6-6-6-6")}</button>
      </>}
    </div>
  );
}
