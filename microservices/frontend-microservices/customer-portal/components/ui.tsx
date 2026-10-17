"use client";
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { ApiError } from "@/lib/api";

// ── status colours: semantic only ─────────────────────────────────────────────
type Tone = "green" | "amber" | "red" | "blue" | "slate";
const TONE: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200", amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200", blue: "bg-blue-50 text-blue-700 ring-blue-200", slate: "bg-slate-100 text-slate-600 ring-slate-200",
};
const POLICY_TONE: Record<string, Tone> = {
  active: "green", reinstated: "green", grace_period: "amber", lapsed: "red", cancelled: "red",
  pending_issuance: "blue", issued: "blue", expired: "slate", matured: "slate", surrendered: "slate", unknown: "slate",
};
const CLAIM_TONE: Record<string, Tone> = {
  submitted: "blue", in_review: "blue", assessment: "blue", documents_needed: "amber", approved: "green", partially_approved: "green",
  settled: "green", declined: "red", closed: "slate",
};
const INSTALLMENT_TONE: Record<string, Tone> = { paid: "green", waived: "slate", upcoming: "slate", due_soon: "blue", due_today: "amber", grace: "amber", past_grace: "red" };

/** A translation if the key exists, else the raw value (labels the backend may add later, e.g. a new payment method). */
export function tOr(t: (k: string, v?: any) => string, key: string, fallback: string | null | undefined): string {
  const s = t(key);
  return s !== key ? s : fallback || "—";
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap ${TONE[tone]}`}>{children}</span>;
}
export function PolicyStatus({ statusKey }: { statusKey: string }) {
  const { t } = useI18n();
  return <Pill tone={POLICY_TONE[statusKey] || "slate"}>{t(`policyStatus.${statusKey}`)}</Pill>;
}
export function ClaimStatus({ statusKey }: { statusKey: string }) {
  const { t } = useI18n();
  return <Pill tone={CLAIM_TONE[statusKey] || "slate"}>{t(`claimStatus.${statusKey}`)}</Pill>;
}
export function InstallmentState({ state }: { state: string }) {
  const { t } = useI18n();
  return <Pill tone={INSTALLMENT_TONE[state] || "slate"}>{t(`installment.${state}`)}</Pill>;
}

// ── layout bits ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h2 className="text-xl font-bold tracking-tight text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>{action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="data-row"><span className="data-key">{label}</span><span className="data-val">{children ?? "—"}</span></div>;
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`rounded-md bg-slate-200/70 animate-pulse ${className}`} aria-hidden="true" />;
}

export function Spinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({ title, text, action, icon }: { title: string; text?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3" aria-hidden="true">
        {icon || <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 13V7a2 2 0 00-2-2H6a2 2 0 00-2 2v6m16 0v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4m16 0h-4l-1 2h-6l-1-2H4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </div>
      <p className="text-sm font-bold text-slate-800">{title}</p>
      {text && <p className="text-sm text-slate-500 mt-1 max-w-sm">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** What the customer reads when a call fails: a translated message by error code, never the raw server text. */
export function errorText(t: (k: string, v?: any) => string, e: ApiError | Error | null | undefined): string {
  const code = (e as ApiError | undefined)?.code;
  if (code) { const k = `error.${code}`; const s = t(k); if (s !== k) return s; }
  return t("error.generic");
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-col items-center text-center py-10 px-6">
      <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-500 flex items-center justify-center mb-3" aria-hidden="true">
        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 9v4m0 4h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <p className="text-sm font-bold text-slate-800">{t("error.title")}</p>
      <p className="text-sm text-slate-500 mt-1 max-w-sm">{errorText(t, error)}</p>
      {onRetry && <button type="button" onClick={onRetry} className="btn-secondary mt-4">{t("common.retry")}</button>}
    </div>
  );
}

const BANNER: Record<"info" | "warning" | "danger" | "success", string> = {
  info: "bg-blue-50 border-blue-200 text-blue-800", warning: "bg-amber-50 border-amber-200 text-amber-900",
  danger: "bg-rose-50 border-rose-200 text-rose-800", success: "bg-emerald-50 border-emerald-200 text-emerald-800",
};
export function Banner({ tone = "info", title, children, action }: { tone?: keyof typeof BANNER; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-3 ${BANNER[tone]}`}>
      <div className="min-w-0">{title && <p className="font-bold">{title}</p>}{children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}</div>
      {action}
    </div>
  );
}

// ── dialog ────────────────────────────────────────────────────────────────────
export function Modal({ title, onClose, children, wide = false, busy = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; previous?.focus(); };
  }, [onClose, busy]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={() => !busy && onClose()} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={`relative bg-white w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-md"} max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl outline-none`}>
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("common.close")} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ── toasts ────────────────────────────────────────────────────────────────────
type ToastKind = "success" | "error" | "info";
const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setItems((cur) => [...cur, { id, message, kind }]);
    setTimeout(() => setItems((cur) => cur.filter((i) => i.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 end-4 z-[60] flex flex-col gap-2 max-w-sm" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} role="status" className={`rounded-xl px-4 py-3 text-sm font-medium shadow-lg border ${i.kind === "success" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : i.kind === "error" ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-white border-slate-200 text-slate-700"}`}>
            {i.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Field({ label, children, hint, error, htmlFor }: { label: string; children: ReactNode; hint?: string; error?: string | null; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p role="alert" className="text-xs text-rose-600 mt-1">{error}</p> : hint ? <p className="text-xs text-slate-400 mt-1">{hint}</p> : null}
    </div>
  );
}

export function Icon({ name, className = "w-5 h-5" }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    policies: <><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
    payments: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
    claims: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
    documents: <><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></>,
    profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0116 0v1" /></>,
    support: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2M12 17h.01" /></>,
    bell: <><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></>,
    download: <><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M8 12l4 4 4-4M12 4v12" /></>,
    shield: <><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /></>,
    money: <><circle cx="12" cy="12" r="9" /><path d="M14.5 9.2c-.4-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.8-2.5 1.8s1 1.5 2.5 1.8c1.5.3 2.5.8 2.5 1.8s-1.1 1.8-2.5 1.8c-1.1 0-2.1-.4-2.5-1.2M12 6.5V8m0 8v1.5" /></>,
    family: <><circle cx="9" cy="8" r="3.2" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20v-1a5 5 0 0110 0v1M15 14.5a4 4 0 016 3.5v2" /></>,
    calendar: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    alert: <><path d="M12 9v4m0 4h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    check: <><path d="M5 13l4 4L19 7" /></>,
    lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 118 0v4" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || null}</svg>;
}
