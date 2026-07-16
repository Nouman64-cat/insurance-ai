import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Medical Cases", value: "34", subtitle: "high-risk referrals", accent: "blue" as const },
  { title: "Manual Review", value: "12", subtitle: "senior underwriter queue", accent: "amber" as const },
  { title: "Loading Applied", value: "15", subtitle: "avg loading 28%", accent: "red" as const },
  { title: "Auto Approved", value: "7", subtitle: "score ≥ 85, low risk", accent: "emerald" as const },
] as const;

const ROWS = [
  { ref: "MED-2026-B1", name: "Khalid Mehmood", age: 52, conditions: "Diabetes, Hypertension", assured: "PKR 20,000,000", aiScore: 70, status: "Manual Review", loading: "35%", commission: "10%", docs: "Complete" },
  { ref: "MED-2026-B2", name: "Nadia Iqbal", age: 48, conditions: "Hypertension", assured: "PKR 12,000,000", aiScore: 60, status: "Docs Expired", loading: "—", commission: "—", docs: "Expired" },
  { ref: "MED-2026-B3", name: "Tariq Butt", age: 55, conditions: "Diabetes", assured: "PKR 8,000,000", aiScore: 20, status: "Fraud Alert", loading: "—", commission: "—", docs: "Tampered" },
  { ref: "MED-2026-C1", name: "Rukhsana Bibi", age: 45, conditions: "Asthma", assured: "PKR 5,000,000", aiScore: 82, status: "Approved + Loading", loading: "20%", commission: "12%", docs: "Complete" },
  { ref: "MED-2026-C2", name: "Junaid Akhtar", age: 39, conditions: "None", assured: "PKR 7,500,000", aiScore: 91, status: "Auto Approved", loading: "—", commission: "15%", docs: "Complete" },
];

const STATUS_STYLE: Record<string, string> = {
  "Manual Review":      "bg-blue-50 text-blue-700 border border-blue-200",
  "Docs Expired":       "bg-amber-50 text-amber-700 border border-amber-200",
  "Fraud Alert":        "bg-red-50 text-red-700 border border-red-200",
  "Approved + Loading": "bg-violet-50 text-violet-700 border border-violet-200",
  "Auto Approved":      "bg-emerald-50 text-emerald-700 border border-emerald-200",
};

const DOCS_STYLE: Record<string, string> = {
  Complete:  "text-emerald-600 font-semibold",
  Expired:   "text-amber-600 font-semibold",
  Tampered:  "text-red-600 font-semibold",
};

function ScoreBar({ score }: { score: number }) {
  const color = score >= 85 ? "bg-emerald-500" : score >= 65 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold text-slate-700">{score}</span>
    </div>
  );
}

export default function MedicalUnderwritingPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Medical Underwriting</h1>
          <p className="text-sm text-slate-500 mt-0.5">High-risk medical cases with AI-driven loading recommendations and fraud detection.</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs font-semibold text-amber-700">12 Awaiting Senior Underwriter</span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { label: "Age Risk", score: 55, desc: "Avg for medical queue" },
          { label: "Health Risk", score: 45, desc: "Based on declared conditions" },
          { label: "Artifact Quality", score: 95, desc: "Avg document confidence" },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">{s.label}</p>
            <div className="flex items-end gap-3">
              <p className="text-3xl font-extrabold text-slate-800">{s.score}</p>
              <div className="flex-1 pb-1">
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full rounded-full ${s.score >= 85 ? "bg-emerald-500" : s.score >= 65 ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${s.score}%` }} />
                </div>
                <p className="text-[10px] text-slate-400 mt-1">{s.desc}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">Medical Case Queue</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Reference</th>
                <th className="px-5 py-3 text-left">Applicant</th>
                <th className="px-5 py-3 text-left">Age</th>
                <th className="px-5 py-3 text-left">Conditions</th>
                <th className="px-5 py-3 text-right">Sum Assured</th>
                <th className="px-5 py-3 text-left">AI Score</th>
                <th className="px-5 py-3 text-left">Documents</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-right">Loading</th>
                <th className="px-5 py-3 text-right">Commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.name}</td>
                  <td className="px-5 py-3 text-slate-600">{r.age}</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">{r.conditions}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.assured}</td>
                  <td className="px-5 py-3"><ScoreBar score={r.aiScore} /></td>
                  <td className={`px-5 py-3 text-xs ${DOCS_STYLE[r.docs]}`}>{r.docs}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-xs font-bold text-red-600">{r.loading}</td>
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
