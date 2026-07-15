"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtCoverage } from "@/lib/mock-data";
import { listCases, CaseQueueItem } from "@/app/services/cases";

const CASE_STATUS_STYLE: Record<string, string> = {
  New: "bg-slate-100 text-slate-600 border-slate-200",
  InProgress: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  Closed: "bg-slate-200 text-slate-700 border-slate-300",
};

export default function UnderwritingPage() {
  const router = useRouter();
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (!tenantId) { setLoading(false); return; }
    listCases(tenantId, "Underwriting")
      .then(setCases)
      .catch(err => setError(err.message ?? "Failed to load underwriting cases."))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter(c =>
      (c.applicant_name ?? "").toLowerCase().includes(q) ||
      (c.applicant_cnic ?? "").toLowerCase().includes(q) ||
      c.caseNumber.toLowerCase().includes(q),
    );
  }, [cases, search]);

  const kpis = useMemo(() => {
    const pendingDocs = cases.filter(c => c.caseStatus === "Pending Documents").length;
    const underReview = cases.filter(c => c.caseStatus === "Under Review" || c.caseStatus === "New" || c.caseStatus === "InProgress").length;
    const approved = cases.filter(c => c.caseStatus === "Approved").length;
    return [
      { title: "Underwriting Cases", value: cases.length, subtitle: "open folders", accent: "blue" as const },
      { title: "Awaiting Documents", value: pendingDocs, subtitle: "checklist incomplete", accent: "amber" as const },
      { title: "In Underwriting", value: underReview, subtitle: "not yet decided", accent: "slate" as const },
      { title: "Approved", value: approved, subtitle: "ready to issue", accent: "emerald" as const },
    ];
  }, [cases]);

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Underwriting</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Every case opened once a quotation is proceeded — documents, AI risk scoring, and decision, all in one folder.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="flex items-center justify-between gap-3">
        <input
          type="text"
          placeholder="Search by applicant, CNIC, or case number…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">Underwriting Queue</p>
        </div>
        {loading ? (
          <div className="py-16 flex justify-center"><div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center px-6">
            <p className="text-sm font-semibold text-slate-600">
              {cases.length === 0 ? "No underwriting cases yet" : "No cases match your search"}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {cases.length === 0
                ? "A folder opens automatically the moment an applicant proceeds with a quotation."
                : "Try a different applicant name, CNIC, or case number."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Case</th>
                  <th className="px-5 py-3 text-left">Applicant</th>
                  <th className="px-5 py-3 text-left">Product</th>
                  <th className="px-5 py-3 text-right">Sum Assured</th>
                  <th className="px-5 py-3 text-left">Case Status</th>
                  <th className="px-5 py-3 text-left">AI Decision</th>
                  <th className="px-5 py-3 text-left" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map(c => (
                  <tr key={c.caseld} onClick={() => router.push(`/case/${c.caseld}`)} className="hover:bg-slate-50 cursor-pointer transition-colors">
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{c.caseNumber}</td>
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-800">{c.applicant_name ?? "Unknown"}</p>
                      <p className="text-xs text-slate-400">{c.applicant_cnic ?? "—"}</p>
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
                      <span className="text-xs font-semibold text-blue-600">Open folder →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
