import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Total Cases", value: "127", subtitle: "all types combined", accent: "blue" as const },
  { title: "Open", value: "47", subtitle: "active underwriting", accent: "amber" as const },
  { title: "Closed", value: "73", subtitle: "decisions issued", accent: "emerald" as const },
  { title: "Escalated", value: "7", subtitle: "senior review required", accent: "red" as const },
] as const;

const ROWS = [
  { ref: "CASE-2026-0127", type: "Individual Life", applicant: "Muhammad Ali Khan", product: "Term Life 20", assured: "PKR 10,000,000", aiScore: 93.75, status: "Approved", assignee: "S. Reviewer", updated: "Today 09:12" },
  { ref: "CASE-2026-0126", type: "Medical", applicant: "Khalid Mehmood", product: "Whole Life", assured: "PKR 20,000,000", aiScore: 70.0, status: "Under Review", assignee: "M. Underwriter", updated: "Today 08:45" },
  { ref: "CASE-2026-0125", type: "Corporate", applicant: "Adamjee Industries", product: "Group Life", assured: "PKR 25,000,000", aiScore: 91.0, status: "Approved", assignee: "A. Khan", updated: "Today 08:20" },
  { ref: "CASE-2026-0124", type: "Individual Life", applicant: "Ayesha Noor", product: "Whole Life", assured: "PKR 15,000,000", aiScore: 40.0, status: "Re-submission", assignee: "S. Reviewer", updated: "Yesterday" },
  { ref: "CASE-2026-0123", type: "Medical", applicant: "Tariq Butt", product: "Whole Life", assured: "PKR 8,000,000", aiScore: 20.0, status: "Fraud Alert", assignee: "Fraud Team", updated: "Yesterday" },
  { ref: "CASE-2026-0122", type: "Corporate", applicant: "National Textile Group", product: "Group Life", assured: "PKR 18,000,000", aiScore: 80.0, status: "Under Review", assignee: "M. Underwriter", updated: "Yesterday" },
  { ref: "CASE-2026-0121", type: "Individual Life", applicant: "Sana Rizvi", product: "Term Life 10", assured: "PKR 4,000,000", aiScore: 91.2, status: "Approved", assignee: "S. Reviewer", updated: "17 Jun" },
  { ref: "CASE-2026-0120", type: "Medical", applicant: "Nadia Iqbal", product: "Term Life 15", assured: "PKR 12,000,000", aiScore: 60.0, status: "Docs Expired", assignee: "A. Khan", updated: "17 Jun" },
];

const TYPE_STYLE: Record<string, string> = {
  "Individual Life": "bg-blue-50 text-blue-700",
  Medical:           "bg-violet-50 text-violet-700",
  Corporate:         "bg-emerald-50 text-emerald-700",
};

const STATUS_STYLE: Record<string, string> = {
  Approved:        "bg-emerald-50 text-emerald-700 border border-emerald-200",
  "Under Review":  "bg-blue-50 text-blue-700 border border-blue-200",
  "Re-submission": "bg-amber-50 text-amber-700 border border-amber-200",
  "Fraud Alert":   "bg-red-50 text-red-700 border border-red-200",
  "Docs Expired":  "bg-slate-100 text-slate-600 border border-slate-200",
};

function ScoreBar({ score }: { score: number }) {
  const color = score >= 90 ? "bg-emerald-500" : score >= 65 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700">{score}</span>
    </div>
  );
}

export default function CasesPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Cases</h1>
        <p className="text-sm text-slate-500 mt-0.5">All underwriting cases across individual life, medical, and corporate portfolios.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-4">
          <p className="text-sm font-semibold text-slate-700">All Cases</p>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-semibold">Individual Life</span>
            <span className="px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 font-semibold">Medical</span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-semibold">Corporate</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Case Ref</th>
                <th className="px-5 py-3 text-left">Type</th>
                <th className="px-5 py-3 text-left">Applicant</th>
                <th className="px-5 py-3 text-right">Sum Assured</th>
                <th className="px-5 py-3 text-left">AI Score</th>
                <th className="px-5 py-3 text-left">Assignee</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-left">Last Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${TYPE_STYLE[r.type]}`}>{r.type}</span>
                  </td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.applicant}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.assured}</td>
                  <td className="px-5 py-3"><ScoreBar score={r.aiScore} /></td>
                  <td className="px-5 py-3 text-slate-500 text-xs">{r.assignee}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-400">{r.updated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
