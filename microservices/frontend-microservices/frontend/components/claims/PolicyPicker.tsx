"use client";

import { displayDate } from '../../lib/dateDisplay';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PolicyListItem } from "@/app/services/policies";
import { tx } from "@/lib/i18n/tx";

// ── Filter state ─────────────────────────────────────────────────────────────

export type CoverageBand = "ALL" | "LT5" | "5_15" | "15_25" | "GT25";
export type PolicySort = "default" | "name" | "coverage_desc" | "coverage_asc" | "newest" | "expiry";

const BANDS: { id: CoverageBand; label: string; test: (n: number) => boolean }[] = [
  { id: "ALL", label: "Any coverage", test: () => true },
  { id: "LT5", label: "Under PKR 5M", test: (n) => n < 5_000_000 },
  { id: "5_15", label: "PKR 5M – 15M", test: (n) => n >= 5_000_000 && n < 15_000_000 },
  { id: "15_25", label: "PKR 15M – 25M", test: (n) => n >= 15_000_000 && n < 25_000_000 },
  { id: "GT25", label: "Over PKR 25M", test: (n) => n >= 25_000_000 },
];

const SORTS: { id: PolicySort; label: string }[] = [
  { id: "default", label: "Default order" },
  { id: "name", label: "Customer A–Z" },
  { id: "coverage_desc", label: "Coverage: high to low" },
  { id: "coverage_asc", label: "Coverage: low to high" },
  { id: "newest", label: "Newest first" },
  { id: "expiry", label: "Expiry: soonest" },
];

/** Filter state lives with the caller so it survives going to step 2 and back. */
export function usePolicyFilters() {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [coverage, setCoverage] = useState<CoverageBand>("ALL");
  const [segment, setSegment] = useState("ALL");
  const [branch, setBranch] = useState("ALL");
  const [sort, setSort] = useState<PolicySort>("default");

  const reset = () => {
    setSearch("");
    setType("ALL");
    setStatus("ALL");
    setCoverage("ALL");
    setSegment("ALL");
    setBranch("ALL");
    setSort("default");
  };
  const activeCount =
    (search.trim() ? 1 : 0) + [type, status, coverage, segment, branch].filter((v) => v !== "ALL").length;

  return {
    search, setSearch, type, setType, status, setStatus, coverage, setCoverage,
    segment, setSegment, branch, setBranch, sort, setSort, reset, activeCount,
  };
}
export type PolicyFilters = ReturnType<typeof usePolicyFilters>;

// ── Small helpers ────────────────────────────────────────────────────────────

const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
const titleCase = (s: string) => humanize(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const fmtDate = (s: string | null) =>
  s ? displayDate(s, { day: "2-digit", month: "short", year: "numeric" }) : "—";
const initials = (name: string) =>
  (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "active" || s === "issued" || s === "inforce") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s.includes("grace")) return "bg-amber-50 text-amber-700 border-amber-200";
  if (/(lapse|cancel|expire|surrender|terminat)/.test(s)) return "bg-rose-50 text-rose-700 border-rose-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

