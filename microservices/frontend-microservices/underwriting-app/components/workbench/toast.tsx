"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";

type Kind = "success" | "error" | "info";
type Toast = { id: number; kind: Kind; title: string; detail?: string };
const EVENT = "workbench:toast";
let nextId = 0;

/** Confirm an action wherever the underwriter is on the page; the sticky header hides inline banners. */
export function notify(kind: Kind, title: string, detail?: string) {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id: ++nextId, kind, title, detail } }));
}

const TONE: Record<Kind, { ring: string; icon: string; path: string }> = {
  success: { ring: "border-emerald-200", icon: "bg-emerald-500 text-white", path: "m5 12 4 4L19 6" },
  error: { ring: "border-rose-200", icon: "bg-rose-500 text-white", path: "M12 7v6m0 4h.01" },
  info: { ring: "border-blue-200", icon: "bg-blue-500 text-white", path: "M12 11v6m0-10h.01" },
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const add = (e: Event) => {
      const toast = (e as CustomEvent<Toast>).detail;
      setToasts((current) => [...current.slice(-2), toast]);
      window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== toast.id)), toast.kind === "error" ? 8000 : 5000);
    };
    window.addEventListener(EVENT, add);
    return () => window.removeEventListener(EVENT, add);
  }, []);
  return <div aria-live="polite" className="pointer-events-none fixed bottom-5 end-5 z-50 flex w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2">
    {toasts.map((t) => <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={`pointer-events-auto flex items-start gap-3 rounded-2xl border bg-white p-4 shadow-lg ${TONE[t.kind].ring}`}>
      <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${TONE[t.kind].icon}`}><svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TONE[t.kind].path} /></svg></span>
      <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-slate-900">{t.title}</p>{t.detail && <p className="mt-0.5 text-xs text-slate-500">{t.detail}</p>}</div>
      <button aria-label={tx("Dismiss")} onClick={() => setToasts((current) => current.filter((x) => x.id !== t.id))} className="-me-1 -mt-1 rounded-lg px-1.5 text-lg leading-none text-slate-400 hover:text-slate-700">×</button>
    </div>)}
  </div>;
}
