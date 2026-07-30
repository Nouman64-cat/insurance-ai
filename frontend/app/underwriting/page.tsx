"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { SegmentDropdown, SegmentFilter, SEGMENT_LABEL, SEGMENT_BADGE_STYLE } from "@/components/SegmentDropdown";
import { fmtCoverage } from "@/lib/mock-data";
import { listCases, CaseQueueItem } from "@/app/services/cases";
import { createCounterOffer } from "@/app/services/preIssuance";
import api from "@/app/services/api";
import FiltersPanel from "@/components/FiltersPanel";

const CASE_STATUS_STYLE: Record<string, string> = {
  New: "bg-slate-100 text-slate-600 border-slate-200",
  InProgress: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  Closed: "bg-slate-200 text-slate-700 border-slate-300",
};

interface CustomerFolder {
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
  customer_segment: "individual" | "family" | "organization";
  cases: CaseQueueItem[];
}

export default function UnderwritingPage() {
  const router = useRouter();
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [counterOfferCase, setCounterOfferCase] = useState<CaseQueueItem | null>(null);

  useEffect(() => {
    const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (!tenantId) { setLoading(false); return; }
    listCases(tenantId, "Underwriting")
      .then(setCases)
      .catch(err => setError(err.message ?? "Failed to load underwriting cases."))
      .finally(() => setLoading(false));
  }, []);

  const toggleFolder = (customerId: string) => {
    setExpandedCustomerId((prev) => (prev === customerId ? null : customerId));
  };

  const handleDownloadReport = async (c: CaseQueueItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const tenantId = localStorage.getItem("tenant_id") ?? "";
      if (!tenantId) return;
      const res = await api.get(`/tenants/${tenantId}/cases/${c.caseld}/detail`, { headers: { "X-Tenant-Id": tenantId } });
      const { customer, latest_assessment, policy } = res.data;
      if (!latest_assessment) {
        alert("No AI assessment available to download for this case.");
        return;
      }

      const { generateAssessmentPDF } = await import("@/lib/pdf-export");
      await generateAssessmentPDF({
        customer_name: customer?.name ?? "Unknown",
        customer_cnic: customer?.cnic ?? "Unknown",
        case_id: c.caseld,
        created_at: latest_assessment.created_at,
        medical_score: latest_assessment.medical_score,
        financial_score: latest_assessment.financial_score,
        fraud_probability: latest_assessment.fraud_probability,
        composite_risk_score: latest_assessment.composite_risk_score,
        ai_decision: latest_assessment.ai_decision,
        suggested_loading: latest_assessment.suggested_loading,
        reasons: latest_assessment.reasons ?? [],
        ai_summary: null,
        product_name: policy?.product_name ?? null,
      });
    } catch (err) {
      console.error("Failed to download report:", err);
      alert("Failed to download report.");
    }
  };

  const clearFilters = () => {
    setFilterStatus("ALL");
    setDateFrom("");
    setDateTo("");
  };

  const structuredFilterCount = [filterStatus !== "ALL", dateFrom || dateTo].filter(Boolean).length;

  const activeFilterChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (filterStatus !== "ALL") activeFilterChips.push({ key: "status", label: filterStatus, onRemove: () => setFilterStatus("ALL") });
  if (dateFrom || dateTo) {
    const label = dateFrom && dateTo
      ? (dateFrom === dateTo ? `On ${dateFrom}` : `${dateFrom} → ${dateTo}`)
      : dateFrom
      ? `From ${dateFrom}`
      : `Until ${dateTo}`;
    activeFilterChips.push({ key: "date", label, onRemove: () => { setDateFrom(""); setDateTo(""); } });
  }

  // The dropdown-selected segment scopes which cases count toward the stats
  // and folder list; the search box then narrows within that scope.
  const segmentCases = useMemo(() => {
    let list = cases;
    if (segment !== "all") {
      list = list.filter(c => (c.customer_segment ?? "individual") === segment);
    }
    if (filterStatus !== "ALL") {
      list = list.filter(c => c.caseStatus === filterStatus);
    }
    if (dateFrom || dateTo) {
      list = list.filter(c => {
        const d = new Date(c.createdAt).getTime();
        const start = dateFrom ? new Date(dateFrom).getTime() : 0;
        const end = dateTo ? new Date(dateTo).getTime() + 86400000 : Infinity; // +1 day for inclusive end date
        return d >= start && d <= end;
      });
    }
    return list;
  }, [cases, segment, filterStatus, dateFrom, dateTo]);

  const segmentCounts = useMemo(() => {
    const counts: Partial<Record<SegmentFilter, number>> = {};
    
    // Individual
    const ind = cases.filter(c => (c.customer_segment ?? "individual") === "individual");
    counts["individual"] = new Set(ind.map(c => c.customer_id)).size;

    // Organization
    const org = cases.filter(c => c.customer_segment === "organization");
    counts["organization"] = new Set(org.map(c => c.organization_id).filter(Boolean)).size;

    // Family
    const fam = cases.filter(c => c.customer_segment === "family");
    counts["family"] = new Set(fam.map(c => c.family_group_id).filter(Boolean)).size;

    counts["all"] = (counts["individual"] || 0) + (counts["organization"] || 0) + (counts["family"] || 0);

    return counts;
  }, [cases]);

  // Group cases into one folder per customer — same pattern as the Quotations page.
  const folders = useMemo<CustomerFolder[]>(() => {
    const q = search.trim().toLowerCase();
    const filteredList = q
      ? segmentCases.filter(c =>
          (c.customer_name ?? "").toLowerCase().includes(q) ||
          (c.customer_cnic ?? "").toLowerCase().includes(q) ||
          c.caseNumber.toLowerCase().includes(q),
        )
      : segmentCases;

    const grouped = new Map<string, CustomerFolder>();
    for (const c of filteredList) {
      const groupId = c.customer_segment === "organization" && c.organization_id ? c.organization_id
        : c.customer_segment === "family" && c.family_group_id ? c.family_group_id
        : c.customer_id;

      if (!grouped.has(groupId)) {
        grouped.set(groupId, {
          customer_id: groupId, // use groupId as the folder's id
          customer_name: c.customer_segment === "organization" ? "Corporate Account" 
                         : c.customer_segment === "family" ? (c.family_group_name ?? `${c.customer_name} & Family`)
                         : c.customer_name ?? "Unknown Customer",
          customer_cnic: c.customer_segment === "individual" ? (c.customer_cnic ?? "—") : "Multiple",
          customer_segment: c.customer_segment ?? "individual",
          cases: [],
        });
      }
      grouped.get(groupId)!.cases.push(c);
    }
    return Array.from(grouped.values());
  }, [segmentCases, search]);

  const leadDisplayIds = useMemo(() => {
    const groupedBySegment = new Map<string, Array<{ groupId: string; createdAt: string }>>();
    for (const c of cases) {
      const segment = (c.customer_segment ?? "individual") as "individual" | "family" | "organization";
      const groupId = segment === "organization" && c.organization_id ? c.organization_id
        : segment === "family" && c.family_group_id ? c.family_group_id
        : c.customer_id;
      if (!groupedBySegment.has(segment)) groupedBySegment.set(segment, []);
      if (!groupedBySegment.get(segment)!.some(item => item.groupId === groupId)) {
        groupedBySegment.get(segment)!.push({ groupId, createdAt: c.createdAt });
      }
    }

    const displayIds: Record<string, string> = {};
    for (const [segment, items] of groupedBySegment.entries()) {
      const sorted = [...items].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const prefix = segment === "family" ? "FAM" : segment === "organization" ? "CORP" : "IND";
      sorted.forEach((item, index) => {
        const dt = new Date(item.createdAt);
        const yymm = `${dt.getFullYear().toString().slice(-2)}${(dt.getMonth() + 1).toString().padStart(2, "0")}`;
        const seq = (index + 1).toString().padStart(3, "0");
        displayIds[item.groupId] = `${prefix}-${yymm}-${seq}`;
      });
    }
    return displayIds;
  }, [cases]);

  const kpis = useMemo(() => {
    let pendingDocs = 0;
    let underReview = 0;
    let approved = 0;
    
    for (const folder of folders) {
      const statuses = folder.cases.map(c => c.caseStatus);
      if (statuses.includes("Pending Documents")) {
        pendingDocs++;
      } else if (statuses.every(s => s === "Approved")) {
        approved++;
      } else {
        underReview++;
      }
    }
    
    return [
      { title: "Cases", value: folders.length, subtitle: "total cases", accent: "blue" as const },
      { title: "Awaiting Documents", value: pendingDocs, subtitle: "checklist incomplete", accent: "amber" as const },
      { title: "In Underwriting", value: underReview, subtitle: "not yet decided", accent: "slate" as const },
      { title: "Approved", value: approved, subtitle: "ready to issue", accent: "emerald" as const },
    ];
  }, [folders]);

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Underwriting</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Every case opened once a quotation is proceeded — grouped by customer, with documents, AI risk scoring, and decision all in one folder.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <input
            type="text"
            placeholder="Search by customer, CNIC, or case number…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
          />
          <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
          
          <FiltersPanel
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
            statusFilter={filterStatus}
            onStatusChange={setFilterStatus}
            statusOptions={[
              { value: "New", label: "New" },
              { value: "InProgress", label: "In Progress" },
              { value: "Pending Documents", label: "Pending Documents" },
              { value: "Under Review", label: "Under Review" },
              { value: "Approved", label: "Approved" },
              { value: "Rejected", label: "Rejected" },
              { value: "Closed", label: "Closed" }
            ]}
            activeCount={structuredFilterCount}
            onClearAll={clearFilters}
          />
        </div>
        <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner border border-slate-200/60 shrink-0">
          <button
            onClick={() => setViewMode("list")}
            title="List View"
            className={`p-2 rounded-lg transition-all ${viewMode === "list" ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
          </button>
          <button
            onClick={() => setViewMode("grid")}
            title="Grid View"
            className={`p-2 rounded-lg transition-all ${viewMode === "grid" ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
          </button>
        </div>
      </div>

      {activeFilterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-2">
          {activeFilterChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-700 text-xs font-medium"
            >
              {chip.label}
              <button
                onClick={chip.onRemove}
                className="w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-emerald-100 text-emerald-400 hover:text-emerald-700"
              >
                ✕
              </button>
            </span>
          ))}
          <button onClick={clearFilters} className="text-xs font-semibold text-slate-400 hover:text-emerald-600 hover:underline ml-1">
            Clear all
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 flex justify-center"><div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" /></div>
        ) : folders.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <span className="text-2xl">📁</span>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {cases.length === 0
                ? "No underwriting cases yet"
                : segmentCases.length === 0
                ? `No ${SEGMENT_LABEL[segment as "individual" | "family" | "organization"] ?? ""} cases`
                : "No cases match your search"}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {cases.length === 0
                ? "A folder opens automatically the moment a customer proceeds with a quotation."
                : segmentCases.length === 0
                ? "Try switching the segment filter to All Cases."
                : "Try a different customer name, CNIC, or case number."}
            </p>
          </div>
        ) : (
          <div className={viewMode === "grid" ? "p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "p-4 flex flex-col gap-3"}>
            {folders.map((folder) => {
              const isExpanded = expandedCustomerId === folder.customer_id;
              const decidedCount = folder.cases.filter(c => c.latest_ai_decision).length;
              return (
                <div
                  key={folder.customer_id}
                  className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-200 ${isExpanded ? "border-blue-200 shadow-md ring-1 ring-blue-500/20" : "border-slate-200 shadow-sm hover:shadow-md hover:border-blue-200 bg-white"} ${viewMode === "grid" ? "" : "w-full"}`}
                >
                  {/* Folder Header */}
                  <div
                    onClick={() => toggleFolder(folder.customer_id)}
                    className={`flex items-start justify-between cursor-pointer select-none ${isExpanded ? "bg-blue-50/50" : "bg-white"} ${viewMode === "grid" ? "p-5" : "p-4"}`}
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className={`flex-shrink-0 flex items-center justify-center rounded-xl ${isExpanded ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"} transition-colors ${viewMode === "grid" ? "w-10 h-10" : "w-9 h-9"}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" width={viewMode === "grid" ? 20 : 18} height={viewMode === "grid" ? 20 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {isExpanded ? (
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                          ) : (
                            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>
                          )}
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-slate-900 truncate leading-tight" title={folder.customer_name}>
                          {folder.customer_name}
                        </h3>
                        <p className="text-[11px] text-slate-500 font-mono mt-0.5">{folder.customer_cnic}</p>
                        {leadDisplayIds[folder.customer_id] && (
                          <p className="text-[11px] font-medium text-slate-500 mt-1">Lead ID: {leadDisplayIds[folder.customer_id]}</p>
                        )}

                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {segment === "all" && (
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold border uppercase tracking-wide ${SEGMENT_BADGE_STYLE[folder.customer_segment]}`}>
                              {SEGMENT_LABEL[folder.customer_segment]}
                            </span>
                          )}
                          {decidedCount > 0 && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                              {decidedCount} evaluated
                            </span>
                          )}
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-semibold border ${isExpanded ? "bg-blue-100 text-blue-700 border-blue-200" : "bg-slate-100 text-slate-600 border-slate-200"}`}>
                            {folder.cases.length} {folder.cases.length === 1 ? "Case" : "Cases"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-center ml-2 pt-1">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-slate-400 transition-transform duration-200 ${isExpanded ? "rotate-180 text-blue-500" : ""}`}>
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-white overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                            <th className="px-5 py-3 text-left">Case</th>
                            <th className="px-5 py-3 text-left">Product</th>
                            <th className="px-5 py-3 text-right">Sum Assured</th>
                            <th className="px-5 py-3 text-left">Case Status</th>
                            <th className="px-5 py-3 text-left">AI Decision</th>
                            <th className="px-5 py-3 text-left" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {folder.cases.map(c => (
                            <tr key={c.caseld} onClick={() => router.push(`/case/${c.caseld}`)} className="hover:bg-slate-50 cursor-pointer transition-colors">
                              <td className="px-5 py-3">
                                <p className="text-xs font-semibold text-slate-900 truncate max-w-[150px]">{c.customer_name}</p>
                                <p className="font-mono text-[10px] text-slate-500 mt-0.5">{c.caseNumber}</p>
                              </td>
                              <td className="px-5 py-3 text-slate-600 text-xs">{c.product_name ?? "—"}</td>
                              <td className="px-5 py-3 text-right font-semibold text-slate-700">{c.coverage_amount != null ? fmtCoverage(c.coverage_amount) : "—"}</td>
                              <td className="px-5 py-3">
                                <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${CASE_STATUS_STYLE[c.caseStatus] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                                  {c.caseStatus}
                                </span>
                              </td>
                              <td className="px-5 py-3">
                                {c.latest_ai_decision ? <StatusBadge decision={c.latest_ai_decision} /> : <span className="text-xs text-slate-300">Not yet evaluated</span>}
                              </td>
                              <td className="px-5 py-3 text-right">
                                <div className="flex items-center justify-end gap-3">
                                  {c.latest_ai_decision && (
                                    <button
                                      onClick={(e) => handleDownloadReport(c, e)}
                                      className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
                                      </svg>
                                      Report
                                    </button>
                                  )}
                                  {c.policy_id && c.caseStatus !== "Approved" && c.caseStatus !== "Rejected" && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setCounterOfferCase(c); }}
                                      className="text-xs font-semibold text-amber-600 hover:text-amber-700 transition-colors"
                                    >
                                      Counter-offer
                                    </button>
                                  )}
                                  <span className="text-xs font-semibold text-blue-600">Open case →</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {counterOfferCase && (
        <CounterOfferModal
          caseItem={counterOfferCase}
          onClose={() => setCounterOfferCase(null)}
          onDone={() => {
            setCounterOfferCase(null);
            const tid = localStorage.getItem("tenant_id") ?? "";
            if (tid) listCases(tid, "Underwriting").then(setCases).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

// ── Counter-offer modal — underwriter issues revised terms for customer sign-off ──
function CounterOfferModal({
  caseItem, onClose, onDone,
}: Readonly<{ caseItem: CaseQueueItem; onClose: () => void; onDone: () => void }>) {
  const [offerType, setOfferType] = useState<"Loading" | "Exclusion" | "ReducedSumAssured" | "PlanSubstitution">("Loading");
  const [loadingPct, setLoadingPct] = useState(25);
  const [revisedCoverage, setRevisedCoverage] = useState<number>(caseItem.coverage_amount ?? 0);
  const [revisedProduct, setRevisedProduct] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!caseItem.policy_id) return;
    setBusy(true); setErr(null);
    try {
      await createCounterOffer(caseItem.policy_id, {
        offer_type: offerType,
        reason: reason || undefined,
        created_by: "underwriter",
        revised_loading_pct: offerType === "Loading" ? loadingPct : undefined,
        revised_coverage_amount: offerType === "ReducedSumAssured" ? revisedCoverage : undefined,
        revised_product_name: offerType === "PlanSubstitution" ? revisedProduct : undefined,
        exclusions: offerType === "Exclusion" ? exclusions.split(",").map(s => s.trim()).filter(Boolean) : undefined,
      });
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to send counter-offer");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="bg-amber-500 px-5 py-3">
          <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">Revised Terms</p>
          <h2 className="text-white text-lg font-bold">Send Counter-Offer</h2>
          <p className="text-white/80 text-xs">{caseItem.customer_name} · {caseItem.product_name}</p>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Type</label>
            <select value={offerType} onChange={(e) => setOfferType(e.target.value as any)}
              className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2">
              <option value="Loading">Accept with Loading</option>
              <option value="Exclusion">Exclusion</option>
              <option value="ReducedSumAssured">Reduced Sum Assured</option>
              <option value="PlanSubstitution">Plan Substitution</option>
            </select>
          </div>
          {offerType === "Loading" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Premium loading %</label>
              <input type="number" value={loadingPct} onChange={(e) => setLoadingPct(Number(e.target.value))}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          {offerType === "ReducedSumAssured" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Revised sum assured (PKR)</label>
              <input type="number" value={revisedCoverage} onChange={(e) => setRevisedCoverage(Number(e.target.value))}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          {offerType === "PlanSubstitution" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Substitute product</label>
              <input value={revisedProduct} onChange={(e) => setRevisedProduct(e.target.value)} placeholder="e.g. Health Gold"
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          {offerType === "Exclusion" && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Exclusions (comma-separated)</label>
              <input value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder="e.g. Pre-existing cardiac conditions"
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
            </div>
          )}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Reason</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
              className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
            <button onClick={submit} disabled={busy}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-40">
              {busy ? "Sending…" : "Send counter-offer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