function Chip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-semibold transition-colors ${
        active
          ? "bg-blue-600 border-blue-600 text-white shadow-2xs"
          : count === 0
            ? "bg-white border-slate-200 text-slate-300"
            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300"
      }`}
    >
      {label}
      <span className={`text-[10px] font-bold ${active ? "text-blue-100" : "text-slate-400"}`}>{count}</span>
    </button>
  );
}

const selectClass =
  "w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
const labelClass = "block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1";

// ── The picker ───────────────────────────────────────────────────────────────

export function PolicyPicker({
  policies,
  filters: f,
  selectedId,
  onSelect,
}: {
  policies: PolicyListItem[];
  filters: PolicyFilters;
  selectedId: string;
  onSelect: (p: PolicyListItem) => void;
}) {
  type Skip = "type" | "status" | "coverage" | "segment" | "branch";

  // Every filter except the one named in `skip`, so each facet's counts show what choosing it WOULD give.
  const matches = (p: PolicyListItem, skip?: Skip) => {
    const q = f.search.trim().toLowerCase();
    if (q) {
      const hay = [p.policy_number || p.id, p.customer_name, p.product_name, p.insurance_type, p.case_number]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (skip !== "type" && f.type !== "ALL" && p.insurance_type !== f.type) return false;
    if (skip !== "status" && f.status !== "ALL" && p.status !== f.status) return false;
    if (skip !== "coverage" && f.coverage !== "ALL" && !BANDS.find((b) => b.id === f.coverage)!.test(p.coverage_amount || 0)) return false;
    if (skip !== "segment" && f.segment !== "ALL" && (p.segment ?? "") !== f.segment) return false;
    if (skip !== "branch" && f.branch !== "ALL" && (p.branch_name ?? "") !== f.branch) return false;
    return true;
  };

  const distinct = (get: (p: PolicyListItem) => string | null | undefined) =>
    Array.from(new Set(policies.map(get).filter((v): v is string => !!v))).sort();
  const types = useMemo(() => distinct((p) => p.insurance_type), [policies]);          // eslint-disable-line react-hooks/exhaustive-deps
  const statuses = useMemo(() => distinct((p) => p.status), [policies]);               // eslint-disable-line react-hooks/exhaustive-deps
  const segments = useMemo(() => distinct((p) => p.segment), [policies]);              // eslint-disable-line react-hooks/exhaustive-deps
  const branches = useMemo(() => distinct((p) => p.branch_name), [policies]);          // eslint-disable-line react-hooks/exhaustive-deps

  const countOf = (skip: Skip, get: (p: PolicyListItem) => string | null | undefined) => {
    const out: Record<string, number> = {};
    let all = 0;
    for (const p of policies) {
      if (!matches(p, skip)) continue;
      all += 1;
      const k = get(p);
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return { all, by: out };
  };
  const typeCounts = countOf("type", (p) => p.insurance_type);
  const statusCounts = countOf("status", (p) => p.status);
  const segmentCounts = countOf("segment", (p) => p.segment);
  const branchCounts = countOf("branch", (p) => p.branch_name);
  const bandCounts = BANDS.map((b) => ({
    ...b,
    n: policies.filter((p) => matches({ ...p, coverage_amount: p.coverage_amount || 0 }, "coverage") && b.test(p.coverage_amount || 0)).length,
  }));

  const results = useMemo(() => {
    const list = policies.filter((p) => matches(p));
    const by: Record<PolicySort, ((a: PolicyListItem, b: PolicyListItem) => number) | null> = {
      default: null,
      name: (a, b) => (a.customer_name || "").localeCompare(b.customer_name || "") || (a.product_name || "").localeCompare(b.product_name || ""),
      coverage_desc: (a, b) => (b.coverage_amount || 0) - (a.coverage_amount || 0),
      coverage_asc: (a, b) => (a.coverage_amount || 0) - (b.coverage_amount || 0),
      newest: (a, b) => (b.created_at || "").localeCompare(a.created_at || ""),
      expiry: (a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999"),
    };
    const cmp = by[f.sort];
    return cmp ? [...list].sort(cmp) : list;
  }, [policies, f.search, f.type, f.status, f.coverage, f.segment, f.branch, f.sort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: ↑/↓ move through the results from the search box, Enter picks the highlighted one.
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [f.search, f.type, f.status, f.coverage, f.segment, f.branch, f.sort]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault(); // inside the claim <form>: Enter must pick a policy, not submit
      const p = results[active];
      if (p) onSelect(p);
    }
  };

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <input
          type="text"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="fnol-policy-list"
          aria-label={tx("Search policies")}
          placeholder={tx("Search by customer, policy #, product, plan type or case #…")}
          value={f.search}
          onChange={(e) => f.setSearch(e.target.value)}
          onKeyDown={onSearchKey}
          className="w-full text-xs px-3.5 py-2.5 pl-9 pr-8 rounded-xl border border-slate-200 focus:outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 bg-white font-medium text-slate-800 placeholder-slate-400 shadow-2xs"
        />
        <svg className="w-4 h-4 text-slate-400 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        {f.search && (
          <button
            type="button"
            aria-label={tx("Clear search")}
            onClick={() => f.setSearch("")}
            className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-slate-100"
          >
            ×
          </button>
        )}
      </div>

      {/* Plan type */}
      {types.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label={tx("Plan type")}>
          <Chip active={f.type === "ALL"} label={tx("All plans")} count={typeCounts.all} onClick={() => f.setType("ALL")} />
          {types.map((t) => (
            <Chip key={t} active={f.type === t} label={titleCase(t)} count={typeCounts.by[t] ?? 0} onClick={() => f.setType(f.type === t ? "ALL" : t)} />
          ))}
        </div>
      )}

      {/* Dropdown filters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div>
          <label className={labelClass}>{tx("Status")}</label>
          <select className={selectClass} value={f.status} onChange={(e) => f.setStatus(e.target.value)}>
            <option value="ALL">{tx("All statuses")} ({statusCounts.all})</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{titleCase(s)} ({statusCounts.by[s] ?? 0})</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>{tx("Coverage")}</label>
          <select className={selectClass} value={f.coverage} onChange={(e) => f.setCoverage(e.target.value as CoverageBand)}>
            {bandCounts.map((b) => (
              <option key={b.id} value={b.id}>{tx(b.label)} ({b.n})</option>
            ))}
          </select>
        </div>
        {segments.length > 1 && (
          <div>
            <label className={labelClass}>{tx("Segment")}</label>
            <select className={selectClass} value={f.segment} onChange={(e) => f.setSegment(e.target.value)}>
              <option value="ALL">{tx("All segments")} ({segmentCounts.all})</option>
              {segments.map((s) => (
                <option key={s} value={s}>{titleCase(s)} ({segmentCounts.by[s] ?? 0})</option>
              ))}
            </select>
          </div>
        )}
        {branches.length > 1 && (
          <div>
            <label className={labelClass}>{tx("Branch")}</label>
            <select className={selectClass} value={f.branch} onChange={(e) => f.setBranch(e.target.value)}>
              <option value="ALL">{tx("All branches")} ({branchCounts.all})</option>
              {branches.map((b) => (
                <option key={b} value={b}>{b} ({branchCounts.by[b] ?? 0})</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className={labelClass}>{tx("Sort by")}</label>
          <select className={selectClass} value={f.sort} onChange={(e) => f.setSort(e.target.value as PolicySort)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>{tx(s.label)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Result count + clear */}
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <p aria-live="polite" className="font-medium">
          {tx("Showing {0} of {1} policies", { 0: results.length, 1: policies.length })}
        </p>
        {f.activeCount > 0 && (
          <button type="button" onClick={f.reset} className="font-semibold text-blue-700 hover:underline">
            {tx("Clear all filters")} ({f.activeCount})
          </button>
        )}
      </div>

      {/* Results */}
      <div
        ref={listRef}
        id="fnol-policy-list"
        role="listbox"
        aria-label={tx("Policies")}
        className="max-h-[40vh] overflow-y-auto divide-y divide-slate-100 border border-slate-200/90 rounded-xl bg-white shadow-2xs"
      >
        {results.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-semibold text-slate-600">
              {policies.length === 0 ? tx("No policies available.") : tx("No policies match your filters.")}
            </p>
            {policies.length > 0 && (
              <>
                <p className="text-xs text-slate-400 mt-1">{tx("Try a different search, or remove a filter.")}</p>
                {f.activeCount > 0 && (
                  <button
                    type="button"
                    onClick={f.reset}
                    className="mt-3 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    {tx("Clear all filters")}
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          results.map((p, idx) => {
            const isSelected = selectedId === p.id;
            const isActive = idx === active;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-idx={idx}
                onClick={() => onSelect(p)}
                onMouseEnter={() => setActive(idx)}
                className={`w-full text-left px-3.5 py-3 text-xs transition-colors flex items-center gap-3 ${
                  isSelected ? "bg-blue-50/90" : isActive ? "bg-slate-50" : "bg-white"
                } ${isActive ? "ring-1 ring-inset ring-blue-200" : ""}`}
              >
                <span
                  aria-hidden="true"
                  className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ${
                    isSelected ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {initials(p.customer_name)}
                </span>

                <span className="flex-1 min-w-0 space-y-1">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-900 text-[13px]">{p.customer_name}</span>
                    <span className="font-mono text-slate-400 text-[11px]">({p.policy_number ?? p.id.slice(0, 8)})</span>
                  </span>
                  <span className="flex items-center gap-1.5 flex-wrap text-[11px] text-slate-500">
                    <span className="font-medium text-slate-600">{p.product_name}</span>
                    <span aria-hidden="true">•</span>
                    <span>{titleCase(p.insurance_type || "Standard")}</span>
                    <span aria-hidden="true">•</span>
                    <span>{p.term_years} {tx("yrs")}</span>
                    <span aria-hidden="true">•</span>
                    <span>{tx("Expires")} {fmtDate(p.expiry_date)}</span>
                    {p.branch_name && (
                      <>
                        <span aria-hidden="true">•</span>
                        <span>{p.branch_name}</span>
                      </>
                    )}
                  </span>
                </span>

                <span className="shrink-0 text-right space-y-1">
                  <span className="block font-bold text-slate-900 text-[13px]">
                    {tx("PKR")} {(p.coverage_amount || 0).toLocaleString()}
                  </span>
                  <span className="flex items-center justify-end gap-2">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusTone(p.status)}`}>
                      {titleCase(p.status)}
                    </span>
                    {isSelected ? (
                      <span className="px-2.5 py-0.5 rounded-md text-[10px] font-bold bg-blue-600 text-white shadow-2xs">
                        {tx("Selected ✓")}
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-400 font-medium">{tx("Select →")}</span>
                    )}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
