"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { SegmentDropdown, SegmentFilter, SEGMENT_LABEL, SEGMENT_BADGE_STYLE } from "@/components/SegmentDropdown";
import { fmtCoverage } from "@/lib/mock-data";
import { listCases, CaseQueueItem } from "@/app/services/cases";
import api from "@/app/services/api";

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

export default function ApplicationsPage() {
  const router = useRouter();
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (!tenantId) { setLoading(false); return; }
    listCases(tenantId, "Underwriting")
      .then(setCases)
      .catch((err) => setError(err.message ?? "Failed to load applications."))
      .finally(() => setLoading(false));
  }, []);

  const toggleFolder = (customerId: string) => {
    setExpandedCustomerId((prev) => (prev === customerId ? null : customerId));
  };

  const handleDownload = async (c: CaseQueueItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setError(null);
    setDownloadingId(c.caseld);
    try {
      const tenantId = localStorage.getItem("tenant_id") ?? "";
      if (!tenantId) return;
      const res = await api.get(`/tenants/${tenantId}/cases/${c.caseld}/detail`, {
        headers: { "X-Tenant-Id": tenantId },
      });
      const { generateApplicationPDF } = await import("@/lib/application-pdf");
      await generateApplicationPDF(res.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to generate application PDF.");
    } finally {
      setDownloadingId(null);
    }
  };

  // The dropdown-selected segment scopes which cases count toward the stats
  // and folder list; the search box then narrows within that scope.
  const segmentCases = useMemo(() => {
    if (segment === "all") return cases;
    return cases.filter((c) => (c.customer_segment ?? "individual") === segment);
  }, [cases, segment]);

  const segmentCounts = useMemo(() => {
    const counts: Partial<Record<SegmentFilter, number>> = { all: cases.length };
    for (const s of ["individual", "family", "organization"] as const) {
      counts[s] = cases.filter((c) => (c.customer_segment ?? "individual") === s).length;
    }
    return counts;
  }, [cases]);

  // Group cases into one folder per customer — same pattern as the Underwriting
  // and Quotations pages.
  const folders = useMemo<CustomerFolder[]>(() => {
    const q = search.trim().toLowerCase();
    const filteredList = q
      ? segmentCases.filter(
          (c) =>
            (c.customer_name ?? "").toLowerCase().includes(q) ||
            (c.customer_cnic ?? "").toLowerCase().includes(q) ||
            c.caseNumber.toLowerCase().includes(q),
        )
      : segmentCases;

    const grouped = new Map<string, CustomerFolder>();
    for (const c of filteredList) {
      if (!grouped.has(c.customer_id)) {
        grouped.set(c.customer_id, {
          customer_id: c.customer_id,
          customer_name: c.customer_name ?? "Unknown Customer",
          customer_cnic: c.customer_cnic ?? "—",
          customer_segment: c.customer_segment ?? "individual",
          cases: [],
        });
      }
      grouped.get(c.customer_id)!.cases.push(c);
    }
    return Array.from(grouped.values());
  }, [segmentCases, search]);

  const kpis = useMemo(() => {
    const ready = segmentCases.filter((c) => c.latest_ai_decision).length;
    const approved = segmentCases.filter((c) => c.caseStatus === "Approved").length;
    const customerCount = new Set(segmentCases.map((c) => c.customer_id)).size;
    return [
      { title: "Customers", value: customerCount, subtitle: "application folders", accent: "blue" as const },
      { title: "Ready to Generate", value: ready, subtitle: "underwriting complete", accent: "emerald" as const },
      { title: "Awaiting Underwriting", value: segmentCases.length - ready, subtitle: "not yet decided", accent: "amber" as const },
      { title: "Approved", value: approved, subtitle: "ready to issue", accent: "slate" as const },
    ];
  }, [segmentCases]);

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Applications</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          The final step after underwriting — grouped by customer, generate a complete application dossier (personal,
          plan, medical, occupational, financial &amp; underwriting result) as a downloadable PDF.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k) => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search by customer, CNIC, or case number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
        />
        <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
      </div>

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
              <span className="text-2xl">📄</span>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {cases.length === 0
                ? "No applications yet"
                : segmentCases.length === 0
                ? `No ${SEGMENT_LABEL[segment as "individual" | "family" | "organization"] ?? ""} applications`
                : "No applications match your search"}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {cases.length === 0
                ? "Applications appear here once a case is sent to underwriting."
                : segmentCases.length === 0
                ? "Try switching the segment filter to All Customers."
                : "Try a different customer name, CNIC, or case number."}
            </p>
          </div>
        ) : (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {folders.map((folder) => {
              const isExpanded = expandedCustomerId === folder.customer_id;
              const readyCount = folder.cases.filter((c) => c.latest_ai_decision).length;
              return (
                <div
                  key={folder.customer_id}
                  className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-200 ${isExpanded ? "col-span-full border-blue-200 shadow-md ring-1 ring-blue-500/20" : "border-slate-200 shadow-sm hover:shadow-md hover:border-blue-200 bg-white"}`}
                >
                  {/* Folder Header */}
                  <div
                    onClick={() => toggleFolder(folder.customer_id)}
                    className={`flex items-center justify-between p-5 cursor-pointer ${isExpanded ? "bg-blue-50/50" : "bg-white"}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${isExpanded ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"} transition-colors`}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {isExpanded ? (
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                          ) : (
                            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>
                          )}
                        </svg>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-bold text-slate-900">{folder.customer_name}</h3>
                          {segment === "all" && (
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wide ${SEGMENT_BADGE_STYLE[folder.customer_segment]}`}>
                              {SEGMENT_LABEL[folder.customer_segment]}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 font-mono mt-0.5">{folder.customer_cnic}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {!isExpanded && readyCount > 0 && (
                        <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700">
                          {readyCount} ready
                        </span>
                      )}
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${isExpanded ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                        {folder.cases.length} {folder.cases.length === 1 ? "Application" : "Applications"}
                      </span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-slate-400 transition-transform duration-200 ${isExpanded ? "rotate-180 text-blue-500" : ""}`}>
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-white overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                            <th className="px-5 py-3 text-left">Case</th>
                            <th className="px-5 py-3 text-left">Product</th>
                            <th className="px-5 py-3 text-right">Sum Assured</th>
                            <th className="px-5 py-3 text-left">Status</th>
                            <th className="px-5 py-3 text-left">AI Decision</th>
                            <th className="px-5 py-3 text-right">Application</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {folder.cases.map((c) => {
                            const ready = !!c.latest_ai_decision;
                            const busy = downloadingId === c.caseld;
                            return (
                              <tr key={c.caseld} className="hover:bg-slate-50 transition-colors">
                                <td className="px-5 py-3 font-mono text-xs text-slate-500 cursor-pointer" onClick={() => router.push(`/case/${c.caseld}`)}>{c.caseNumber}</td>
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
                                  {ready ? (
                                    <button
                                      onClick={(e) => handleDownload(c, e)}
                                      disabled={busy}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors shadow-sm"
                                    >
                                      {busy ? (
                                        <span className="animate-spin h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white" />
                                      ) : (
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
                                        </svg>
                                      )}
                                      {busy ? "Generating…" : "Download Application"}
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => router.push(`/case/${c.caseld}`)}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                                      title="Run AI underwriting on this case first"
                                    >
                                      Run underwriting →
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
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
    </div>
  );
}
