import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Active Alerts", value: "17", subtitle: "pending investigation", accent: "red" as const, trend: { value: "+3 today", direction: "up" as const } },
  { title: "Amount Blocked MTD", value: "PKR 8.7M", subtitle: "14 cases prevented", accent: "emerald" as const },
  { title: "Document Forgeries", value: "3", subtitle: "tampered files detected", accent: "amber" as const },
  { title: "Duplicate Claims", value: "4", subtitle: "cross-matched & rejected", accent: "blue" as const },
] as const;

const ROWS = [
  { ref: "FRD-2026-001", type: "Document Forgery", source: "MED-2026-B3", subject: "Tariq Butt", detail: "Edited PDF — altered lab values detected", score: 96, status: "Rejected", investigation: "Complete" },
  { ref: "FRD-2026-002", type: "Duplicate Claim", source: "CLM-2026-C2", subject: "Sara Khalid", detail: "Invoice matches CLM-2026-0089 submitted 14 Jun", score: 92, status: "Rejected", investigation: "Complete" },
  { ref: "FRD-2026-003", type: "Duplicate Claim", source: "RMB-2026-D2", subject: "Asma Tariq", detail: "Same admission ID submitted twice", score: 94, status: "Rejected", investigation: "Complete" },
  { ref: "FRD-2026-004", type: "Nominee Mismatch", source: "CLM-2026-E5", subject: "Estate of M. Zubair", detail: "Nominee name differs from policy records", score: 61, status: "Under Investigation", investigation: "In Progress" },
  { ref: "FRD-2026-005", type: "Forged Death Cert.", source: "CLM-2026-E6", subject: "Rehman Family Trust", detail: "Signature irregularities & font inconsistencies", score: 88, status: "Under Investigation", investigation: "In Progress" },
  { ref: "FRD-2026-006", type: "Early Claim", source: "CLM-2026-F2", subject: "Naeem Baig", detail: "Claim filed 18 days post policy issuance", score: 74, status: "Flagged", investigation: "Pending" },
  { ref: "FRD-2026-007", type: "Income Mismatch", source: "PRO-2026-A2", subject: "Bilal Hussain", detail: "Declared PKR 300K/m; Slip shows PKR 250K/m", score: 52, status: "Review Required", investigation: "Pending" },
];

const TYPE_STYLE: Record<string, string> = {
  "Document Forgery":   "bg-red-50 text-red-700",
  "Duplicate Claim":    "bg-orange-50 text-orange-700",
  "Nominee Mismatch":   "bg-amber-50 text-amber-700",
  "Forged Death Cert.": "bg-red-50 text-red-700",
  "Early Claim":        "bg-violet-50 text-violet-700",
  "Income Mismatch":    "bg-blue-50 text-blue-700",
};

const STATUS_STYLE: Record<string, string> = {
  Rejected:              "bg-red-50 text-red-700 border border-red-200",
  "Under Investigation": "bg-amber-50 text-amber-700 border border-amber-200",
  Flagged:               "bg-violet-50 text-violet-700 border border-violet-200",
  "Review Required":     "bg-blue-50 text-blue-700 border border-blue-200",
};

const INV_STYLE: Record<string, string> = {
  Complete:    "text-emerald-600 font-semibold",
  "In Progress":"text-amber-600 font-semibold",
  Pending:     "text-slate-400",
};

export default function FraudPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Fraud Detection</h1>
          <p className="text-sm text-slate-500 mt-0.5">AI-powered fraud intelligence across underwriting, claims, and reimbursements.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-red-600 text-white shadow">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> 5 Active Investigations
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Early Claim Detection", desc: "Claims within 30 days of issuance", count: "2 flagged", color: "border-violet-200 bg-violet-50" },
          { label: "Document Forgery", desc: "Tampered PDFs and altered values", count: "3 detected", color: "border-red-200 bg-red-50" },
          { label: "Duplicate Claims", desc: "Cross-matched submission history", count: "4 rejected", color: "border-orange-200 bg-orange-50" },
          { label: "Suspicious Patterns", desc: "Behavioral & network anomalies", count: "8 monitored", color: "border-amber-200 bg-amber-50" },
        ].map(c => (
          <div key={c.label} className={`rounded-xl border-2 p-4 ${c.color}`}>
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">{c.label}</p>
            <p className="text-2xl font-extrabold text-slate-800 mt-2">{c.count}</p>
            <p className="text-[11px] text-slate-500 mt-1">{c.desc}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">Fraud Alert Register</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Alert Ref</th>
                <th className="px-5 py-3 text-left">Type</th>
                <th className="px-5 py-3 text-left">Source</th>
                <th className="px-5 py-3 text-left">Subject</th>
                <th className="px-5 py-3 text-left">AI Finding</th>
                <th className="px-4 py-3 text-right">Fraud Score</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-left">Investigation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${TYPE_STYLE[r.type]}`}>{r.type}</span>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-blue-600">{r.source}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.subject}</td>
                  <td className="px-5 py-3 text-xs text-slate-500 max-w-xs truncate">{r.detail}</td>
                  <td className="px-4 py-3 text-right font-bold text-red-600">{r.score}%</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className={`px-5 py-3 text-xs ${INV_STYLE[r.investigation]}`}>{r.investigation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
