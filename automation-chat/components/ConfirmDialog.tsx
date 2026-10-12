"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// An in-app replacement for window.confirm (whose "localhost:3004 says" box can't be styled and blocks the page).
//
//   const [confirm, confirmDialog] = useConfirm();
//   ...
//   if (!(await confirm({ title: "Delete 3 chats?", message: "This can't be undone.", tone: "danger", confirmLabel: "Delete" }))) return;
//   ...
//   return (<>{...}{confirmDialog}</>);
//
// `confirm` resolves true on the confirm button (or Enter) and false on Cancel, Escape or a click outside.

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** default: blue; warn: amber (proceeding past a caution); danger: red (destructive). */
  tone?: "default" | "warn" | "danger";
}

const TONE = {
  default: { button: "bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-300", icon: "bg-blue-50 text-blue-600" },
  warn: { button: "bg-amber-500 hover:bg-amber-600 focus-visible:ring-amber-300", icon: "bg-amber-50 text-amber-600" },
  danger: { button: "bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-300", icon: "bg-rose-50 text-rose-600" },
} as const;

export function ConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "default", onConfirm, onCancel }: ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const style = TONE[tone];
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); cancelRef.current(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 px-4 backdrop-blur-sm"
      onClick={(e) => { e.stopPropagation(); onCancel(); }} // React events bubble through the portal: don't reach the modal underneath
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? "confirm-message" : undefined}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3.5 px-5 pb-4 pt-5">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${style.icon}`} aria-hidden="true">
            {tone === "default" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
            )}
          </span>
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-[15px] font-bold leading-snug text-slate-900">{title}</h2>
            {message && <div id="confirm-message" className="mt-1 text-[13px] leading-relaxed text-slate-600">{message}</div>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-[13px] font-semibold text-slate-600 transition-colors hover:bg-slate-100"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-all focus:outline-none focus-visible:ring-2 active:scale-[0.97] ${style.button}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Promise-style confirm. Render the returned node once in the component that calls it. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // A second request while one is open cancels the first rather than leaving it hanging.
    resolverRef.current?.(false);
    resolverRef.current = resolve;
    setPending({ options, resolve });
  }), []);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setPending(null);
  }, []);

  // If the component goes away with a question open, answer it "no".
  useEffect(() => () => { resolverRef.current?.(false); resolverRef.current = null; }, []);

  const dialog = pending && typeof document !== "undefined"
    ? createPortal(<ConfirmDialog {...pending.options} onConfirm={() => settle(true)} onCancel={() => settle(false)} />, document.body)
    : null;

  return [confirm, dialog];
}
