"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { endSso } from "@/lib/sso";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useI18n } from "@/lib/i18n/I18nProvider";


/** The signed-in user's initials; opens a small menu with their details, Profile and Sign out. */
function ProfileMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState({ name: "", email: "", role: "" });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setUser({
      name: localStorage.getItem("user_name") ?? "",
      email: localStorage.getItem("user_email") ?? "",
      role: localStorage.getItem("user_role") ?? "",
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("") || "?";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.name || t("sidebar.profile")}
        className={`flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white shadow-sm ring-2 transition-all ${open ? "ring-blue-200" : "ring-white hover:ring-blue-100"}`}
      >
        {initials}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg shadow-slate-900/10 z-50">
          <div className="px-2.5 py-2 border-b border-slate-100 mb-1">
            <p className="text-sm font-semibold text-slate-900 truncate">{user.name || "—"}</p>
            {user.email && <p className="text-[11px] text-slate-500 truncate">{user.email}</p>}
            {user.role && <p className="mt-1 inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{user.role}</p>}
          </div>
          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-400"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            {t("sidebar.profile")}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              localStorage.clear();
              endSso().finally(() => window.location.replace("/login"));
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-rose-600 hover:bg-rose-50"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            {t("sidebar.logout")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TopBar() {

  return (
    <header className="sticky top-0 z-30 h-14 flex-shrink-0 flex items-center justify-end gap-4 px-6 bg-white/80 backdrop-blur-md border-b border-slate-200 shadow-sm">
      <div className="flex items-center gap-3 flex-shrink-0">
        <LanguageSwitcher />

        <span className="h-6 w-px bg-slate-200" aria-hidden="true" />
        <ProfileMenu />
      </div>
    </header>
  );
}
