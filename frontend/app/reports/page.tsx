import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Reports Generated MTD", value: "48", subtitle: "across all modules", accent: "blue" as const },
  { title: "Scheduled Reports", value: "12", subtitle: "daily & weekly auto-runs", accent: "slate" as const },
  { title: "Pending Exports", value: "3", subtitle: "queued for download", accent: "amber" as const },
  { title: "Last Generated", value: "Today 06:00", subtitle: "daily portfolio summary", accent: "emerald" as const },
] as const;

const REPORTS = [
  { name: "Daily Underwriting Summary", module: "Underwriting", frequency: "Daily · 06:00", format: "PDF + XLSX", lastRun: "Today 06:00", status: "Ready", size: "1.2 MB" },
  { name: "Fraud Detection Weekly Digest", module: "Fraud", frequency: "Weekly · Monday", format: "PDF", lastRun: "16 Jun 2026", status: "Ready", size: "0.8 MB" },
  { name: "Agent Commission Statement", module: "Agents", frequency: "Monthly", format: "XLSX", lastRun: "01 Jun 2026", status: "Ready", size: "2.4 MB" },
  { name: "Claims Register MTD", module: "Claims", frequency: "Monthly", format: "PDF + XLSX", lastRun: "01 Jun 2026", status: "Ready", size: "1.8 MB" },
  { name: "AI Score Engine Audit Log", module: "Score Engine", frequency: "Daily · 00:00", format: "CSV", lastRun: "Today 00:00", status: "Ready", size: "3.1 MB" },
  { name: "Portfolio Risk Analysis", module: "Financial", frequency: "Weekly · Friday", format: "PDF", lastRun: "13 Jun 2026", status: "Ready", size: "1.5 MB" },
  { name: "Corporate Census Validation", module: "Corporate", frequency: "On Demand", format: "XLSX", lastRun: "15 Jun 2026", status: "Ready", size: "0.6 MB" },
  { name: "Reimbursement Register", module: "Reimbursements", frequency: "Monthly", format: "PDF + XLSX", lastRun: "01 Jun 2026", status: "Ready", size: "0.9 MB" },
  { name: "Medical Loading Summary", module: "Medical", frequency: "Monthly", format: "PDF", lastRun: "01 Jun 2026", status: "Processing", size: "—" },
  { name: "Regulatory Compliance Report", module: "Admin", frequency: "Quarterly", format: "PDF", lastRun: "01 Apr 2026", status: "Ready", size: "4.2 MB" },
];

const MODULE_STYLE: Record<string, string> = {
  Underwriting: "bg-blue-50 text-blue-700",
  Fraud:        "bg-red-50 text-red-700",
  Agents:       "bg-violet-50 text-violet-700",
  Claims:       "bg-emerald-50 text-emerald-700",
  "Score Engine":"bg-slate-100 text-slate-600",
  Financial:    "bg-amber-50 text-amber-700",
  Corporate:    "bg-teal-50 text-teal-700",
  Reimbursements:"bg-orange-50 text-orange-700",
  Medical:      "bg-pink-50 text-pink-700",
  Admin:        "bg-slate-100 text-slate-600",
};

const STATUS_STYLE: Record<string, string> = {
  Ready:      "bg-emerald-50 text-emerald-700 border border-emerald-200",
  Processing: "bg-blue-50 text-blue-700 border border-blue-200",
};

export default function ReportsPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Reports</h1>
        <p className="text-sm text-slate-500 mt-0.5">Scheduled and on-demand reports across all underwriting modules — download or schedule for automated delivery.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Report Library</p>
          <span className="text-xs text-slate-400">10 reports across 8 modules</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Report Name</th>
                <th className="px-5 py-3 text-left">Module</th>
                <th className="px-5 py-3 text-left">Frequency</th>
                <th className="px-5 py-3 text-left">Format</th>
                <th className="px-5 py-3 text-left">Last Run</th>
                <th className="px-4 py-3 text-right">Size</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {REPORTS.map(r => (
                <tr key={r.name} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-slate-800">{r.name}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${MODULE_STYLE[r.module]}`}>{r.module}</span>
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-500">{r.frequency}</td>
                  <td className="px-5 py-3 text-xs font-mono text-slate-600">{r.format}</td>
                  <td className="px-5 py-3 text-xs text-slate-500">{r.lastRun}</td>
                  <td className="px-4 py-3 text-right text-xs text-slate-400">{r.size}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-5 py-3">
                    {r.status === "Ready" ? (
                      <button className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors">Download</button>
                    ) : (
                      <span className="text-xs text-slate-400">Generating…</span>
                    )}
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
