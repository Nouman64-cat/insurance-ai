"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tx } from "@/lib/i18n/tx";

/** 16px stroke icons for row actions (lucide shapes). */
const ICON_PATHS = {
  sparkles: <><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" /></>,
  form: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  check: <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  play: <><circle cx="12" cy="12" r="10" /><path d="m10 8 6 4-6 4Z" /></>,
  unlock: <><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>,
  reactivate: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  notInterested: <><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></>,
  more: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" /></>,
  mail: <><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></>,
  stethoscope: <><path d="M11 2v2" /><path d="M5 2v2" /><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" /><path d="M8 15a6 6 0 0 0 12 0v-3" /><circle cx="20" cy="10" r="2" /></>,
  wallet: <><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
};

export type ActionIconName = keyof typeof ICON_PATHS;

export function ActionIcon({ name, className = "w-4 h-4" }: { name: ActionIconName; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

export type RowAction = {
  key: string;
  label: string;
  icon: ActionIconName;
  onSelect: () => void;
  tone?: "default" | "magic" | "danger";
};

/**
 * The row's actions, folded into one small menu. Rendered in a portal with fixed
 * positioning so the table's horizontal-scroll wrapper can't clip it; opens upward
 * when there isn't room below.
 */
export default function RowActionsMenu({ actions, disabled }: { actions: RowAction[]; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setAnchor(null);
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); buttonRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const estimatedHeight = actions.length * 38 + 16;
  const openUp = anchor ? window.innerHeight - anchor.bottom < estimatedHeight + 12 && anchor.top > estimatedHeight : false;
  const firstDanger = actions.findIndex(a => a.tone === "danger");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tx("Actions")}
        onClick={(e) => { e.stopPropagation(); setAnchor(open ? null : e.currentTarget.getBoundingClientRect()); }}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${open ? "border-blue-200 bg-blue-50 text-blue-700" : "border-transparent text-slate-500 hover:border-slate-200 hover:bg-white hover:text-slate-700"}`}
      >
        <ActionIcon name="more" className="w-[18px] h-[18px]" />
        <span className="sr-only">{tx("Actions")}</span>
      </button>
      {open && anchor && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            right: Math.max(8, window.innerWidth - anchor.right),
            ...(openUp ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
          }}
          className="z-[60] w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg shadow-slate-900/10 animate-in fade-in zoom-in-95 duration-100"
        >
          {actions.map((action, index) => (
            <div key={action.key}>
              {index === firstDanger && index > 0 && <div className="my-1 h-px bg-slate-100" />}
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => { setAnchor(null); action.onSelect(); }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors focus:outline-none disabled:opacity-50 ${
                  action.tone === "danger"
                    ? "text-rose-600 hover:bg-rose-50 focus:bg-rose-50"
                    : action.tone === "magic"
                      ? "text-blue-700 hover:bg-blue-50 focus:bg-blue-50"
                      : "text-slate-700 hover:bg-slate-50 focus:bg-slate-50"
                }`}
              >
                <ActionIcon name={action.icon} className={`w-4 h-4 shrink-0 ${action.tone === "magic" ? "text-blue-600" : action.tone === "danger" ? "" : "text-slate-400"}`} />
                {action.label}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
