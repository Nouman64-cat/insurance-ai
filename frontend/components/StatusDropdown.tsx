"use client";

import { useEffect, useRef, useState } from "react";

export type StatusFilter =
  | "ALL"
  | "Quoted"
  | "Proposed"
  | "UnderReview"
  | "InformationRequested"
  | "Approved"
  | "Declined"
  | "Issued";

interface StatusOption {
  value: StatusFilter;
  label: string;
  description: string;
  dot: string;
  nested?: boolean;
}

const OPTIONS: StatusOption[] = [
  { value: "ALL", label: "All Proposals", description: "Every stage, no filter", dot: "bg-slate-400" },
  { value: "Quoted", label: "Draft", description: "Auto-priced, not yet submitted", dot: "bg-slate-400" },
  { value: "Proposed", label: "Submitted", description: "Customer committed to this offer", dot: "bg-blue-500" },
  { value: "UnderReview", label: "Under Review", description: "Underwriter is assessing risk", dot: "bg-amber-500" },
  { value: "InformationRequested", label: "Info Requested", description: "Paused within review, pending customer", dot: "bg-amber-300", nested: true },
  { value: "Approved", label: "Approved", description: "Underwriting decision: accepted", dot: "bg-emerald-500" },
  { value: "Declined", label: "Rejected", description: "Underwriting decision: declined", dot: "bg-rose-500" },
  { value: "Issued", label: "Issued", description: "Policy issued and in force", dot: "bg-violet-500" },
];

const ACTIVE_STYLE: Record<StatusFilter, string> = {
  ALL: "text-slate-700 bg-slate-100",
  Quoted: "text-slate-700 bg-slate-100",
  Proposed: "text-blue-700 bg-blue-50",
  UnderReview: "text-amber-700 bg-amber-50",
  InformationRequested: "text-amber-600 bg-amber-50/50",
  Approved: "text-emerald-700 bg-emerald-50",
  Declined: "text-rose-700 bg-rose-50",
  Issued: "text-violet-700 bg-violet-50",
};

const MAIN_PATH: StatusOption[] = [
  OPTIONS[1], // Draft
  OPTIONS[2], // Submitted
  OPTIONS[3], // UnderReview
  OPTIONS[5], // Approved
  OPTIONS[7], // Issued
];

interface StatusDropdownProps {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
  counts?: Partial<Record<StatusFilter, number>>;
  className?: string;
}

