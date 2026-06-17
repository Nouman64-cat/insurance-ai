import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Requests MTD", value: "34", subtitle: "health rider reimbursements", accent: "blue" as const },
  { title: "Approved", value: "28", subtitle: "PKR 840K disbursed", accent: "emerald" as const, trend: { value: "82% approval rate", direction: "up" as const } },
  { title: "Rejected", value: "6", subtitle: "limit exceeded / fraud", accent: "red" as const },
  { title: "Fraud Score Avg", value: "94%", subtitle: "detection confidence", accent: "amber" as const },
] as const;

const ROWS = [
  { ref: "RMB-2026-D1", policy: "POL-2023-0541", holder: "Bilal Farooq", rider: "Hospital Cash", dailyBenefit: "PKR 5,000", days: 5, requested: "PKR 25,000", annualLimit: "PKR 50,000", utilized: "PKR 0", approved: "PKR 25,000", fraudScore: "2%", status: "Approved" },
  { ref: "RMB-2026-D2", policy: "POL-2022-0812", holder: "Asma Tariq", rider: "Hospital Cash", dailyBenefit: "PKR 5,000", days: 3, requested: "PKR 15,000", annualLimit: "PKR 50,000", utilized: "PKR 15,000", approved: "—", fraudScore: "94%", status: "Duplicate Rejected" },
  { ref: "RMB-2026-D3", policy: "POL-2021-0339", holder: "Hamza Qureshi", rider: "Hospital Cash", dailyBenefit: "PKR 5,000", days: 4, requested: "PKR 20,000", annualLimit: "PKR 50,000", utilized: "PKR 40,000", approved: "PKR 10,000", fraudScore: "6%", status: "Partial — Limit" },
  { ref: "RMB-2026-D4", policy: "POL-2024-0107", holder: "Zainab Malik", rider: "Hospital Cash", dailyBenefit: "PKR 5,000", days: 2, requested: "PKR 10,000", annualLimit: "PKR 50,000", utilized: "PKR 5,000", approved: "PKR 10,000", fraudScore: "1%", status: "Approved" },
  { ref: "RMB-2026-D5", policy: "POL-2022-0654", holder: "Omar Siddiqui", rider: "Hospital Cash", dailyBenefit: "PKR 7,500", days: 7, requested: "PKR 52,500", annualLimit: "PKR 75,000", utilized: "PKR 30,000", approved: "PKR 45,000", fraudScore: "4%", status: "Partial — Limit" },
  { ref: "RMB-2026-D6", policy: "POL-2023-0789", holder: "Rabia Aziz", rider: "Hospital Cash", dailyBenefit: "PKR 5,000", days: 6, requested: "PKR 30,000", annualLimit: "PKR 50,000", utilized: "PKR 10,000", approved: "PKR 30,000", fraudScore: "3%", status: "Approved" },
];

const STATUS_STYLE: Record<string, string> = {
  "Approved":           "bg-emerald-50 text-emerald-700 border border-emerald-200",
  "Partial — Limit":    "bg-blue-50 text-blue-700 border border-blue-200",
  "Duplicate Rejected": "bg-red-50 text-red-700 border border-red-200",
};

function FraudBar({ pct }: { pct: string }) {
  const n = parseInt(pct);
  const color = n >= 80 ? "bg-red-500" : n >= 50 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: pct }} />
      </div>
      <span className={`text-xs font-bold ${n >= 80 ? "text-red-600" : "text-emerald-600"}`}>{pct}</span>
    </div>
  );
}

export default function ReimbursementsPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Reimbursements</h1>
        <p className="text-sm text-slate-500 mt-0.5">Health rider reimbursement processing with AI duplicate detection and annual benefit limit enforcement.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { label: "Customer Retention Score", score: 95, color: "bg-emerald-500" },
          { label: "Claim Ratio Score", score: 85, color: "bg-amber-400" },
          { label: "Fraud Control Score", score: 90, color: "bg-emerald-500" },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{s.label}</p>
            <p className="text-3xl font-extrabold text-slate-800 mb-2">{s.score}</p>
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className={`h-full rounded-full ${s.color}`} style={{ width: `${s.score}%` }} />
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5">Overall Score: 90 · Commission: 15%</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">Reimbursement Register</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Reference</th>
                <th className="px-5 py-3 text-left">Policyholder</th>
                <th className="px-5 py-3 text-left">Rider</th>
                <th className="px-4 py-3 text-right">Days</th>
                <th className="px-5 py-3 text-right">Requested</th>
                <th className="px-5 py-3 text-right">Annual Limit</th>
                <th className="px-5 py-3 text-right">Utilized</th>
                <th className="px-5 py-3 text-right">Approved</th>
                <th className="px-5 py-3 text-left">Fraud Score</th>
                <th className="px-5 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.holder}</td>
                  <td className="px-5 py-3 text-xs text-slate-600">{r.rider}</td>
                  <td className="px-4 py-3 text-right text-slate-600">{r.days}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.requested}</td>
                  <td className="px-5 py-3 text-right text-slate-500">{r.annualLimit}</td>
                  <td className="px-5 py-3 text-right text-slate-500">{r.utilized}</td>
                  <td className="px-5 py-3 text-right font-bold text-emerald-700">{r.approved}</td>
                  <td className="px-5 py-3"><FraudBar pct={r.fraudScore} /></td>
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
