"use client";

import React, { useState, useRef, useEffect } from "react";
import type { QuickAction } from "@/lib/agent/types";

export function QuickActionSelect({
  action,
  onRun,
  variant = "chip",
  selectedLabel,
  onSelected,
}: {
  action: QuickAction;
  onRun: (text: string) => void;
  variant?: "chip" | "card";
  // The persisted answer, when the parent keeps one (see AgentMessage.selections).
  selectedLabel?: string;
  onSelected?: (label: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Once an option is picked the prompt is answered: show what was chosen and
  // stop accepting input, the same way a clicked chip stays highlighted.
  const [localChosen, setChosen] = useState<string | null>(null);
  const chosen = selectedLabel ?? localChosen;
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Auto-focus search when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const options = action.options ?? [];
  if (options.length === 0) return null;

  const run = (value: string) => {
    if (!value || chosen !== null) return;
    setIsOpen(false);
    const label = options.find((o) => o.value === value)?.label ?? value;
    setChosen(label);
    onSelected?.(label);
    const text = action.payload?.includes("{value}")
      ? action.payload.replace("{value}", value)
      : action.payload || value;
    onRun(text);
  };

  if (options.length === 1) {
    return (
      <button
        type="button"
        disabled={chosen !== null}
        onClick={() => run(options[0].value)}
        className={`px-3 py-1.5 text-[12px] font-bold rounded-full border shadow-sm transition-all ${
          chosen !== null
            ? "bg-blue-600 text-white border-blue-600 cursor-default"
            : "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200 active:scale-95"
        }`}
      >
        {action.label}: {options[0].label}
      </button>
    );
  }

  const compact = variant === "chip";
  const filteredOptions = options.filter(opt => 
    opt.label.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center gap-1.5 rounded-2xl border border-blue-200 bg-blue-50/70 ${
        compact ? "px-2 py-1.5" : "px-3 py-2"
      }`}
    >
      <label className="text-[11px] font-bold uppercase tracking-wide text-blue-700 whitespace-nowrap">
        {action.label}
      </label>
      
      <div className="relative flex-1 min-w-0">
        <button
          type="button"
          disabled={chosen !== null}
          onClick={() => setIsOpen(!isOpen)}
          className={`w-full flex items-center justify-between text-left rounded-lg border font-medium focus:outline-none ${
            chosen !== null
              ? "border-blue-600 bg-blue-600 text-white cursor-default"
              : "border-blue-200 bg-white text-slate-700 hover:bg-slate-50 focus:ring-2 focus:ring-blue-500/20"
          } ${compact ? "max-w-[16rem] px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"}`}
        >
          <span className="truncate">
            {chosen ?? (action.placeholder || "Choose one…")}
          </span>
          {chosen !== null ? (
            <svg className="w-4 h-4 ml-2 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4 ml-2 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </button>

        {isOpen && chosen === null && (
          <div className="absolute z-50 w-[240px] max-w-[80vw] left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden flex flex-col">
            <div className="p-2 border-b border-slate-100 bg-slate-50">
              <div className="relative">
                <svg className="w-4 h-4 absolute left-2 top-2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                />
              </div>
            </div>
            
            <div className="max-h-60 overflow-y-auto">
              {filteredOptions.length > 0 ? (
                filteredOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => run(opt.value)}
                    className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:bg-blue-50 focus:text-blue-700 transition-colors"
                  >
                    {opt.label}
                  </button>
                ))
              ) : (
                <div className="px-3 py-4 text-sm text-slate-500 text-center">
                  No matches found.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
