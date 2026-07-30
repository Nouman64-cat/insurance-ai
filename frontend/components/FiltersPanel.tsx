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
  statusFilter,
  onStatusChange,
  statusOptions,
  typeFilter,
  onTypeChange,
  typeOptions,
  activeCount,
  onClearAll,
}: {
  dateFrom?: string;
  dateTo?: string;
  onDateFromChange?: (v: string) => void;
  onDateToChange?: (v: string) => void;
  cityInput?: string;
  onCityInputChange?: (v: string) => void;
  provinceFilter?: string;
  onProvinceChange?: (v: string) => void;
  branchFilter?: string;
  onBranchChange?: (v: string) => void;
  branchOptions?: Branch[];
  agentFilter?: string;
  onAgentChange?: (v: string) => void;
  agentOptions?: Agent[];
  sourceFilter?: string;
  onSourceChange?: (v: string) => void;
  sourceOptions?: { id: string; name: string }[];
  statusFilter?: string;
  onStatusChange?: (v: string) => void;
  statusOptions?: { value: string; label: string }[];
  typeFilter?: string;
  onTypeChange?: (v: string) => void;
  typeOptions?: { value: string; label: string }[];
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
      const scrollParent = containerRef.current.closest(".overflow-auto") || containerRef.current.closest("main");
      const limitLeft = scrollParent ? scrollParent.getBoundingClientRect().left : 0;
      const limitRight = scrollParent ? scrollParent.getBoundingClientRect().right : window.innerWidth;
      const maxAvailableWidth = limitRight - limitLeft - 24;

      const idealWidth = window.innerWidth < 640 ? 320 : 384;
      const dropdownWidth = Math.min(idealWidth, maxAvailableWidth);

      let leftOffset = 0;
      const viewportLeft = rect.left;
      const viewportRight = rect.left + dropdownWidth;

      if (viewportRight > limitRight - 12) {
        leftOffset = (limitRight - 12) - viewportRight;
      }

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
    const scrollParent = containerRef.current.closest(".overflow-auto");
    if (scrollParent) scrollParent.addEventListener("scroll", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
      if (scrollParent) scrollParent.removeEventListener("scroll", updatePosition);
    };
  }, [open]);

  const inputClass = "w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-colors h-[42px] ${
          activeCount > 0
            ? "bg-blue-50 border-blue-200 text-blue-700"
            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm"
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Filters
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] px-1.5 rounded-full bg-blue-600 text-white text-[10px] font-bold shadow-sm">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div 
          className="absolute z-30 mt-2 w-80 sm:w-96 bg-white border border-slate-100 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-5 space-y-5"
          style={{ ...dropdownStyle, animation: 'slideDown 0.15s ease-out forwards' }}
        >
          {(onDateFromChange || onDateToChange) && (
            <div>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Date Range</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-500">From</label>
                  <input type="date" value={dateFrom || ""} onChange={(e) => onDateFromChange?.(e.target.value)} className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-500">To</label>
                  <input type="date" value={dateTo || ""} onChange={(e) => onDateToChange?.(e.target.value)} className={inputClass} />
                </div>
              </div>
            </div>
          )}

          {statusOptions && onStatusChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status</label>
              <select value={statusFilter || ""} onChange={(e) => onStatusChange(e.target.value)} className={inputClass}>
                <option value="ALL">All Statuses</option>
                {statusOptions.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          )}

          {typeOptions && onTypeChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Type</label>
              <select value={typeFilter || ""} onChange={(e) => onTypeChange(e.target.value)} className={inputClass}>
                <option value="ALL">All Types</option>
                {typeOptions.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          )}

          {onCityInputChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">City</label>
              <input
                type="text"
                value={cityInput || ""}
                onChange={(e) => onCityInputChange(e.target.value)}
                placeholder="e.g. Lahore"
                className={inputClass}
              />
            </div>
          )}

          {onProvinceChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Province</label>
              <select value={provinceFilter || ""} onChange={(e) => onProvinceChange(e.target.value)} className={inputClass}>
                <option value="">All Provinces</option>
                {PAKISTAN_PROVINCES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}

          {branchOptions && onBranchChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Branch</label>
              <select value={branchFilter || ""} onChange={(e) => onBranchChange(e.target.value)} className={inputClass}>
                <option value="">All Branches</option>
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          )}

          {sourceOptions && onSourceChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Sources</label>
              <select value={sourceFilter || ""} onChange={(e) => onSourceChange(e.target.value)} className={inputClass}>
                <option value="">All Sources</option>
                {sourceOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {agentOptions && onAgentChange && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Assigned Agent</label>
              <select value={agentFilter || ""} onChange={(e) => onAgentChange(e.target.value)} className={inputClass}>
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
              className="w-full text-center text-xs font-semibold text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg py-2 transition-colors border border-transparent hover:border-blue-100"
            >
              Clear all filters
            </button>
          )}
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
