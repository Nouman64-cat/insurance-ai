"use client";

import { useState, useRef, useEffect } from "react";

export interface FilterOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface FilterDropdownProps {
  value: string;
  options: FilterOption[];
  onChange: (val: string) => void;
  className?: string;
  placeholder?: string;
}

export function FilterDropdown({ value, options, onChange, className = "", placeholder }: FilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const selectedOption = options.find(o => o.value === value);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center justify-between gap-3 px-4 py-2 text-sm font-semibold bg-white border rounded-xl h-[42px] min-w-[140px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors ${
          isOpen ? "border-blue-400 ring-2 ring-blue-500/20 text-blue-900" : "border-slate-200 text-slate-700"
        }`}
      >
        <span className="flex items-center gap-2 truncate">
          {selectedOption?.icon}
          {selectedOption ? selectedOption.label : (placeholder || "Select...")}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`w-4 h-4 flex-shrink-0 transition-transform duration-300 ${isOpen ? "rotate-180 text-blue-500" : "text-slate-400"}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div 
          className="absolute top-full left-0 mt-2 w-full min-w-[180px] bg-white border border-slate-100 rounded-xl shadow-[0_8px_24px_rgb(0,0,0,0.08)] z-50 overflow-hidden py-2"
          style={{ animation: 'slideDown 0.15s ease-out forwards' }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
              className={`flex items-center gap-2 w-full text-left px-4 py-2 text-sm transition-colors ${
                value === opt.value 
                  ? "bg-blue-50/50 text-blue-700 font-bold" 
                  : "text-slate-600 font-medium hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              {opt.icon}
              {opt.label}
              {value === opt.value && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-4 h-4 ml-auto text-blue-600"><polyline points="20 6 9 17 4 12"/></svg>
              )}
            </button>
          ))}
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
