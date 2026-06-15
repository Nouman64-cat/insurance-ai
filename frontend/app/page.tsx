import Link from "next/link";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import {
  DECISION_DISTRIBUTION,
  METRICS,
  QUEUE_CASES,
  fmtCoverage,
  type QueueCase,
} from "@/lib/mock-data";

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components (colocated — small enough not to warrant their own files)
// ─────────────────────────────────────────────────────────────────────────────

function MiniRiskBar({ score }: { score: number }) {
  const color =
    score <= 25 ? "bg-emerald-500" :
    score <= 50 ? "bg-amber-400"   :
    score <= 75 ? "bg-orange-500"  :
                  "bg-red-600";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-semibold text-slate-700 tabular-nums">{score}</span>
    </div>
  );
}

function DistributionBar({
  label,
  count,
  pct,
  colorBar,
  colorText,
}: (typeof DECISION_DISTRIBUTION)[number]) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 text-xs text-slate-600 font-medium truncate flex-shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorBar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-8 text-xs font-bold tabular-nums text-right ${colorText}`}>{pct}%</span>
      <span className="w-8 text-xs text-slate-400 tabular-nums text-right">{count}</span>
    </div>
  );
}

function QueueRow({ c }: { c: QueueCase }) {
  return (
    <tr className="hover:bg-blue-50/40 transition-colors group">
      <td className="px-4 py-3 whitespace-nowrap">
        <Link
          href={`/case/${c.id}`}
          className="text-sm font-mono font-semibold text-blue-700 hover:text-blue-900 hover:underline"
        >
          {c.id}
        </Link>
      </td>
      <td className="px-4 py-3">
        <p className="text-sm font-semibold text-slate-900 whitespace-nowrap">{c.applicantName}</p>
        <p className="text-xs text-slate-400 mt-0.5">{c.cnic}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="text-sm text-slate-700">{c.product}</p>
        <p className="text-xs text-slate-400 mt-0.5">{c.termYears} yr term</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="text-sm font-semibold text-slate-900">{fmtCoverage(c.coverageAmount)}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="text-xs text-slate-500">{c.submittedAt}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <MiniRiskBar score={c.compositeScore} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <StatusBadge decision={c.aiDecision} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right">
        {c.suggestedLoading != null && c.suggestedLoading > 0 && (
          <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            +{c.suggestedLoading}% loading
          </span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right">
        <Link
          href={`/case/${c.id}`}
          className="text-xs font-semibold text-blue-700 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md px-3 py-1.5 transition-colors"
        >
          Review →
        </Link>
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Underwriting Command Centre
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {today} &nbsp;·&nbsp; {METRICS.pending} cases awaiting your review
          </p>
        </div>
        <div className="flex-shrink-0 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            AI Engine Online
          </span>
          <button className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm">
            New Application
          </button>
        </div>
      </div>

      {/* ── Metric cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Pending Review"
          value={METRICS.pending}
          subtitle="cases in queue"
          accent="amber"
          trend={{ value: "+3 since 9 AM", direction: "up" }}
        />
        <MetricCard
          title="Auto-Approved"
          value={METRICS.autoApproved}
          subtitle={`${Math.round((METRICS.autoApproved / METRICS.totalToday) * 100)}% of total`}
          accent="emerald"
          trend={{ value: "+14% vs yesterday", direction: "up" }}
        />
        <MetricCard
          title="Referred to Human"
          value={METRICS.referred}
          subtitle="require manual review"
          accent="blue"
          trend={{ value: "−8% vs yesterday", direction: "down" }}
        />
        <MetricCard
          title="Declined"
          value={METRICS.declined}
          subtitle={`${Math.round((METRICS.declined / METRICS.totalToday) * 100)}% decline rate`}
          accent="red"
          trend={{ value: "within normal range", direction: "neutral" }}
        />
      </div>

      {/* ── Analytics row ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* AI Decision Distribution */}
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="section-label">AI Decision Distribution</p>
              <p className="text-lg font-bold text-slate-900 mt-0.5">
                {METRICS.processed} / {METRICS.totalToday}
                <span className="text-sm font-normal text-slate-500 ml-2">processed today</span>
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400">Auto-decision rate</p>
              <p className="text-xl font-extrabold text-blue-700">{METRICS.autoDecisionRate}%</p>
            </div>
          </div>
          <div className="space-y-3">
            {DECISION_DISTRIBUTION.map((d) => (
              <DistributionBar key={d.label} {...d} />
            ))}
          </div>
        </div>

        {/* System performance */}
        <div className="card p-5">
          <p className="section-label mb-4">System Performance</p>
          <div className="space-y-4">
            {[
              {
                label: "Avg. Processing Time",
                value: `${METRICS.avgProcessingSeconds}s`,
                sub: "per application",
                accent: "text-emerald-700",
              },
              {
                label: "AI Confidence (avg)",
                value: `${METRICS.avgConfidence}%`,
                sub: "decision confidence score",
                accent: "text-blue-700",
              },
              {
                label: "Cases Processed",
                value: `${METRICS.processed} / ${METRICS.totalToday}`,
                sub: "today's total",
                accent: "text-slate-900",
              },
              {
                label: "Approve with Loading",
                value: METRICS.approvedWithLoading,
                sub: "premium adjustments issued",
                accent: "text-amber-700",
              },
            ].map(({ label, value, sub, accent }) => (
              <div key={label} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                <div>
                  <p className="text-xs text-slate-500 font-medium">{label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
                </div>
                <span className={`text-lg font-extrabold tabular-nums ${accent}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Today's Queue ─────────────────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">Today&apos;s Underwriting Queue</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {QUEUE_CASES.length} cases shown &nbsp;·&nbsp; Sorted by risk score (descending)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              Filter ▾
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              Export
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {[
                  "Case ID",
                  "Applicant",
                  "Product",
                  "Coverage",
                  "Submitted",
                  "Risk Score",
                  "AI Decision",
                  "Loading",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-xs font-semibold uppercase tracking-widest text-slate-400 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {QUEUE_CASES.map((c) => (
                <QueueRow key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50/60">
          <p className="text-xs text-slate-400">
            Showing {QUEUE_CASES.length} of {METRICS.pending} pending cases
          </p>
          <div className="flex items-center gap-1">
            {["1", "2", "3"].map((p) => (
              <button
                key={p}
                className={`w-7 h-7 rounded text-xs font-semibold transition-colors ${
                  p === "1"
                    ? "bg-blue-700 text-white"
                    : "text-slate-500 hover:bg-slate-100"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}
