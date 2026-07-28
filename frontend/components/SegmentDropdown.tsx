"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CustomerSegment } from "@/app/services/cases";

export type SegmentFilter = "all" | CustomerSegment;

interface SegmentOption {
  value: SegmentFilter;
  label: string;
  description: string;
  icon: JSX.Element;
  dot: string;
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const OPTIONS: SegmentOption[] = [
  {
    value: "all",
    label: "All Cases",
    description: "Every record, no filter",
    dot: "bg-slate-400",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    value: "individual",
    label: "Individual",
    description: "Customers shopping on their own",
    dot: "bg-blue-500",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
      </svg>
    ),
  },
  {
    value: "family",
    label: "Family",
    description: "Members under a family floater",
    dot: "bg-violet-500",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="8" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M2 21c0-3.6 2.7-6 6-6s6 2.4 6 6" />
        <path d="M14.5 21c.3-2.8 2-4.5 4.5-4.5s4.2 1.7 4.5 4" />
      </svg>
    ),
  },
  {
    value: "organization",
    label: "Organization",
    description: "Employees under a group policy",
    dot: "bg-amber-500",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="4" y="3" width="12" height="18" rx="1" />
        <path d="M9 8h2M9 12h2M9 16h2" />
        <path d="M16 21v-8h4v8" />
      </svg>
    ),
  },
];

export const SEGMENT_LABEL: Record<CustomerSegment, string> = {
  individual: "Individual",
  family: "Family",
  organization: "Organization",
};

export const SEGMENT_BADGE_STYLE: Record<CustomerSegment, string> = {
  individual: "bg-blue-50 text-blue-700 border-blue-200",
  family: "bg-violet-50 text-violet-700 border-violet-200",
  organization: "bg-amber-50 text-amber-700 border-amber-200",
};

interface SegmentDropdownProps {
  value: SegmentFilter;
  onChange: (value: SegmentFilter) => void;
  counts?: Partial<Record<SegmentFilter, number>>;
  className?: string;
}

export function SegmentDropdown({ value, onChange, counts, className = "" }: SegmentDropdownProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Close on click outside
  useEffect(() => {
    if (!expanded) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [expanded]);

  // Define text colors explicitly so Tailwind picks them up
  const textColors: Record<SegmentFilter, string> = {
    all: "text-slate-600",
    individual: "text-blue-600",
    family: "text-violet-600",
    organization: "text-amber-600",
  };

  const selectedOption = OPTIONS.find(o => o.value === value) || OPTIONS[0];
  const unselectedOptions = OPTIONS.filter(o => o.value !== value);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center justify-between gap-3 px-4 h-10 text-sm font-semibold bg-white border rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
          expanded ? "border-blue-400 shadow-md ring-2 ring-blue-500/20" : "border-slate-200 shadow-sm hover:border-slate-300"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={textColors[selectedOption.value]}>
            {selectedOption.icon}
          </span>
          <span className="text-slate-700 whitespace-nowrap">
            {selectedOption.label}
          </span>
          {counts?.[selectedOption.value] != null && (
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
              expanded ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"
            }`}>
              {counts[selectedOption.value]}
            </span>
          )}
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 ml-1 transition-transform duration-300 ${expanded ? "rotate-180 text-blue-600" : "text-slate-400"}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div 
          className="absolute top-full left-0 mt-2 w-[220px] bg-white border border-slate-100 rounded-xl shadow-[0_8px_24px_rgb(0,0,0,0.08)] z-50 overflow-hidden py-2"
          style={{ animation: 'slideDown 0.15s ease-out forwards' }}
        >
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={(e) => {
                e.stopPropagation();
                onChange(option.value);
                setExpanded(false);
              }}
              className={`w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                value === option.value
                  ? "bg-blue-50/50"
                  : "hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span className={value === option.value ? textColors[option.value] : "text-slate-400"}>
                  {option.icon}
                </span>
                <span className={`font-semibold ${value === option.value ? textColors[option.value] : "text-slate-600"}`}>
                  {option.label}
                </span>
              </div>
              {counts?.[option.value] != null && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  value === option.value ? "bg-white text-blue-700 shadow-sm" : "bg-slate-100 text-slate-500"
                }`}>
                  {counts[option.value]}
                </span>
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
