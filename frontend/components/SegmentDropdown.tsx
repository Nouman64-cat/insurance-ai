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
    label: "All Customers",
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
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const openMenu = () => {
    setActiveIndex(OPTIONS.findIndex((o) => o.value === value));
    setOpen(true);
  };

  const handleButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, OPTIONS.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChange(OPTIONS[activeIndex].value);
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleButtonKeyDown}
        className="inline-flex items-center gap-2.5 pl-3 pr-2.5 py-2 text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg shadow-sm hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${selected.dot}`} />
        <span className="text-slate-500">{selected.icon}</span>
        <span>{selected.label}</span>
        {counts?.[selected.value] != null && (
          <span className="px-1.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-500">
            {counts[selected.value]}
          </span>
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-slate-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listboxId}-${activeIndex}`}
          onKeyDown={handleListKeyDown}
          ref={(el) => el?.focus()}
          className="absolute z-20 mt-1.5 w-64 py-1.5 bg-white border border-slate-200 rounded-xl shadow-lg focus:outline-none"
        >
          {OPTIONS.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={option.value}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex items-center gap-3 mx-1.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                  isActive ? "bg-blue-50" : ""
                }`}
              >
                <span className={`flex items-center justify-center w-7 h-7 rounded-lg ${isSelected ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"}`}>
                  {option.icon}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm font-semibold ${isSelected ? "text-blue-700" : "text-slate-700"}`}>
                    {option.label}
                  </span>
                  <span className="block text-xs text-slate-400 truncate">{option.description}</span>
                </span>
                {counts?.[option.value] != null && (
                  <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${isSelected ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"}`}>
                    {counts[option.value]}
                  </span>
                )}
                {isSelected && (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600 shrink-0">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