export function StatusDropdown({ value, onChange, counts, className = "" }: StatusDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const selected = OPTIONS.find(o => o.value === value) || OPTIONS[0];

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2.5 px-3 py-2 bg-white border border-slate-200/80 rounded-xl shadow-sm hover:shadow hover:border-slate-300 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/20"
      >
        <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
          <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
          </svg>
          <span className="text-slate-400 font-medium">Pipeline:</span> 
          <span className="flex items-center gap-1.5 ml-1">
            <span className={`w-2 h-2 rounded-full ${selected.dot}`} />
            {selected.label}
          </span>
        </div>
        {counts?.[value] != null && (
          <span className="px-1.5 py-0.5 rounded-md text-[11px] font-extrabold bg-slate-100 text-slate-500 ml-1">
            {counts[value]}
          </span>
        )}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 text-slate-400 ml-1 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Popover Timeline Menu */}
      <div className={`absolute z-40 top-full mt-2.5 left-0 w-[340px] bg-white/95 backdrop-blur-xl border border-slate-200/80 rounded-2xl shadow-[0_16px_40px_rgb(0,0,0,0.12)] overflow-hidden transition-all duration-300 origin-top-left ${open ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
        <div className="p-3">
          
          {/* ALL PROPOSALS ROW */}
          <button 
            type="button"
            onClick={() => { onChange("ALL"); setOpen(false); }} 
            className={`flex items-center gap-3 w-full p-2.5 rounded-xl transition-colors text-left ${value === "ALL" ? ACTIVE_STYLE.ALL : 'hover:bg-slate-50'}`}
          >
            <div className="w-6 flex justify-center">
              <div className={`w-2 h-2 rounded-full ${OPTIONS[0].dot}`} />
            </div>
            <div className="flex-1">
              <div className={`text-sm font-bold ${value === "ALL" ? 'text-slate-900' : 'text-slate-700'}`}>All Proposals</div>
              <div className="text-[11px] text-slate-500">View everything in the pipeline</div>
            </div>
            {counts?.ALL != null && (
              <div className={`text-xs font-bold ${value === "ALL" ? 'text-slate-600' : 'text-slate-400'}`}>{counts.ALL}</div>
            )}
          </button>
          
          <div className="mx-4 my-2 border-t border-slate-100" />
          
          {/* TIMELINE */}
          <div className="relative flex flex-col pt-1 pb-1">
            {/* The vertical tracking line */}
            <div className="absolute left-[26px] top-4 bottom-7 w-[2px] bg-slate-100 rounded-full" />
            
            {MAIN_PATH.map((opt, i) => {
              const isSelected = value === opt.value;
              return (
                <div key={opt.value} className="relative group">
                  <button 
                    type="button"
                    onClick={() => { onChange(opt.value); setOpen(false); }} 
                    className={`flex items-start gap-3 w-full p-2 rounded-xl transition-all text-left relative z-10 ${isSelected ? ACTIVE_STYLE[opt.value] : 'hover:bg-slate-50'}`}
                  >
                     <div className="relative mt-1 w-6 flex justify-center flex-shrink-0">
                       <div className={`w-2.5 h-2.5 rounded-full ring-4 ${isSelected ? 'ring-white/50' : 'ring-white'} ${opt.dot} shadow-sm group-hover:scale-125 transition-transform`} />
                     </div>
                     <div className="flex-1 min-w-0">
                       <div className={`text-sm font-bold truncate ${isSelected ? '' : 'text-slate-700'}`}>{opt.label}</div>
                       <div className={`text-[11px] leading-snug truncate ${isSelected ? 'opacity-80' : 'text-slate-500'}`}>{opt.description}</div>
                     </div>
                     {counts?.[opt.value] != null && (
                       <div className={`text-xs font-bold mt-0.5 ${isSelected ? 'opacity-90' : 'text-slate-400'}`}>{counts[opt.value]}</div>
                     )}
                  </button>
                  
                  {/* Branch: Info Requested (off Under Review) */}
                  {opt.value === "UnderReview" && (
                     <div className="relative pl-[44px] pr-2 pb-1.5 pt-0.5">
                       {/* L-connector */}
                       <div className="absolute left-[26px] top-0 bottom-[18px] w-[2px] bg-slate-100" />
                       <div className="absolute left-[26px] top-[18px] w-4 h-[2px] bg-slate-100" />
                       
                       <button 
                         type="button"
                         onClick={() => { onChange("InformationRequested"); setOpen(false); }} 
                         className={`flex items-center gap-2 w-full p-2 rounded-lg transition-colors text-left ${value === "InformationRequested" ? ACTIVE_STYLE.InformationRequested : 'hover:bg-amber-50/40'}`}
                       >
                         <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-sm" />
                         <div className={`text-xs font-bold flex-1 ${value === "InformationRequested" ? '' : 'text-slate-600'}`}>Info Requested</div>
                         {counts?.InformationRequested != null && (
                           <div className={`text-[10px] font-bold ${value === "InformationRequested" ? 'opacity-90' : 'text-slate-400'}`}>{counts.InformationRequested}</div>
                         )}
                       </button>
                     </div>
                  )}
                  
                  {/* Branch: Rejected (off Approved) */}
                  {opt.value === "Approved" && (
                     <div className="relative pl-[44px] pr-2 pb-1.5 pt-0.5">
                       {/* L-connector */}
                       <div className="absolute left-[26px] top-[18px] w-4 h-[2px] bg-slate-100" />
                       <button 
                         type="button"
                         onClick={() => { onChange("Declined"); setOpen(false); }} 
                         className={`flex items-center gap-2 w-full p-2 rounded-lg transition-colors text-left ${value === "Declined" ? ACTIVE_STYLE.Declined : 'hover:bg-rose-50/40'}`}
                       >
                         <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-sm" />
                         <div className={`text-xs font-bold flex-1 ${value === "Declined" ? '' : 'text-slate-600'}`}>Rejected</div>
                         {counts?.Declined != null && (
                           <div className={`text-[10px] font-bold ${value === "Declined" ? 'opacity-90' : 'text-slate-400'}`}>{counts.Declined}</div>
                         )}
                       </button>
                     </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
