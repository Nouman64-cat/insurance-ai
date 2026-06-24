"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import api from "@/app/services/api";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { StatusBadge } from "@/components/StatusBadge";
import type { AIDecision } from "@/lib/mock-data";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AssessmentSummary {
  id: string;
  applicant_id: string;
  applicant_name: string;
  applicant_cnic: string;
  case_id: string | null;
  medical_score: number;
  financial_score: number;
  fraud_probability: number;
  composite_risk_score: number | null;
  ai_decision: AIDecision;
  suggested_loading: number | null;
  has_summary: boolean;
  created_at: string;
}

interface AssessmentDetail extends AssessmentSummary {
  reasons: string[];
  ai_summary: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" })
    + " · " + d.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
}

function decisionColor(d: AIDecision) {
  if (d === "Auto Approve") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (d === "Approve with Loading") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  if (d === "Human Review") return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  return "bg-red-500/15 text-red-400 border-red-500/30";
}

function decisionLabel(d: AIDecision) {
  if (d === "Auto Approve") return "Approved";
  if (d === "Approve with Loading") return "Approved +L";
  if (d === "Human Review") return "Referred";
  return "Declined";
}

function compositeColor(score: number) {
  if (score <= 40) return "text-emerald-400";
  if (score <= 65) return "text-amber-400";
  return "text-red-400";
}

// ── Markdown components ───────────────────────────────────────────────────────

const MD: Record<string, React.ComponentType<React.HTMLAttributes<HTMLElement>>> = {
  h2: ({ children, ...p }) => <h2 {...p} className="text-sm font-semibold text-slate-200 mt-4 mb-1">{children}</h2>,
  h3: ({ children, ...p }) => <h3 {...p} className="text-xs font-semibold text-slate-300 mt-3 mb-1">{children}</h3>,
  p:  ({ children, ...p }) => <p  {...p} className="text-xs text-slate-400 leading-relaxed mb-2">{children}</p>,
  ul: ({ children, ...p }) => <ul {...p} className="list-disc list-inside space-y-0.5 mb-2">{children}</ul>,
  li: ({ children, ...p }) => <li {...p} className="text-xs text-slate-400">{children}</li>,
  strong: ({ children, ...p }) => <strong {...p} className="font-semibold text-slate-200">{children}</strong>,
  hr: ({ ...p }) => <hr {...p} className="border-slate-700 my-3" />,
  code: ({ children, ...p }) => <code {...p} className="bg-slate-800 text-blue-300 text-[10px] px-1 py-0.5 rounded">{children}</code>,
};

// ── Slide-out detail panel ────────────────────────────────────────────────────

