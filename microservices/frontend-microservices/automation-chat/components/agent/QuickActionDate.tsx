"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QuickAction } from "@/lib/agent/types";

// ── A "date" quick action: an inline calendar instead of asking the user to
//    type YYYY-MM-DD. Dates are handled as local Y/M/D, never through UTC, so
//    the day picked is the day sent.

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseIso(value?: string): Date | null {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function pretty(value: string): string {
  const d = parseIso(value);
  return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : value;
}

// Monday-first grid of the month around `month`, padded to whole weeks.
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeks = Math.ceil(((first.getDay() + 6) % 7 + last.getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

const Icon = {
  calendar: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" />
    </svg>
  ),
  check: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ),
  chevron: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  ),
};

export function QuickActionDate({
  action,
  onRun,
  variant = "chip",
  selectedLabel,
  onSelected,
}: {
  action: QuickAction;
  onRun: (text: string) => void;
  variant?: "chip" | "card";
  selectedLabel?: string;
  onSelected?: (label: string) => void;
}) {
  const today = iso(new Date());
  const min = parseIso(action.min) ? action.min! : undefined;
  const max = parseIso(action.max) ? action.max! : undefined;
  const inRange = (v: string) => (!min || v >= min) && (!max || v <= max);
  const clamp = (v: string) => (min && v < min ? min : max && v > max ? max : v);

  const [isOpen, setIsOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [focused, setFocused] = useState(() => clamp(today));
  const [month, setMonth] = useState(() => parseIso(clamp(today))!);
  const [localChosen, setChosen] = useState<string | null>(null);
  const chosen = selectedLabel ?? localChosen;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setOpenUp(window.innerHeight - rect.bottom < 400 && rect.top > window.innerHeight - rect.bottom);
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  // Keep keyboard focus on the focused day as it moves (and across months).
  useEffect(() => {
    if (isOpen) gridRef.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus();
  }, [isOpen, focused, month]);

  function close() {
    setVisible(false);
    setIsOpen(false);
  }

  const run = (value: string) => {
    if (!inRange(value) || chosen !== null) return;
    close();
    const label = pretty(value);
    setChosen(label);
    onSelected?.(label);
    onRun(action.payload?.includes("{value}") ? action.payload.replace("{value}", value) : action.payload || value);
  };

  const moveFocus = (days: number) => {
    const next = clamp(iso(addDays(parseIso(focused)!, days)));
    setFocused(next);
    setMonth(parseIso(next)!);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -30, PageDown: 30 }[e.key];
    if (step) {
      e.preventDefault();
      moveFocus(step);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run(focused);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    }
  };

  const shiftMonth = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const monthKey = (d: Date) => iso(d).slice(0, 7);
  const canPrev = !min || monthKey(month) > min.slice(0, 7);
  const canNext = !max || monthKey(month) < max.slice(0, 7);
  const shortcuts = [
    { label: "Today", value: today },
    { label: "Yesterday", value: iso(addDays(new Date(), -1)) },
  ].filter((s) => inRange(s.value));
  const compact = variant === "chip";

  return (
    <div ref={containerRef} className="relative inline-block max-w-full">
      <button
        ref={triggerRef}
        type="button"
        disabled={chosen !== null}
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={`group flex max-w-full items-center gap-3 rounded-2xl border text-left transition-all duration-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/15 ${
          chosen !== null
            ? "cursor-default border-emerald-200 bg-emerald-50/70"
            : isOpen
              ? "border-blue-400 bg-white shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
              : "border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow-md"
        } ${compact ? "py-1.5 pl-1.5 pr-3" : "py-2 pl-2 pr-4"}`}
      >
        <span
          className={`flex shrink-0 items-center justify-center rounded-xl ${compact ? "h-8 w-8" : "h-9 w-9"} ${
            chosen !== null ? "bg-emerald-500 text-white" : "bg-gradient-to-br from-blue-500 to-indigo-500 text-white shadow-sm"
          }`}
        >
          {chosen !== null ? Icon.check("h-4 w-4") : Icon.calendar("h-4 w-4")}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-[10px] font-bold uppercase tracking-[0.08em] ${
              chosen !== null ? "text-emerald-700" : "text-blue-600"
            }`}
          >
            {chosen !== null ? `${action.label} selected` : action.label}
          </span>
          <span className={`block truncate font-semibold ${compact ? "text-[13px]" : "text-sm"} ${chosen !== null ? "text-emerald-900" : "text-slate-500"}`}>
            {chosen ?? (action.placeholder || "Pick a date…")}
          </span>
        </span>
      </button>

      {isOpen && chosen === null && (
        <div
          role="dialog"
          aria-label={action.label}
          onKeyDown={onKeyDown}
          className={`absolute left-0 z-50 w-[min(19rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 p-3 shadow-[0_24px_60px_-12px_rgba(15,23,42,0.28)] ring-1 ring-black/[0.02] backdrop-blur-xl transition-all duration-200 ease-out ${
            openUp ? "bottom-full mb-2 origin-bottom-left" : "top-full mt-2 origin-top-left"
          } ${visible ? "translate-y-0 scale-100 opacity-100" : `${openUp ? "translate-y-1" : "-translate-y-1"} scale-[0.98] opacity-0`}`}
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              disabled={!canPrev}
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              {Icon.chevron("h-4 w-4")}
            </button>
            <span className="text-sm font-semibold text-slate-800">
              {month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
            </span>
            <button
              type="button"
              disabled={!canNext}
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              {Icon.chevron("h-4 w-4 rotate-180")}
            </button>
          </div>

          <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1">{d}</span>
            ))}
          </div>
          <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-0.5">
            {monthGrid(month).map((d) => {
              const value = iso(d);
              const outside = d.getMonth() !== month.getMonth();
              const disabled = !inRange(value);
              const isFocused = value === focused;
              return (
                <button
                  key={value}
                  type="button"
                  data-date={value}
                  tabIndex={isFocused ? 0 : -1}
                  disabled={disabled}
                  onClick={() => run(value)}
                  aria-label={pretty(value)}
                  aria-current={value === today ? "date" : undefined}
                  className={`h-9 rounded-lg text-sm tabular-nums transition-colors focus:outline-none ${
                    disabled
                      ? "cursor-not-allowed text-slate-300"
                      : isFocused
                        ? "bg-blue-600 font-semibold text-white"
                        : value === today
                          ? "font-semibold text-blue-700 ring-1 ring-inset ring-blue-200 hover:bg-blue-50"
                          : outside
                            ? "text-slate-400 hover:bg-slate-50"
                            : "text-slate-700 hover:bg-blue-50"
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {shortcuts.length > 0 && (
            <div className="mt-2 flex gap-2 border-t border-slate-100 pt-2">
              {shortcuts.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => run(s.value)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
