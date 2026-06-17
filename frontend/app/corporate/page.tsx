import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Corporate Clients", value: "8", subtitle: "active group life policies", accent: "blue" as const },
  { title: "Total Employees", value: "4,200", subtitle: "covered lives across all groups", accent: "emerald" as const },
  { title: "Annual Premium", value: "PKR 145M", subtitle: "total portfolio premium", accent: "amber" as const },
  { title: "Pending Census", value: "2", subtitle: "data corrections required", accent: "red" as const },
] as const;

const ROWS = [
  { ref: "CORP-2026-E1", company: "Adamjee Industries Ltd.", employees: 1000, premium: "PKR 25,000,000", product: "Group Life", aiScore: 91, status: "Active", commission: "18%", census: "Valid", claims: "PKR 1.2M" },
  { ref: "CORP-2026-E2", company: "TechPak Solutions", employees: 450, premium: "PKR 9,500,000", product: "Group Life", aiScore: 87, status: "Active", commission: "15%", census: "Valid", claims: "PKR 0.4M" },
  { ref: "CORP-2026-E3", company: "National Textile Group", employees: 780, premium: "PKR 18,000,000", product: "Group Life", aiScore: 80, status: "Review", commission: "12%", census: "Duplicates Found", claims: "PKR 2.1M" },
  { ref: "CORP-2026-E4", company: "Pak Pharma Ltd.", employees: 320, premium: "PKR 7,200,000", product: "Group Life", aiScore: 93, status: "Active", commission: "18%", census: "Valid", claims: "PKR 0.3M" },
  { ref: "CORP-2026-E5", company: "Crescent Steel & Allied", employees: 560, premium: "PKR 13,500,000", product: "Group Life", aiScore: 72, status: "Pending", commission: "12%", census: "Missing CNICs", claims: "—" },
  { ref: "CORP-2026-E6", company: "Fauji Fertilizer Co.", employees: 1090, premium: "PKR 28,000,000", product: "Group Life", aiScore: 96, status: "Active", commission: "18%", census: "Valid", claims: "PKR 1.8M" },
];

const STATUS_STYLE: Record<string, string> = {
  Active:  "bg-emerald-50 text-emerald-700 border border-emerald-200",
  Review:  "bg-amber-50 text-amber-700 border border-amber-200",
  Pending: "bg-blue-50 text-blue-700 border border-blue-200",
};

const CENSUS_STYLE: Record<string, string> = {
  Valid:               "text-emerald-600 font-semibold",
  "Duplicates Found":  "text-amber-600 font-semibold",
  "Missing CNICs":     "text-red-600 font-semibold",
};

function ScoreBar({ score }: { score: number }) {
  const color = score >= 90 ? "bg-emerald-500" : score >= 80 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700">{score}</span>
    </div>
  );
}

export default function CorporatePage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Corporate Underwriting</h1>
        <p className="text-sm text-slate-500 mt-0.5">Group life underwriting with AI employee census validation, duplicate detection, and commission scoring.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {[
          { label: "Premium Volume Score", score: 100, color: "bg-emerald-500" },
          { label: "Claims Ratio Score", score: 80, color: "bg-amber-400" },
          { label: "Data Accuracy Score", score: 95, color: "bg-emerald-500" },
          { label: "Fraud Index Score", score: 90, color: "bg-emerald-500" },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{s.label}</p>
            <p className="text-3xl font-extrabold text-slate-800 mb-2">{s.score}</p>
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className={`h-full rounded-full ${s.color}`} style={{ width: `${s.score}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Corporate Accounts</p>
          <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">Commission Matrix: 90+ = 18% · 80–89 = 15% · 70–79 = 12%</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Reference</th>
                <th className="px-5 py-3 text-left">Company</th>
                <th className="px-5 py-3 text-right">Employees</th>
                <th className="px-5 py-3 text-right">Annual Premium</th>
                <th className="px-5 py-3 text-left">AI Score</th>
                <th className="px-5 py-3 text-left">Census</th>
                <th className="px-5 py-3 text-right">Claims YTD</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-right">Commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.company}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{r.employees.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.premium}</td>
                  <td className="px-5 py-3"><ScoreBar score={r.aiScore} /></td>
                  <td className={`px-5 py-3 text-xs ${CENSUS_STYLE[r.census]}`}>{r.census}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{r.claims}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-5 py-3 text-right font-bold text-emerald-700">{r.commission}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
