import { useState, useEffect, useRef } from "react";
import { Branch } from "@/app/services/branches";
import { Agent } from "@/app/services/agents";
import { PAKISTAN_PROVINCES } from "@/lib/pakistanProvinces";

export default function FiltersPanel({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  cityInput,
  onCityInputChange,
  provinceFilter,
  onProvinceChange,
  branchFilter,
  onBranchChange,
  branchOptions,
  agentFilter,
  onAgentChange,
  agentOptions,
  sourceFilter,
  onSourceChange,
  sourceOptions,
  activeCount,
  onClearAll,
}: {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  cityInput: string;
  onCityInputChange: (v: string) => void;
  provinceFilter: string;
  onProvinceChange: (v: string) => void;
  branchFilter: string;
  onBranchChange: (v: string) => void;
  branchOptions: Branch[];
  agentFilter?: string;
  onAgentChange?: (v: string) => void;
  agentOptions?: Agent[];
  sourceFilter?: string;
  onSourceChange?: (v: string) => void;
  sourceOptions?: { id: string; name: string }[];
  activeCount: number;
  onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

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
    if (!open || !containerRef.current) return;

    const updatePosition = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      
      // Look up the closest parent container that controls/clips the page flow
      const scrollParent = containerRef.current.closest(".overflow-auto") || containerRef.current.closest("main");
      const limitLeft = scrollParent ? scrollParent.getBoundingClientRect().left : 0;
      const limitRight = scrollParent ? scrollParent.getBoundingClientRect().right : window.innerWidth;
      const maxAvailableWidth = limitRight - limitLeft - 24; // 12px margin on both sides

      // The desired width of the dropdown (normally 384px, or 320px on small viewports)
      const idealWidth = window.innerWidth < 640 ? 320 : 384;
      const dropdownWidth = Math.min(idealWidth, maxAvailableWidth);

      let leftOffset = 0; // offset relative to the button container's left edge
      const viewportLeft = rect.left;
      const viewportRight = rect.left + dropdownWidth;

      // Adjust to fit within right limit
      if (viewportRight > limitRight - 12) {
        leftOffset = (limitRight - 12) - viewportRight;
      }

      // Adjust to fit within left limit
      if (viewportLeft + leftOffset < limitLeft + 12) {
        leftOffset = (limitLeft + 12) - viewportLeft;
      }

      setDropdownStyle({
        left: `${leftOffset}px`,
        right: "auto",
        maxWidth: `${maxAvailableWidth}px`,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    // Also update when scrolling parent container to keep absolute position aligned
    const scrollParent = containerRef.current.closest(".overflow-auto");
    if (scrollParent) scrollParent.addEventListener("scroll", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
      if (scrollParent) scrollParent.removeEventListener("scroll", updatePosition);
    };
  }, [open]);

  const inputClass = "w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-colors ${
          activeCount > 0
            ? "bg-indigo-50 border-indigo-200 text-indigo-700"
            : "bg-white border-slate-200/60 text-slate-600 hover:bg-slate-50"
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Filters
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div 
          style={dropdownStyle}
          className="absolute z-30 mt-2 w-80 sm:w-96 bg-white border border-slate-200 rounded-xl shadow-lg p-4 space-y-4"
        >
          <div>
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Date Added</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-500">From</label>
                <input type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} className={inputClass} />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-500">To</label>
                <input type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} className={inputClass} />
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">Set both to the same day to filter a single date.</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">City</label>
            <input
              type="text"
              value={cityInput}
              onChange={(e) => onCityInputChange(e.target.value)}
              placeholder="e.g. Lahore"
              className={inputClass}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Province</label>
            <select value={provinceFilter} onChange={(e) => onProvinceChange(e.target.value)} className={inputClass}>
              <option value="">All Provinces</option>
              {PAKISTAN_PROVINCES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Branch</label>
            <select value={branchFilter} onChange={(e) => onBranchChange(e.target.value)} className={inputClass}>
              <option value="">All Branches</option>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          {sourceOptions && onSourceChange && (
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Sources</label>
              <select value={sourceFilter} onChange={(e) => onSourceChange(e.target.value)} className={inputClass}>
                <option value="">All Sources</option>
                {sourceOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {agentOptions && onAgentChange && (
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Assigned Agent</label>
              <select value={agentFilter} onChange={(e) => onAgentChange(e.target.value)} className={inputClass}>
                <option value="">All Agents</option>
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name}</option>
                ))}
              </select>
            </div>
          )}

          {activeCount > 0 && (
            <button
              onClick={onClearAll}
              className="w-full text-center text-xs font-semibold text-indigo-600 hover:underline pt-3 border-t border-slate-100"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