function DetailPanel({
  item,
  tenantId,
  onClose,
}: {
  item: AssessmentSummary;
  tenantId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    api
      .get(`/assessments/${item.id}`, { headers: { "X-Tenant-Id": tenantId } })
      .then((r) => setDetail(r.data as AssessmentDetail))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [item.id, tenantId]);

  const decision: AIDecision = detail?.ai_decision ?? item.ai_decision;
  const composite = detail?.composite_risk_score ?? item.composite_risk_score;

  const downloadPDF = async () => {
    if (!detail) return;
    const { default: jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = 210, mg = 14, cw = W - mg * 2;
    let y = mg;

    const row = (label: string, value: string, offset = 0) => {
      doc.setFontSize(7).setTextColor(150, 160, 175);
      doc.text(label.toUpperCase(), mg + offset, y);
      doc.setFontSize(9).setTextColor(30, 40, 55);
      doc.text(value, mg + offset + 28, y);
      y += 6;
    };

    // Header band
    doc.setFillColor(15, 23, 42).rect(0, 0, W, 28, "F");
    doc.setFontSize(13).setTextColor(255, 255, 255);
    doc.text("Risk Assessment Report", mg, 12);
    doc.setFontSize(8).setTextColor(148, 163, 184);
    doc.text(`Generated ${new Date().toLocaleDateString("en-PK", { day: "2-digit", month: "long", year: "numeric" })}`, mg, 20);
    y = 36;

    // Applicant block
    doc.setFontSize(10).setTextColor(15, 23, 42);
    doc.text("Applicant Information", mg, y); y += 7;
    row("Name", detail.applicant_name);
    row("CNIC", detail.applicant_cnic);
    if (detail.case_id) row("Case ID", detail.case_id);
    row("Assessed", fmt(detail.created_at));
    y += 3;

    // Decision band
    const bandColor: [number, number, number] =
      decision === "Auto Approve" ? [16, 185, 129]
      : decision === "Approve with Loading" ? [245, 158, 11]
      : decision === "Human Review" ? [59, 130, 246]
      : [239, 68, 68];
    doc.setFillColor(...bandColor).rect(mg, y, cw, 10, "F");
    doc.setFontSize(10).setTextColor(255, 255, 255);
    doc.text(`Decision: ${decision}`, mg + 4, y + 6.5);
    if (composite !== null) doc.text(`Composite Risk Score: ${composite} / 100`, mg + 80, y + 6.5);
    y += 16;

    // Scores
    doc.setFontSize(10).setTextColor(15, 23, 42);
    doc.text("Risk Scores", mg, y); y += 7;
    const scores = [
      ["Medical Score", String(detail.medical_score)],
      ["Financial Score", String(detail.financial_score)],
      ["Fraud Probability", `${Math.round(detail.fraud_probability * 100)}%`],
    ];
    if (detail.suggested_loading != null) scores.push(["Suggested Loading", `${detail.suggested_loading}%`]);
    scores.forEach(([l, v]) => row(l, v));
    y += 4;

    // Reasons
    if (detail.reasons.length > 0) {
      doc.setFontSize(10).setTextColor(15, 23, 42);
      doc.text("Assessment Reasons", mg, y); y += 7;
      doc.setFontSize(8.5).setTextColor(55, 65, 81);
      detail.reasons.forEach((r) => {
        const lines = doc.splitTextToSize(`• ${r}`, cw - 4);
        if (y + lines.length * 5 > 280) { doc.addPage(); y = mg; }
        doc.text(lines, mg + 2, y);
        y += lines.length * 5 + 1;
      });
      y += 4;
    }

    // AI Summary
    if (detail.ai_summary) {
      if (y + 20 > 280) { doc.addPage(); y = mg; }
      doc.setFontSize(10).setTextColor(15, 23, 42);
      doc.text("AI Case Summary", mg, y); y += 7;
      doc.setFontSize(8.5).setTextColor(55, 65, 81);
      const plain = detail.ai_summary.replace(/[#*`_~>\-]/g, "").replace(/\n{3,}/g, "\n\n");
      const lines = doc.splitTextToSize(plain, cw - 2);
      for (let i = 0; i < lines.length; i++) {
        if (y + 5 > 280) { doc.addPage(); y = mg; }
        doc.text(lines[i], mg, y);
        y += 5;
      }
    }

    // Footer on every page
    const total = (doc as unknown as { internal: { getNumberOfPages(): number } }).internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFontSize(7).setTextColor(150, 160, 175);
      doc.text("insurance-ai · Confidential", mg, 292);
      doc.text(`Page ${p} of ${total}`, W - mg - 18, 292);
    }

    doc.save(`assessment_${detail.applicant_cnic}_${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-slate-900 border-l border-slate-800 flex flex-col z-50 shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between p-5 border-b border-slate-800 flex-shrink-0">
        <div>
          <p className="text-base font-semibold text-slate-100">{item.applicant_name}</p>
          <p className="text-xs text-slate-500 mt-0.5">CNIC {item.applicant_cnic}</p>
          <p className="text-[10px] text-slate-600 mt-1">{fmt(item.created_at)}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <svg className="w-5 h-5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          </div>
        ) : !detail ? (
          <p className="text-xs text-slate-500 text-center py-10">Failed to load assessment details.</p>
        ) : (
          <>
            {/* Decision + composite */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-slate-800/60 border border-slate-700/50">
              {composite !== null && <CompositeScoreRing score={composite} />}
              <div className="flex-1 space-y-2">
                <StatusBadge decision={decision} size="lg" />
                {detail.suggested_loading != null && (
                  <p className="text-xs text-slate-400">
                    Suggested loading: <span className="text-amber-400 font-semibold">+{detail.suggested_loading}%</span>
                  </p>
                )}
                {detail.case_id && (
                  <p className="text-[10px] text-slate-500">
                    Linked to case <span className="font-mono text-slate-400">{detail.case_id.slice(0, 8)}…</span>
                  </p>
                )}
              </div>
            </div>

            {/* Score bars */}
            <div className="space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Scores</p>
              <RiskScoreBar label="Medical Score" score={detail.medical_score} />
              <RiskScoreBar label="Financial Score" score={detail.financial_score} />
              <RiskScoreBar
                label="Fraud Probability"
                score={Math.round(detail.fraud_probability * 100)}
                valueLabel={`${Math.round(detail.fraud_probability * 100)}%`}
              />
            </div>

            {/* Reasons */}
            {detail.reasons.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-2">Assessment Reasons</p>
                <ul className="space-y-1.5">
                  {detail.reasons.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
                      <span className="mt-0.5 w-1 h-1 rounded-full bg-blue-500 flex-shrink-0" />
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* AI Summary */}
            {detail.ai_summary ? (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-2">AI Case Summary</p>
                <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 prose-sm max-w-none">
                  <ReactMarkdown components={MD as Record<string, React.ComponentType>}>
                    {detail.ai_summary}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-700/30 bg-slate-800/20 p-4 text-center">
                <p className="text-xs text-slate-600">No AI summary — this assessment was run without case documents.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      {detail && (
        <div className="flex-shrink-0 p-4 border-t border-slate-800">
          <button
            onClick={downloadPDF}
            className="w-full flex items-center justify-center gap-2 border border-dashed border-slate-600 hover:border-blue-500 text-slate-400 hover:text-blue-400 text-xs font-medium py-2.5 px-4 rounded-lg transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
            </svg>
            Download PDF Report
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const DECISION_FILTERS = ["All", "Auto Approve", "Approve with Loading", "Human Review", "Decline"] as const;
type Filter = (typeof DECISION_FILTERS)[number];

export default function AssessmentHistoryPage() {
  const [tenantId, setTenantId] = useState("");
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AssessmentSummary | null>(null);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const LIMIT = 50;

  useEffect(() => {
    const id = localStorage.getItem("tenant_id") ?? "";
    setTenantId(id);
  }, []);

  const load = useCallback(async (reset = false) => {
    if (!tenantId) return;
    const offset = reset ? 0 : skip;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/assessments?skip=${offset}&limit=${LIMIT}`, {
        headers: { "X-Tenant-Id": tenantId },
      });
      const data = res.data as AssessmentSummary[];
      setAssessments((prev) => (reset ? data : [...prev, ...data]));
      setSkip(offset + data.length);
      setHasMore(data.length === LIMIT);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load assessments.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, skip]);

  useEffect(() => {
    if (tenantId) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const visible = assessments.filter((a) => {
    if (filter !== "All" && a.ai_decision !== (filter as AIDecision)) return false;
    if (search) {
      const q = search.toLowerCase();
      return a.applicant_name.toLowerCase().includes(q) || a.applicant_cnic.includes(q);
    }
    return true;
  });

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-950">
      {/* Page header */}
      <div className="border-b border-slate-800 px-6 py-4 flex-shrink-0">
        <h1 className="text-lg font-semibold text-slate-100">Assessment History</h1>
        <p className="text-xs text-slate-500 mt-0.5">All stored risk evaluations for this tenant</p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-slate-800 flex-shrink-0 flex-wrap">
        {/* Decision filter */}
        <div className="flex gap-1">
          {DECISION_FILTERS.map((f) => {
            const label = f === "All" ? "All" : f === "Auto Approve" ? "Approved" : f === "Approve with Loading" ? "Approved +L" : f === "Human Review" ? "Referred" : "Declined";
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors ${
                  filter === f
                    ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative ml-auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search name or CNIC…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500 w-52"
          />
        </div>

        <button
          onClick={() => { setSkip(0); load(true); }}
          disabled={loading}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}>
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto relative">
        {error && (
          <div className="m-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>
        )}

        {!error && visible.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-600">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10 mb-3 opacity-40">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-sm">No assessments found</p>
            <p className="text-xs mt-1 opacity-60">Run an evaluation from Live Evaluation or Case Summarizer</p>
          </div>
        )}

        {visible.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-800 z-10">
              <tr>
                <th className="text-left px-6 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Applicant</th>
                <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Decision</th>
                <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Composite</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Med</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Fin</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Fraud</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Summary</th>
                <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-600">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {visible.map((a) => {
                const isSelected = selected?.id === a.id;
                return (
                  <tr
                    key={a.id}
                    onClick={() => setSelected(isSelected ? null : a)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-blue-600/10 border-l-2 border-blue-500"
                        : "hover:bg-slate-800/40"
                    }`}
                  >
                    {/* Applicant */}
                    <td className="px-6 py-3.5">
                      <p className="font-medium text-slate-200">{a.applicant_name}</p>
                      <p className="text-[10px] text-slate-600 mt-0.5 font-mono">{a.applicant_cnic}</p>
                    </td>

                    {/* Decision badge */}
                    <td className="px-4 py-3.5">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${decisionColor(a.ai_decision)}`}>
                        {decisionLabel(a.ai_decision)}
                      </span>
                    </td>

                    {/* Composite score mini-bar */}
                    <td className="px-4 py-3.5 w-32">
                      {a.composite_risk_score !== null ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                a.composite_risk_score <= 40
                                  ? "bg-emerald-500"
                                  : a.composite_risk_score <= 65
                                  ? "bg-amber-500"
                                  : "bg-red-500"
                              }`}
                              style={{ width: `${a.composite_risk_score}%` }}
                            />
                          </div>
                          <span className={`font-semibold tabular-nums w-6 text-right ${compositeColor(a.composite_risk_score)}`}>
                            {a.composite_risk_score}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>

                    {/* Medical */}
                    <td className="px-4 py-3.5 text-center">
                      <span className={`font-semibold tabular-nums ${
                        a.medical_score >= 70 ? "text-red-400" : a.medical_score >= 40 ? "text-amber-400" : "text-emerald-400"
                      }`}>{a.medical_score}</span>
                    </td>

                    {/* Financial */}
                    <td className="px-4 py-3.5 text-center">
                      <span className={`font-semibold tabular-nums ${
                        a.financial_score >= 70 ? "text-red-400" : a.financial_score >= 40 ? "text-amber-400" : "text-emerald-400"
                      }`}>{a.financial_score}</span>
                    </td>

                    {/* Fraud */}
                    <td className="px-4 py-3.5 text-center">
                      <span className={`font-semibold tabular-nums ${
                        a.fraud_probability >= 0.5 ? "text-red-400" : a.fraud_probability >= 0.25 ? "text-amber-400" : "text-emerald-400"
                      }`}>{Math.round(a.fraud_probability * 100)}%</span>
                    </td>

                    {/* Has AI summary */}
                    <td className="px-4 py-3.5 text-center">
                      {a.has_summary ? (
                        <span title="Has AI summary" className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500/20 text-blue-400">
                          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
                        </span>
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                    </td>

                    {/* Date */}
                    <td className="px-6 py-3.5 text-right text-slate-500 whitespace-nowrap">
                      {fmt(a.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Load more */}
        {hasMore && !loading && visible.length > 0 && (
          <div className="flex justify-center py-6">
            <button
              onClick={() => load(false)}
              className="text-xs text-slate-500 hover:text-slate-300 border border-slate-700 hover:border-slate-600 px-5 py-2 rounded-lg transition-colors"
            >
              Load more
            </button>
          </div>
        )}

        {loading && assessments.length === 0 && (
          <div className="flex items-center justify-center h-64">
            <svg className="w-5 h-5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          </div>
        )}
      </div>

      {/* Slide-out */}
      {selected && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setSelected(null)} />
          <DetailPanel item={selected} tenantId={tenantId} onClose={() => setSelected(null)} />
        </>
      )}
    </div>
  );
}
