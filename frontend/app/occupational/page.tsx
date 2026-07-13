import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Occupational Cases", value: "42", subtitle: "active assessments", accent: "blue" as const },
  { title: "High Risk Queue", value: "18", subtitle: "hazard class 3 & 4", accent: "amber" as const },
  { title: "Avg Loading Applied", value: "22%", subtitle: "for hazardous jobs", accent: "red" as const },
  { title: "Auto Pass Rate", value: "78%", subtitle: "class 1 & 2 profiles", accent: "emerald" as const },
] as const;

const ROWS = [
  { ref: "OCC-2026-A1", name: "Zubair Ahmad", occupation: "Offshore Petroleum Engineer", hazardClass: "Class 4 (High)", assured: "PKR 35,000,000", aiScore: 48, status: "Manual Review", loading: "50%", docs: "Complete" },
  { ref: "OCC-2026-A2", name: "Ayesha Khan", occupation: "Commercial Airline Pilot", hazardClass: "Class 3 (Medium-High)", assured: "PKR 25,000,000", aiScore: 78, status: "Approved + Loading", loading: "15%", docs: "Complete" },
  { ref: "OCC-2026-A3", name: "Faisal Mahmood", occupation: "Principal Software Architect", hazardClass: "Class 1 (Low)", assured: "PKR 10,000,000", aiScore: 98, status: "Auto Approved", loading: "—", docs: "Complete" },
  { ref: "OCC-2026-A4", name: "Mariam Shah", occupation: "Deep Sea Welding Specialist", hazardClass: "Class 4 (High)", assured: "PKR 18,000,000", aiScore: 32, status: "Refer to Committee", loading: "75%", docs: "Under Review" },
  { ref: "OCC-2026-A5", name: "Bilal Siddiqui", occupation: "High-Rise Construction Foreman", hazardClass: "Class 2 (Medium)", assured: "PKR 12,000,000", aiScore: 84, status: "Approved + Loading", loading: "10%", docs: "Complete" },
];

const STATUS_STYLE: Record<string, string> = {
  "Manual Review":      "bg-blue-50 text-blue-700 border border-blue-200",
  "Refer to Committee": "bg-red-50 text-red-700 border border-red-200",
  "Approved + Loading": "bg-violet-50 text-violet-700 border border-violet-200",
  "Auto Approved":      "bg-emerald-50 text-emerald-700 border border-emerald-200",
};

const DOCS_STYLE: Record<string, string> = {
  Complete:       "text-emerald-600 font-semibold",
  "Under Review": "text-amber-600 font-semibold animate-pulse",
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

export default function OccupationalUnderwritingPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Occupational Underwriting</h1>
          <p className="text-sm text-slate-500 mt-0.5">Assessing work-related risks, vocational hazard indexing, and premium loading factors.</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs font-semibold text-amber-700">18 Class 3 & 4 Referrals</span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { label: "Hazard Exposure Score", score: 62, desc: "Composite queue risk index" },
          { label: "Physical Exertion Index", score: 70, desc: "Average workload profile" },
          { label: "Safety Protocol Match", score: 88, desc: "Employer safety rating compliance" },
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
          <p className="text-sm font-semibold text-slate-700">Occupational Hazard Assessment Queue</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Reference</th>
                <th className="px-5 py-3 text-left">Applicant</th>
                <th className="px-5 py-3 text-left">Occupation</th>
                <th className="px-5 py-3 text-left">Hazard Class</th>
                <th className="px-5 py-3 text-right">Sum Assured</th>
                <th className="px-5 py-3 text-left">AI Risk Score</th>
                <th className="px-5 py-3 text-left">Job Description Docs</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-right">Loading</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.name}</td>
                  <td className="px-5 py-3 text-slate-600 text-xs font-medium">{r.occupation}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${
                      r.hazardClass.includes("Class 4")
                        ? "bg-red-50 text-red-700 border border-red-100"
                        : r.hazardClass.includes("Class 3")
                        ? "bg-amber-50 text-amber-700 border border-amber-100"
                        : r.hazardClass.includes("Class 2")
                        ? "bg-blue-50 text-blue-700 border border-blue-100"
                        : "bg-slate-50 text-slate-600 border border-slate-100"
                    }`}>
                      {r.hazardClass}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.assured}</td>
                  <td className="px-5 py-3"><ScoreBar score={r.aiScore} /></td>
                  <td className={`px-5 py-3 text-xs ${DOCS_STYLE[r.docs] || "text-slate-500"}`}>{r.docs}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-xs font-bold text-red-600">{r.loading}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
