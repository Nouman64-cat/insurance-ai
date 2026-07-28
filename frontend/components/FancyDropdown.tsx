"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

// A generic, elegant single-select combobox — the same accessible listbox
// pattern as StatusDropdown/SegmentDropdown (button + popup listbox, arrow-key
// navigation, click-outside/Escape to close) generalized so any page can swap
// a plain native <select> for something that matches the rest of the app:
// icon/description rows, a checkmark on the active item, and a fade+scale
// open/close transition instead of an abrupt native popup.

export interface FancyDropdownOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  dot?: string; // tailwind bg-* class for a small leading status dot
}

interface FancyDropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: FancyDropdownOption[];
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
  panelClassName?: string;
  size?: "sm" | "md";
}

export function FancyDropdown({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchable = false,
  disabled = false,
  className = "",
  panelClassName = "",
  size = "md",
}: FancyDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q)
    );
  }, [options, query, searchable]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
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

  useEffect(() => {
    if (open) {
      if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
      else listRef.current?.focus();
    } else {
      setQuery("");
    }
  }, [open, searchable]);

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(Math.max(0, options.findIndex((o) => o.value === value)));
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
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) {
        onChange(opt.value);
        setOpen(false);
      }
    }
  };

  const sizeCls = size === "sm" ? "px-2.5 py-2 text-xs" : "px-3 py-2 text-sm";

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleButtonKeyDown}
        className={`w-full inline-flex items-center gap-2 ${sizeCls} font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg shadow-sm hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white`}
      >
        {selected?.dot && <span className={`w-2 h-2 rounded-full shrink-0 ${selected.dot}`} />}
        {selected?.icon && <span className="shrink-0">{selected.icon}</span>}
        <span className={`flex-1 min-w-0 truncate text-left ${selected ? "" : "text-slate-400 font-normal"}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-slate-400 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <div
        className={`absolute z-30 mt-1.5 min-w-full w-max max-w-xs bg-white border border-slate-200 rounded-xl shadow-lg origin-top transition-all duration-150 ${
          open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
        } ${panelClassName}`}
      >
        {searchable && (
          <div className="px-2 pt-2 pb-1.5 mb-1 border-b border-slate-100">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleListKeyDown}
              placeholder="Search…"
              className="w-full text-xs px-2 py-1.5 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
            />
          </div>
        )}
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={open && filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
          onKeyDown={handleListKeyDown}
          className="py-1.5 max-h-64 overflow-y-auto focus:outline-none"
        >
          {filtered.length === 0 && <li className="px-3 py-3 text-xs text-slate-400 text-center">No matches</li>}
          {filtered.map((option, index) => {
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
                className={`flex items-center gap-2.5 mx-1.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${isActive ? "bg-blue-50" : ""}`}
              >
                {option.dot && <span className={`w-2 h-2 rounded-full shrink-0 ${option.dot}`} />}
                {option.icon && <span className="shrink-0">{option.icon}</span>}
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm font-semibold truncate ${isSelected ? "text-blue-700" : "text-slate-700"}`}>
                    {option.label}
                  </span>
                  {option.description && <span className="block text-xs text-slate-400 truncate">{option.description}</span>}
                </span>
                {isSelected && (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-blue-600 shrink-0"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
