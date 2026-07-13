"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listQuotes, QuoteListItem } from "../services/quotes";

// ── Constants ─────────────────────────────────────────────────────────────────

const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  GROUP_LIFE: "Group Life",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QuotePage() {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchQuotes = useCallback(async () => {
    setError(null);
    try {
      const data = await listQuotes();
      setQuotes(data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load quotations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuotes();
  }, [fetchQuotes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return quotes;
    return quotes.filter(
      (row) =>
        row.applicant_name.toLowerCase().includes(q) ||
        row.applicant_cnic.toLowerCase().includes(q) ||
        row.plan_label.toLowerCase().includes(q),
    );
  }, [quotes, search]);

  return (
    <div className="px-6 py-5 max-w-screen-2xl mx-auto w-full space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Quotations</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Generated automatically in the background the moment an applicant is registered — no form to fill in.
          </p>
        </div>
        <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold tracking-wide">
          GET /quotes
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <input
          type="text"
          placeholder="Search by applicant, CNIC, or plan…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
        />
        <button
          onClick={fetchQuotes}
          disabled={loading}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading quotations…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <span className="text-2xl">💰</span>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {quotes.length === 0 ? "No quotations yet" : "No quotations match your search"}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {quotes.length === 0
                ? "Register an applicant and a quotation will be generated automatically in the background."
                : "Try a different applicant name, CNIC, or plan."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Applicant</th>
                  <th className="px-5 py-3 text-left">Plan</th>
                  <th className="px-5 py-3 text-right">Coverage</th>
                  <th className="px-5 py-3 text-center">Term</th>
                  <th className="px-5 py-3 text-right">Base Premium</th>
                  <th className="px-5 py-3 text-right">Loading</th>
                  <th className="px-5 py-3 text-right">Total / Year</th>
                  <th className="px-5 py-3 text-left">Generated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((row) => (
                  <tr key={row.quote_id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5">
                      <p className="font-semibold text-slate-800">{row.applicant_name}</p>
                      <p className="text-xs text-slate-400">{row.applicant_cnic}</p>
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="text-slate-700">{row.plan_label}</p>
                      <span className="inline-flex mt-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                        {INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right font-medium text-slate-700">{formatPKR(row.coverage_amount)}</td>
                    <td className="px-5 py-3.5 text-center text-slate-600">{row.term_years}y</td>
                    <td className="px-5 py-3.5 text-right text-slate-600">{formatPKR(row.base_premium)}</td>
                    <td className="px-5 py-3.5 text-right text-slate-600">{formatPKR(row.loading_applied)}</td>
                    <td className="px-5 py-3.5 text-right font-bold text-slate-900">{formatPKR(row.total_premium)}</td>
                    <td className="px-5 py-3.5 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString()}
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
