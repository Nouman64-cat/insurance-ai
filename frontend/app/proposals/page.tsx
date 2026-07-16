import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Proposals Today", value: "127", subtitle: "across all underwriting queues", accent: "blue" as const, trend: { value: "+14 vs yesterday", direction: "up" as const } },
  { title: "Auto Approved", value: "98", subtitle: "AI score ≥ 90", accent: "emerald" as const, trend: { value: "77% approval rate", direction: "up" as const } },
  { title: "Under Review", value: "22", subtitle: "awaiting underwriter", accent: "amber" as const },
  { title: "Rejected", value: "7", subtitle: "risk threshold exceeded", accent: "red" as const },
] as const;

const ROWS = [
  { ref: "PRO-2026-A1", name: "Muhammad Ali Khan", age: 32, occupation: "Software Engineer", assured: "PKR 10,000,000", product: "Term Life 20", aiScore: 93.75, artifactScore: "98%", status: "Auto Approved", commission: "15%" },
  { ref: "PRO-2026-A2", name: "Bilal Hussain", age: 35, occupation: "Accountant", assured: "PKR 8,000,000", product: "Term Life 15", aiScore: 75.0, artifactScore: "75%", status: "Human Review", commission: "10%" },
  { ref: "PRO-2026-A3", name: "Ayesha Noor", age: 28, occupation: "Doctor", assured: "PKR 15,000,000", product: "Whole Life", aiScore: 40.0, artifactScore: "40%", status: "Re-submission", commission: "—" },
  { ref: "PRO-2026-B1", name: "Kamran Sheikh", age: 44, occupation: "Business Owner", assured: "PKR 6,000,000", product: "Endowment 10", aiScore: 88.5, artifactScore: "92%", status: "Auto Approved", commission: "12%" },
  { ref: "PRO-2026-B2", name: "Sana Rizvi", age: 39, occupation: "Teacher", assured: "PKR 4,000,000", product: "Term Life 10", aiScore: 91.2, artifactScore: "96%", status: "Auto Approved", commission: "15%" },
  { ref: "PRO-2026-C1", name: "Usman Farooq", age: 52, occupation: "Retired", assured: "PKR 3,000,000", product: "Whole Life", aiScore: 62.0, artifactScore: "70%", status: "Human Review", commission: "10%" },
];

const STATUS_STYLE: Record<string, string> = {
  "Auto Approved": "bg-emerald-50 text-emerald-700 border border-emerald-200",
  "Human Review":  "bg-blue-50 text-blue-700 border border-blue-200",
  "Re-submission": "bg-red-50 text-red-700 border border-red-200",
};

function ScorePill({ score }: { score: number }) {
  const color = score >= 90 ? "bg-emerald-500" : score >= 75 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700">{score}</span>
    </div>
  );
}

export default function ProposalsPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Proposals</h1>
        <p className="text-sm text-slate-500 mt-0.5">Individual life insurance proposals evaluated by the AI underwriting engine.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Recent Proposals</p>
          <span className="text-xs text-slate-400">AI Score Engine · Gemini 2.5 Flash</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Reference</th>
                <th className="px-5 py-3 text-left">Applicant</th>
                <th className="px-5 py-3 text-left">Age / Occupation</th>
                <th className="px-5 py-3 text-right">Sum Assured</th>
                <th className="px-5 py-3 text-left">AI Score</th>
                <th className="px-5 py-3 text-left">Artifact</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-right">Commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.name}</td>
                  <td className="px-5 py-3 text-slate-500">{r.age} · {r.occupation}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.assured}</td>
                  <td className="px-5 py-3"><ScorePill score={r.aiScore} /></td>
                  <td className="px-5 py-3 text-xs font-semibold text-slate-600">{r.artifactScore}</td>
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
