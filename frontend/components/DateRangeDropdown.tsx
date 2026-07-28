"use client";

import { useState, useRef, useEffect } from "react";

export interface DateRange {
  start: string;
  end: string;
}

interface DateRangeDropdownProps {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  className?: string;
}

export function DateRangeDropdown({ value, onChange, className = "" }: DateRangeDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tempStart, setTempStart] = useState(value?.start || "");
  const [tempEnd, setTempEnd] = useState(value?.end || "");

  useEffect(() => {
    if (isOpen) {
      setTempStart(value?.start || "");
      setTempEnd(value?.end || "");
    }
  }, [isOpen, value]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen]);

  const handleApply = () => {
    if (!tempStart && !tempEnd) {
      onChange(null);
    } else {
      onChange({ start: tempStart, end: tempEnd });
    }
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setIsOpen(false);
  };

  const formatDate = (d: string) => {
    if (!d) return "";
    return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  const displayLabel = value 
    ? `${value.start ? formatDate(value.start) : "Any"} - ${value.end ? formatDate(value.end) : "Any"}`
    : "Filter by Date";

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center justify-between gap-3 px-4 py-2 text-sm font-semibold bg-white border rounded-xl h-[42px] min-w-[160px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors ${
          isOpen || value ? "border-blue-400 ring-2 ring-blue-500/20 text-blue-900" : "border-slate-200 text-slate-700 hover:border-slate-300"
        }`}
      >
        <span className="flex items-center gap-2 truncate">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-slate-400">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          {displayLabel}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`w-4 h-4 flex-shrink-0 transition-transform duration-300 ${isOpen ? "rotate-180 text-blue-500" : "text-slate-400"}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div 
          className="absolute top-full left-0 mt-2 w-[280px] bg-white border border-slate-100 rounded-xl shadow-[0_8px_24px_rgb(0,0,0,0.08)] z-50 overflow-hidden p-4"
          style={{ animation: 'slideDown 0.15s ease-out forwards' }}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Start Date</label>
              <input 
                type="date" 
                value={tempStart}
                onChange={e => setTempStart(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">End Date</label>
              <input 
                type="date" 
                value={tempEnd}
                onChange={e => setTempEnd(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 transition-all"
              />
            </div>
            <div className="pt-2 flex items-center justify-between border-t border-slate-100 mt-4">
              <button 
                onClick={handleClear}
                className="text-xs font-bold text-slate-500 hover:text-slate-800 transition-colors"
              >
                Clear
              </button>
              <button 
                onClick={handleApply}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                Apply Range
              </button>
            </div>
          </div>
        </div>
      )}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}} />
    </div>
  );
}
