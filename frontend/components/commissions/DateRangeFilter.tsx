"use client";

import React, { useState, useRef, useEffect } from "react";

export type DatePreset = "7d" | "30d" | "90d" | "this_month" | "last_month" | "ytd" | "custom";

export interface DateRange {
  from: string; // ISO date string YYYY-MM-DD
  to: string;   // ISO date string YYYY-MM-DD
}

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "7d",         label: "Last 7 days" },
  { key: "30d",        label: "Last 30 days" },
  { key: "90d",        label: "Last 90 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "ytd",        label: "Year to date" },
  { key: "custom",     label: "Custom range" },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function resolvePreset(preset: DatePreset, customFrom?: string, customTo?: string): DateRange {
  const now = new Date();
  const today = isoDate(now);

  switch (preset) {
    case "7d": {
      const from = new Date(now);
      from.setDate(now.getDate() - 6);
      return { from: isoDate(from), to: today };
    }
    case "30d": {
      const from = new Date(now);
      from.setDate(now.getDate() - 29);
      return { from: isoDate(from), to: today };
    }
    case "90d": {
      const from = new Date(now);
      from.setDate(now.getDate() - 89);
      return { from: isoDate(from), to: today };
    }
    case "this_month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: isoDate(from), to: today };
    }
    case "last_month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: isoDate(first), to: isoDate(last) };
    }
    case "ytd": {
      const from = new Date(now.getFullYear(), 0, 1);
      return { from: isoDate(from), to: today };
    }
    case "custom":
      return { from: customFrom ?? isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: customTo ?? today };
  }
}

interface Props {
  preset: DatePreset;
  range: DateRange;
  onPresetChange: (preset: DatePreset, range: DateRange) => void;
  size?: "sm" | "md";
}

export function DateRangeFilter({ preset, range, onPresetChange, size = "md" }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(range.from);
  const [customTo, setCustomTo] = useState(range.to);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const activeLabel = PRESETS.find((p) => p.key === preset)?.label ?? "Date range";

  const handlePresetClick = (key: DatePreset) => {
    if (key !== "custom") {
      const r = resolvePreset(key);
      onPresetChange(key, r);
      setIsOpen(false);
    }
    // For custom, keep dropdown open to let user set dates
  };

  const handleCustomApply = () => {
    if (!customFrom || !customTo) return;
    onPresetChange("custom", { from: customFrom, to: customTo });
    setIsOpen(false);
  };

  const btnBase =
    size === "sm"
      ? "px-2.5 py-1.5 text-[11px]"
      : "px-3.5 py-2 text-xs";

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsOpen((o) => !o)}
        className={`flex items-center gap-2 ${btnBase} bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 rounded-xl font-semibold text-slate-700 transition-all shadow-sm whitespace-nowrap`}
      >
        {/* Calendar icon */}
        <svg className="w-3.5 h-3.5 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span>{activeLabel}</span>
        {preset !== "custom" ? (
          <span className="text-slate-400 text-[10px] font-normal hidden sm:inline">
            {range.from} – {range.to}
          </span>
        ) : (
          <span className="text-slate-400 text-[10px] font-normal hidden sm:inline">
            {range.from} – {range.to}
          </span>
        )}
        <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-64 bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          {/* Preset list */}
          <div className="p-1.5 border-b border-slate-100">
            {PRESETS.filter((p) => p.key !== "custom").map((p) => (
              <button
                key={p.key}
                onClick={() => handlePresetClick(p.key)}
                className={`w-full text-left px-3 py-2 rounded-lg text-[12px] font-medium transition-colors ${
                  preset === p.key
                    ? "bg-blue-50 text-blue-700 font-semibold"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom date inputs */}
          <div className="p-3 space-y-2.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Custom Range</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-500 font-semibold block mb-1">From</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  max={customTo}
                  className="w-full text-[11px] border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-semibold block mb-1">To</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  min={customFrom}
                  className="w-full text-[11px] border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 transition-colors"
                />
              </div>
            </div>
            <button
              onClick={handleCustomApply}
              disabled={!customFrom || !customTo || customFrom > customTo}
              className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-[11px] font-bold rounded-lg transition-colors"
            >
              Apply Custom Range
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Filter a ledger array to entries whose accruedAt falls within [from, to] */
export function filterLedgerByDate<T extends { accruedAt: string }>(ledger: T[], range: DateRange): T[] {
  const { from, to } = range;
  return ledger.filter((e) => {
    const d = e.accruedAt.slice(0, 10);
    return d >= from && d <= to;
  });
}
