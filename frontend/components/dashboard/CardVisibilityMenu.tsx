"use client";

import { useEffect, useRef, useState } from "react";

export interface CardVisibilityItem {
  id: string;
  label: string;
}

interface CardVisibilityMenuProps {
  items: CardVisibilityItem[];
  isVisible: (id: string) => boolean;
  onToggle: (id: string) => void;
}

function SlidersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

/** "Customize" popover letting a viewer show/hide individual dashboard cards. */
export function CardVisibilityMenu({ items, isVisible, onToggle }: CardVisibilityMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all"
        title="Show / hide cards"
      >
        <SlidersIcon />
        <span className="hidden sm:inline">Customize</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-lg z-30 p-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-2 py-1">Visible Cards</p>
          <div className="max-h-64 overflow-y-auto">
            {items.map((item) => (
              <label
                key={item.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={isVisible(item.id)}
                  onChange={() => onToggle(item.id)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500/30"
                />
                <span className="truncate">{item.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
