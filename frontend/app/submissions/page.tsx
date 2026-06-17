import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Pending Submissions", value: "14", subtitle: "awaiting underwriter review", accent: "blue" as const, trend: { value: "+3 since yesterday", direction: "up" as const } },
  { title: "Individual Life", value: "9", subtitle: "standard proposals", accent: "slate" as const },
  { title: "Medical Cases", value: "2", subtitle: "high-risk referrals", accent: "amber" as const },
  { title: "Corporate", value: "3", subtitle: "group life submissions", accent: "emerald" as const },
] as const;

const ROWS = [
  { ref: "SUB-2026-0114", applicant: "Muhammad Ali Khan", product: "Term Life 20", assured: "PKR 10,000,000", submitted: "18 Jun · 08:14", priority: "Standard", status: "Awaiting Review" },
  { ref: "SUB-2026-0113", applicant: "Fatima Malik", product: "Whole Life", assured: "PKR 5,000,000", submitted: "18 Jun · 07:52", priority: "High", status: "Medical Required" },
  { ref: "SUB-2026-0112", applicant: "Acme Corporation Ltd.", product: "Group Life", assured: "PKR 25,000,000", submitted: "17 Jun · 23:11", priority: "Standard", status: "Awaiting Review" },
  { ref: "SUB-2026-0111", applicant: "Ahmed Raza", product: "Term Life 10", assured: "PKR 3,000,000", submitted: "17 Jun · 21:30", priority: "Standard", status: "Awaiting Review" },
  { ref: "SUB-2026-0110", applicant: "Sara Javed", product: "Endowment", assured: "PKR 2,000,000", submitted: "17 Jun · 19:45", priority: "Low", status: "Incomplete Docs" },
  { ref: "SUB-2026-0109", applicant: "Tariq Industries", product: "Group Life", assured: "PKR 12,000,000", submitted: "17 Jun · 17:00", priority: "High", status: "Awaiting Review" },
];

const STATUS_STYLE: Record<string, string> = {
  "Awaiting Review":  "bg-blue-50 text-blue-700 border border-blue-200",
  "Medical Required": "bg-amber-50 text-amber-700 border border-amber-200",
  "Incomplete Docs":  "bg-red-50 text-red-700 border border-red-200",
};

const PRIORITY_STYLE: Record<string, string> = {
  High:     "bg-red-50 text-red-600 border border-red-200",
  Standard: "bg-slate-100 text-slate-600 border border-slate-200",
  Low:      "bg-emerald-50 text-emerald-700 border border-emerald-200",
};

export default function SubmissionsPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Submissions</h1>
          <p className="text-sm text-slate-500 mt-0.5">New proposals and cases pending underwriter assignment and review.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-blue-600 text-white shadow">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> Live Queue
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Pending Queue</p>
          <p className="text-xs text-slate-400">Sorted by submission time · oldest first</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Reference</th>
                <th className="px-5 py-3 text-left">Applicant / Company</th>
                <th className="px-5 py-3 text-left">Product</th>
                <th className="px-5 py-3 text-right">Sum Assured</th>
                <th className="px-5 py-3 text-left">Submitted</th>
                <th className="px-5 py-3 text-left">Priority</th>
                <th className="px-5 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.applicant}</td>
                  <td className="px-5 py-3 text-slate-600">{r.product}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.assured}</td>
                  <td className="px-5 py-3 text-slate-500 text-xs">{r.submitted}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${PRIORITY_STYLE[r.priority]}`}>{r.priority}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
