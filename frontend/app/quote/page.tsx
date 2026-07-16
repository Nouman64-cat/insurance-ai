"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import api from "../services/api";
import { getQuote, listQuotes, QuoteDetail, QuoteListItem } from "../services/quotes";

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

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QuotePage() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const openQuote = useCallback(async (quoteId: string) => {
    setSelectedQuoteId(quoteId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const data = await getQuote(quoteId);
      setDetail(data);
    } catch (err: any) {
      setDetailError(err.message ?? "Failed to load quotation details.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeQuote = useCallback(() => {
    setSelectedQuoteId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

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
                  <th className="px-5 py-3 text-right">Expected Premium</th>
                  <th className="px-5 py-3 text-right">Risk</th>
                  <th className="px-5 py-3 text-right">Total payable</th>
                  <th className="px-5 py-3 text-left">Generated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((row) => (
                  <tr
                    key={row.quote_id}
                    onClick={() => openQuote(row.quote_id)}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                  >
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

      {selectedQuoteId && (
        <QuoteDetailModal
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={closeQuote}
          onStartUnderwriting={async () => {
            if (!detail) return;
            const tenantId = localStorage.getItem("tenant_id");
            if (!tenantId) return;
            const res = await api.post(`/tenants/${tenantId}/cases`, {
              applicant_id: detail.applicant_id,
              policy_id: detail.policy_id,
              caseType: "Underwriting",
              sourceChannel: "Online",
            });
            router.push(`/case/${res.data.caseld}`);
          }}
        />
      )}
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────────────

function QuoteDetailModal({
  detail, loading, error, onClose, onStartUnderwriting,
}: {
  detail: QuoteDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onStartUnderwriting: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await onStartUnderwriting();
    } catch (err: any) {
      setStartError(err.message ?? "Failed to start underwriting.");
      setStarting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-center overflow-y-auto py-10 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Quotation Details</p>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="py-16 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading details…</span>
          </div>
        )}

        {error && (
          <div className="p-5">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          </div>
        )}

        {detail && !loading && (
          <div className="p-5 space-y-5">
            {/* Quotation Statement */}
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-5 py-4 space-y-1.5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Quotation Statement</p>
                <span className="text-[10px] font-mono text-slate-400">Ref: {detail.quote_id.slice(0, 8).toUpperCase()}</span>
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">
                We are pleased to present the following insurance quotation for{" "}
                <span className="font-semibold text-slate-900">{detail.applicant_name}</span>. Based on the
                information provided, we propose a{" "}
                <span className="font-semibold text-slate-900">
                  {INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type}
                </span>{" "}
                policy under the{" "}
                <span className="font-semibold text-slate-900">{detail.plan_label}</span>{" "}
                plan, providing a sum assured of{" "}
                <span className="font-semibold text-slate-900">{formatPKR(detail.coverage_amount)}</span>{" "}
                over a term of{" "}
                <span className="font-semibold text-slate-900">{detail.term_years} years</span>.
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">
                The total annual premium for this coverage is{" "}
                <span className="font-bold text-slate-900">{formatPKR(detail.total_premium)}</span>{" "}
                (expected premium of {formatPKR(detail.base_premium)} plus a risk of{" "}
                {formatPKR(detail.loading_applied)}). This quotation is valid subject to
                satisfactory underwriting assessment and is generated as of{" "}
                <span className="font-medium text-slate-800">{formatDate(detail.created_at)}</span>.
              </p>
            </div>

            <p className="text-[11px] text-slate-500 mt-1 mb-2 text-center italic">
              Opens an Underwriting case for this applicant on this exact quote — documents, AI risk scoring, and the final decision all happen there.
            </p>

            {/* Headline */}
            <div>
              <h2 className="text-lg font-bold text-slate-900">{detail.applicant_name}</h2>
              <p className="text-xs text-slate-400">{detail.applicant_cnic}</p>
            </div>

            {/* Applicant */}
            <section>
              <SectionLabel>Applicant</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label="Date of Birth" value={`${formatDate(detail.applicant_dob)} (${detail.applicant_age} yrs)`} />
                <DetailField label="Gender" value={detail.applicant_gender} />
                <DetailField label="Occupation" value={detail.applicant_occupation} />
                <DetailField label="Annual Income" value={formatPKR(detail.applicant_declared_income)} />
                <DetailField label="Smoker" value={detail.applicant_is_smoker ? "Yes" : "No"} />
                <DetailField
                  label="Height / Weight"
                  value={`${detail.applicant_height_cm} cm / ${detail.applicant_weight_kg} kg${detail.applicant_bmi ? ` (BMI ${detail.applicant_bmi})` : ""}`}
                />
              </div>
            </section>

            {/* Policy */}
            <section>
              <SectionLabel>Policy</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label="Plan" value={detail.plan_label} />
                <DetailField label="Type" value={INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type} />
                <DetailField label="Coverage" value={formatPKR(detail.coverage_amount)} />
                <DetailField label="Term" value={`${detail.term_years} years`} />
                {detail.nominee_name && <DetailField label="Nominee" value={`${detail.nominee_name}${detail.nominee_relationship ? ` (${detail.nominee_relationship})` : ""}`} />}
                {detail.dependent_name && <DetailField label="Dependent" value={`${detail.dependent_name}${detail.dependent_dob ? ` — b. ${formatDate(detail.dependent_dob)}` : ""}`} />}
              </div>
            </section>

            {/* Premium breakdown */}
            <section>
              <SectionLabel>Premium Breakdown</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Expected Premium" value={formatPKR(detail.base_premium)} />
                <StatTile label="Risk" value={formatPKR(detail.loading_applied)} />
                <StatTile 
                  label="Total Payable" 
                  value={
                    <span>
                      {formatPKR(detail.total_premium)}{" "}
                      <span className="text-[10px] font-medium text-slate-300">(Premium + Risk)</span>
                    </span>
                  } 
                  highlight 
                />
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Rate version {detail.rate_version} · Generated {new Date(detail.created_at).toLocaleString()}
              </p>
            </section>

            {/* Proceed to underwriting */}
            <section className="pt-1 border-t border-slate-100">
              {startError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{startError}</p>
              )}
              <button
                onClick={handleStart}
                disabled={starting}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {starting ? (
                  <span className="animate-spin h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white" />
                ) : null}
                {starting ? "Opening case…" : "Proceed to Underwriting"}
              </button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">{children}</p>;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm text-slate-700 font-medium">{value}</p>
    </div>
  );
}

function StatTile({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-slate-900" : "bg-slate-50"}`}>
      <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${highlight ? "text-slate-300" : "text-slate-400"}`}>
        {label}
      </p>
      <p className={`text-sm font-bold ${highlight ? "text-white" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}
