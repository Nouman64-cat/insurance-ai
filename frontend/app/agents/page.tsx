import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Active Agents", value: "156", subtitle: "across all branches", accent: "blue" as const },
  { title: "Avg Commission", value: "13.2%", subtitle: "weighted portfolio avg", accent: "emerald" as const },
  { title: "Top Commission", value: "18%", subtitle: "corporate segment", accent: "amber" as const },
  { title: "Avg Quality Score", value: "84", subtitle: "sales + persistency + complaints", accent: "slate" as const },
] as const;

const ROWS = [
  { id: "AGT-001", name: "Kashif Mahmood", branch: "Karachi Main", policies: 34, premium: "PKR 12.4M", salesScore: 95, complaint: "0.2%", persistency: 94, commissionRate: "18%", commissionEarned: "PKR 2,232,000", bonus: "Eligible" },
  { id: "AGT-002", name: "Naila Shaheen", branch: "Lahore DHA", policies: 28, premium: "PKR 9.1M", salesScore: 87, complaint: "0.5%", persistency: 89, commissionRate: "15%", commissionEarned: "PKR 1,365,000", bonus: "Eligible" },
  { id: "AGT-003", name: "Faisal Qureshi", branch: "Islamabad F-7", policies: 19, premium: "PKR 6.8M", salesScore: 76, complaint: "1.2%", persistency: 78, commissionRate: "12%", commissionEarned: "PKR 816,000", bonus: "Not Eligible" },
  { id: "AGT-004", name: "Amna Siddiqui", branch: "Karachi Main", policies: 41, premium: "PKR 15.2M", salesScore: 96, complaint: "0.1%", persistency: 97, commissionRate: "18%", commissionEarned: "PKR 2,736,000", bonus: "Eligible" },
  { id: "AGT-005", name: "Tariq Nawaz", branch: "Multan", policies: 12, premium: "PKR 3.2M", salesScore: 68, complaint: "2.4%", persistency: 65, commissionRate: "10%", commissionEarned: "PKR 320,000", bonus: "Not Eligible" },
  { id: "AGT-006", name: "Zara Iqbal", branch: "Lahore Gulberg", policies: 25, premium: "PKR 8.7M", salesScore: 91, complaint: "0.3%", persistency: 93, commissionRate: "15%", commissionEarned: "PKR 1,305,000", bonus: "Eligible" },
];

const BONUS_STYLE: Record<string, string> = {
  "Eligible":     "bg-emerald-50 text-emerald-700 border border-emerald-200",
  "Not Eligible": "bg-slate-100 text-slate-500 border border-slate-200",
};

function ScoreBar({ score }: { score: number }) {
  const color = score >= 90 ? "bg-emerald-500" : score >= 75 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700">{score}</span>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Agents</h1>
        <p className="text-sm text-slate-500 mt-0.5">Agent intelligence — sales quality, persistency performance, complaint ratio, and AI-driven commission calculations.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { label: "Sales Quality Score", score: 87, sub: "Avg across active agents" },
          { label: "Persistency Performance", score: 89, sub: "Policy renewal rate" },
          { label: "Complaint Ratio", score: 94, sub: "Low complaints = high score" },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{s.label}</p>
            <p className="text-3xl font-extrabold text-slate-800 mb-2">{s.score}</p>
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${s.score}%` }} />
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5">{s.sub}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Agent Performance Register</p>
          <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">Commission: Score ≥90 = 18% · 80–89 = 15% · 70–79 = 12% · &lt;70 = 10%</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Agent ID</th>
                <th className="px-5 py-3 text-left">Name</th>
                <th className="px-5 py-3 text-left">Branch</th>
                <th className="px-4 py-3 text-right">Policies</th>
                <th className="px-5 py-3 text-right">Premium Written</th>
                <th className="px-5 py-3 text-left">Quality Score</th>
                <th className="px-4 py-3 text-right">Complaints</th>
                <th className="px-4 py-3 text-right">Persistency</th>
                <th className="px-5 py-3 text-right">Commission Rate</th>
                <th className="px-5 py-3 text-right">Commission Earned</th>
                <th className="px-5 py-3 text-left">Bonus</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.id}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.name}</td>
                  <td className="px-5 py-3 text-xs text-slate-500">{r.branch}</td>
                  <td className="px-4 py-3 text-right text-slate-600">{r.policies}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.premium}</td>
                  <td className="px-5 py-3"><ScoreBar score={r.salesScore} /></td>
                  <td className={`px-4 py-3 text-right text-xs font-semibold ${parseFloat(r.complaint) > 1 ? "text-red-600" : "text-emerald-600"}`}>{r.complaint}</td>
                  <td className="px-4 py-3 text-right text-slate-600">{r.persistency}%</td>
                  <td className="px-5 py-3 text-right font-bold text-blue-700">{r.commissionRate}</td>
                  <td className="px-5 py-3 text-right font-bold text-emerald-700">{r.commissionEarned}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${BONUS_STYLE[r.bonus]}`}>{r.bonus}</span>
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
