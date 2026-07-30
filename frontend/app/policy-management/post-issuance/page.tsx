"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import {
  getPolicyStats,
  listPolicies,
  PolicyListItem,
  PolicyStats,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";
import { MetricCard } from "@/components/MetricCard";
import FiltersPanel from "@/components/FiltersPanel";
import { normStatus } from "@/components/policy/lifecycle";

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  GRACEPERIOD: "bg-amber-50 text-amber-700 border-amber-200",
  LAPSED: "bg-red-50 text-red-700 border-red-200",
  CANCELLED: "bg-slate-100 text-slate-600 border-slate-300",
};

// Which lifecycle statuses belong to Stage B (Post Issuance)
const POST_ISSUANCE = new Set(["ACTIVE", "GRACEPERIOD", "LAPSED", "CANCELLED"]);

function PostIssuanceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight");

  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [s, p] = await Promise.all([getPolicyStats(), listPolicies()]);
      setStats(s);
      setPolicies(p);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Base list of only post-issuance policies
  const active = useMemo(() =>
    policies.filter(p => POST_ISSUANCE.has(normStatus(p.status))),
    [policies]);

  const clearFilters = () => {
    setFilterStatus("ALL");
    setTypeFilter("ALL");
    setDateFrom("");
    setDateTo("");
  };

  const structuredFilterCount = [filterStatus !== "ALL", typeFilter !== "ALL", dateFrom || dateTo].filter(Boolean).length;

  const activeFilterChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (filterStatus !== "ALL") activeFilterChips.push({ key: "status", label: filterStatus, onRemove: () => setFilterStatus("ALL") });
  if (typeFilter !== "ALL") activeFilterChips.push({ key: "type", label: typeFilter, onRemove: () => setTypeFilter("ALL") });
  if (dateFrom || dateTo) {
    const label = dateFrom && dateTo
      ? (dateFrom === dateTo ? `On ${dateFrom}` : `${dateFrom} → ${dateTo}`)
      : dateFrom
      ? `From ${dateFrom}`
      : `Until ${dateTo}`;
    activeFilterChips.push({ key: "date", label, onRemove: () => { setDateFrom(""); setDateTo(""); } });
  }

  const filtered = useMemo(() => {
    let list = active;

    // Segment filter
    if (segment !== "all") {
      list = list.filter(p => p.segment === segment);
    }
    if (filterStatus !== "ALL") {
      list = list.filter(p => p.status === filterStatus);
    }
    if (typeFilter !== "ALL") {
      list = list.filter(p => p.insurance_type === typeFilter);
    }
    if (dateFrom || dateTo) {
      list = list.filter(p => {
        const d = new Date(p.created_at || new Date()).getTime();
        const start = dateFrom ? new Date(dateFrom).getTime() : 0;
        const end = dateTo ? new Date(dateTo).getTime() + 86400000 : Infinity;
        return d >= start && d <= end;
      });
    }

    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(p =>
      p.customer_name?.toLowerCase().includes(q) ||
      (p.policy_number ?? "").toLowerCase().includes(q) ||
      p.product_name?.toLowerCase().includes(q)
    );
  }, [active, search, segment, filterStatus, typeFilter, dateFrom, dateTo]);

  const segmentCounts = useMemo(() => {
    return {
      all: active.length,
      individual: active.filter(p => p.segment === "individual").length,
      organization: active.filter(p => p.segment === "organization").length,
      family: active.filter(p => p.segment === "family").length,
    };
  }, [active]);

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Post Policy Issuance</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Stage B — manage in-force policies: free-look, servicing, renewals, claims & exit.
        </p>
      </div>

      {errorMsg && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg border border-red-200">
          <p className="font-bold">Error loading data:</p>
          <p>{errorMsg}</p>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Active Policies", value: stats?.active ?? "—", sub: "in-force coverage", accent: "emerald" as const },
          { title: "Grace Period", value: stats?.grace_period ?? "—", sub: "payment overdue", accent: "amber" as const },
          { title: "Expiring (30d)", value: stats?.expiring_30d ?? "—", sub: "renewal due soon", accent: "blue" as const },
          { title: "Lapsed / Cancelled", value: (stats?.lapsed || 0) + (stats?.cancelled || 0), sub: "coverage terminated", accent: "red" as const },
        ].map(k => (
          <MetricCard
            key={k.title}
            title={k.title}
            value={loading ? "—" : k.value}
            subtitle={k.sub}
            accent={k.accent}
          />
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center">
          
          {/* Segment Toggle */}
          <SegmentDropdown
            value={segment}
            onChange={setSegment}
            counts={segmentCounts}
          />

          <div className="flex flex-col md:flex-row gap-3 w-full md:w-auto items-stretch md:items-center">
            {/* Search */}
            <div className="relative w-full md:w-72">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search policy, customer, product..."
                className="w-full text-sm border border-slate-200 rounded-lg pl-9 pr-3 py-2 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-300 transition-colors"
              />
            </div>

            {/* FiltersPanel Component */}
            <FiltersPanel
              statusFilter={filterStatus}
              typeFilter={typeFilter}
              dateFrom={dateFrom}
              dateTo={dateTo}
              onStatusChange={setFilterStatus}
              onTypeChange={setTypeFilter}
              onDateFromChange={setDateFrom}
              onDateToChange={setDateTo}
              onClearAll={clearFilters}
              activeCount={structuredFilterCount}
              statusOptions={[
                { value: "Active", label: "Active" },
                { value: "Grace Period", label: "Grace Period" },
                { value: "Lapsed", label: "Lapsed" },
                { value: "Cancelled", label: "Cancelled" },
              ]}
              typeOptions={[
                { value: "Term Life", label: "Term Life" },
                { value: "Health & Cash", label: "Health & Cash" },
                { value: "Endowment", label: "Endowment" },
                { value: "Unit Linked", label: "Unit Linked" },
                { value: "Group Health", label: "Group Health" },
                { value: "Group Life", label: "Group Life" },
              ]}
            />
          </div>
        </div>

        {/* Active Filter Chips */}
        {activeFilterChips.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
            <span className="text-xs text-slate-400 font-medium">Active filters:</span>
            {activeFilterChips.map(chip => (
              <span key={chip.key} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-[11px] font-semibold border border-emerald-100">
                {chip.label}
                <button onClick={chip.onRemove} className="hover:text-emerald-900 transition-colors">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </span>
            ))}
            <button onClick={clearFilters} className="text-[11px] text-slate-400 hover:text-slate-600 underline ml-2 transition-colors">
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <th className="px-5 py-3 font-medium">Customer</th>
                <th className="px-5 py-3 font-medium">Policy No.</th>
                <th className="px-5 py-3 font-medium">Product / Coverage</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Effective Date</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-16 text-center">
                    <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-200 border-t-emerald-500 mx-auto" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-16 text-center">
                    <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-50 mb-3 border border-slate-100">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-slate-400">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                    </div>
                    <p className="text-slate-500 font-medium">No policies found</p>
                    <p className="text-slate-400 text-xs mt-1">Try adjusting your search or filters.</p>
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr 
                    key={p.id} 
                    className={
                      p.id === highlightId 
                        ? "highlight-row" 
                        : "hover:bg-slate-50/80 transition-colors group"
                    }
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-600 flex-shrink-0">
                          {(p.customer_name || "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800">{p.customer_name}</p>
                          <p className="text-[11px] text-slate-400 capitalize">{p.segment ?? "Individual"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="font-mono text-xs font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 inline-block">
                        {p.policy_number ?? "Pending"}
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-slate-700">{p.product_name}</p>
                      <p className="text-[11px] text-slate-400">
                        {fmtCoverage(p.coverage_amount)} · {p.term_years} yrs
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase border ${STATUS_BADGE[normStatus(p.status)] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-500 text-xs">
                      {p.effective_date ? new Date(p.effective_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => router.push(`/post-issuance/${p.id}`)}
                        className="text-[11px] font-semibold tracking-widest text-emerald-600 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 hover:border-emerald-200 px-3 py-1.5 rounded-lg transition-all"
                      >
                        MANAGE
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-3 flex items-center justify-between text-xs text-slate-500">
          <p>Showing {filtered.length} of {active.length} policies</p>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes highlightBlink {
          0%, 100% { background-color: #f8fafc; border-left-color: transparent; }
          20%, 80% { background-color: #d1fae5; border-left-color: #10b981; }
        }
        .highlight-row {
          animation: highlightBlink 2s ease-in-out infinite;
          background-color: #ecfdf5;
          border-left: 3px solid #10b981;
        }
      `}} />
    </div>
  );
}

export default function PostIssuanceListPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500">Loading Dashboard...</div>}>
      <PostIssuanceContent />
    </Suspense>
  );
}
