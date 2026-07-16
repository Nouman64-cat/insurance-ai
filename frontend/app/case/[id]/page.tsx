import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { DecisionBanner, StatusBadge } from "@/components/StatusBadge";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { CASE_DETAILS, fmtCoverage, fmtDob, fmtIncome } from "@/lib/mock-data";

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const c = CASE_DETAILS[params.id];
  if (!c) return { title: "Case Not Found" };
  return { title: `${c.id} — ${c.applicantName}` };
}

export function generateStaticParams() {
  return Object.keys(CASE_DETAILS).map((id) => ({ id }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="data-row">
      <span className="data-key">{label}</span>
      <span className="data-val">{value}</span>
    </div>
  );
}

function SectionCard({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h3 className="section-label">{title}</h3>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function InitialsAvatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="w-14 h-14 rounded-xl bg-blue-700 flex items-center justify-center flex-shrink-0 shadow-sm">
      <span className="text-xl font-bold text-white">{initials}</span>
    </div>
  );
}

function ReasonGroup({
  label,
  score,
  scoreLabel,
  reasons,
  accentColor,
}: {
  label: string;
  score: number;
  scoreLabel: string;
  reasons: string[];
  accentColor: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold uppercase tracking-widest ${accentColor}`}>
          {label}
        </span>
        <span className="text-xs text-slate-400 font-mono">({scoreLabel})</span>
      </div>
      <ul className="space-y-1.5">
        {reasons.map((reason, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-slate-300 mt-0.5 flex-shrink-0">•</span>
            <span className="text-xs text-slate-600 leading-relaxed">{reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function CasePage({ params }: { params: { id: string } }) {
  const c = CASE_DETAILS[params.id];
  if (!c) notFound();

  const fraudPct = +(c.fraudProbability * 100).toFixed(1);

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-5">

      {/* ── Breadcrumb & case header ──────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href="/"
              className="text-xs text-slate-500 hover:text-blue-700 font-medium transition-colors"
            >
              ← Dashboard
            </Link>
            <span className="text-slate-300">/</span>
            <span className="text-xs text-slate-400">Queue</span>
            <span className="text-slate-300">/</span>
            <span className="text-xs text-slate-700 font-semibold">{c.id}</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
              {c.applicantName}
            </h1>
            <StatusBadge decision={c.aiDecision} size="lg" />
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Case {c.id} &nbsp;·&nbsp; Submitted {c.submittedAt} on 15 Jun 2026
            &nbsp;·&nbsp; {c.product} &nbsp;·&nbsp; {fmtCoverage(c.coverageAmount)} coverage
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
            Request Info
          </button>
          <button className="px-4 py-2 text-sm font-semibold text-red-700 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 transition-colors">
            Override: Decline
          </button>
          <button className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm">
            Override: Approve
          </button>
        </div>
      </div>

      {/* ── Main grid: 3 cols ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── LEFT COLUMN: Applicant + Policy ─────────────────────────────── */}
        <div className="lg:col-span-1 space-y-4">

          {/* Applicant card */}
          <div className="card p-5">
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-slate-100">
              <InitialsAvatar name={c.applicantName} />
              <div>
                <p className="font-bold text-slate-900 leading-tight">{c.applicantName}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {c.gender}, {c.age} years old
                </p>
                <p className="text-xs text-blue-600 font-mono mt-0.5">{c.cnic}</p>
              </div>
            </div>
            <p className="section-label mb-3">Applicant Details</p>
            <DataRow label="CNIC" value={<span className="font-mono text-sm">{c.cnic}</span>} />
            <DataRow label="Date of Birth" value={fmtDob(c.dob)} />
            <DataRow label="Gender" value={c.gender} />
            <DataRow label="Occupation" value={c.occupation} />
            <DataRow
              label="Declared Annual Income"
              value={fmtIncome(c.declaredIncome)}
            />
          </div>

          {/* Policy card */}
          <div className="card p-5">
            <p className="section-label mb-3">Policy Details</p>
            <DataRow label="Product" value={c.product} />
            <DataRow label="Coverage Amount" value={fmtCoverage(c.coverageAmount)} />
            <DataRow label="Policy Term" value={`${c.termYears} years`} />
            <DataRow
              label="Coverage-to-Income Ratio"
              value={`${(c.coverageAmount / c.declaredIncome).toFixed(1)}×`}
            />

            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="section-label mb-3">Submission</p>
              <DataRow label="Time" value={c.submittedAt} />
              <DataRow label="Date" value="15 June 2026" />
              <DataRow label="Channel" value="API Gateway (Digital)" />
            </div>
          </div>

          {/* Quick score summary */}
          <div className="card p-5">
            <p className="section-label mb-3">Score Summary</p>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">Medical Risk</span>
                <span className="font-bold text-slate-900">{c.medicalScore} / 100</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">Financial Risk</span>
                <span className="font-bold text-slate-900">{c.financialScore} / 100</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500">Fraud Probability</span>
                <span className="font-bold text-slate-900">{fraudPct}%</span>
              </div>
              <div className="h-px bg-slate-100 my-1" />
              <div className="flex justify-between items-center text-sm">
                <span className="font-semibold text-slate-700">Composite Score</span>
                <span className="font-extrabold text-slate-900">{c.compositeScore} / 100</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT COLUMN: Risk assessment + Recommendation ────────────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Risk Assessment Scores */}
          <SectionCard title="AI Risk Assessment">
            <div className="space-y-5">
              <RiskScoreBar
                label="Medical Risk Score"
                score={c.medicalScore}
              />
              <RiskScoreBar
                label="Financial Risk Score"
                score={c.financialScore}
              />
              <RiskScoreBar
                label="Fraud Probability"
                score={fraudPct}
                valueLabel={`${fraudPct}%`}
              />

              <div className="pt-2 border-t border-slate-100">
                <CompositeScoreRing score={c.compositeScore} />
              </div>
            </div>
          </SectionCard>

          {/* AI Recommendation */}
          <div className="card p-5 space-y-4">
            <p className="section-label">AI Recommendation</p>

            <DecisionBanner decision={c.aiDecision} />

            {/* Loading info */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <p className="text-xs text-slate-400 font-medium">Suggested Premium Loading</p>
                <p className="text-lg font-extrabold text-slate-900 mt-1">
                  {c.suggestedLoading != null && c.suggestedLoading > 0
                    ? `+${c.suggestedLoading}%`
                    : "N / A"}
                </p>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <p className="text-xs text-slate-400 font-medium">Decision Confidence</p>
                <p className="text-lg font-extrabold text-blue-700 mt-1">
                  {c.compositeScore <= 25 || c.compositeScore >= 76 ? "94.2%" : "81.6%"}
                </p>
              </div>
            </div>

            {/* Explainability report */}
            <div className="pt-2 border-t border-slate-100">
              <p className="section-label mb-4">Explainability Report</p>
              <div className="space-y-5">
                <ReasonGroup
                  label="Medical Risk Factors"
                  score={c.medicalScore}
                  scoreLabel={`${c.medicalScore}/100`}
                  reasons={c.medicalReasons}
                  accentColor="text-orange-700"
                />
                <ReasonGroup
                  label="Financial Risk Factors"
                  score={c.financialScore}
                  scoreLabel={`${c.financialScore}/100`}
                  reasons={c.financialReasons}
                  accentColor="text-blue-700"
                />
                <ReasonGroup
                  label="Fraud Assessment"
                  score={fraudPct}
                  scoreLabel={`${fraudPct}% probability`}
                  reasons={c.fraudReasons}
                  accentColor="text-violet-700"
                />
              </div>
            </div>
          </div>

          {/* Underwriter notes placeholder */}
          <div className="card p-5">
            <p className="section-label mb-3">Underwriter Notes</p>
            <textarea
              className="w-full h-24 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 resize-none placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              placeholder="Add case notes, override justification, or referral comments here…"
              readOnly
            />
            <div className="flex justify-end gap-2 mt-3">
              <button className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
                Save Draft
              </button>
              <button className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded-md hover:bg-blue-800 transition-colors">
                Submit Decision
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
