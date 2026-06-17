import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Claims Filed MTD", value: "89", subtitle: "across all policy types", accent: "blue" as const },
  { title: "Approved", value: "71", subtitle: "PKR 42.5M disbursed", accent: "emerald" as const, trend: { value: "79.8% approval rate", direction: "up" as const } },
  { title: "Rejected", value: "14", subtitle: "coverage / fraud reasons", accent: "red" as const },
  { title: "Fraud Detected", value: "4", subtitle: "PKR 6.2M blocked", accent: "amber" as const },
] as const;

const ROWS = [
  { ref: "CLM-2026-C1", policy: "POL-2021-0441", claimant: "Ali Hassan", type: "Hospitalization", amount: "PKR 500,000", limit: "PKR 500,000", approved: "PKR 500,000", fraudProb: "2%", status: "Approved", score: 94 },
  { ref: "CLM-2026-C2", policy: "POL-2022-0123", claimant: "Sara Khalid", type: "Hospitalization", amount: "PKR 150,000", limit: "PKR 300,000", approved: "—", fraudProb: "92%", status: "Fraud Rejected", score: 18 },
  { ref: "CLM-2026-C3", policy: "POL-2020-0887", claimant: "Imran Nawaz", type: "Surgery", amount: "PKR 500,000", limit: "PKR 300,000", approved: "PKR 300,000", fraudProb: "5%", status: "Partial Approval", score: 88 },
  { ref: "CLM-2026-D1", policy: "POL-2023-0214", claimant: "Fatima Shah", type: "Hospitalization", amount: "PKR 300,000", limit: "PKR 500,000", approved: "PKR 300,000", fraudProb: "3%", status: "Approved", score: 96 },
  { ref: "CLM-2026-D2", policy: "POL-2021-0762", claimant: "Tariq Jameel", type: "Hospitalization", amount: "PKR 80,000", limit: "PKR 300,000", approved: "—", fraudProb: "94%", status: "Duplicate Rejected", score: 12 },
  { ref: "CLM-2026-E4", policy: "CORP-2022-0031", claimant: "Raheel Ahmed", type: "Death Claim", amount: "PKR 1,200,000", limit: "PKR 1,200,000", approved: "PKR 1,200,000", fraudProb: "1%", status: "Approved", score: 98 },
  { ref: "CLM-2026-E5", policy: "CORP-2022-0031", claimant: "Estate of M. Zubair", type: "Death Claim", amount: "PKR 900,000", limit: "PKR 900,000", approved: "—", fraudProb: "61%", status: "Investigation", score: 47 },
];

const STATUS_STYLE: Record<string, string> = {
  "Approved":          "bg-emerald-50 text-emerald-700 border border-emerald-200",
  "Partial Approval":  "bg-blue-50 text-blue-700 border border-blue-200",
  "Fraud Rejected":    "bg-red-50 text-red-700 border border-red-200",
  "Duplicate Rejected":"bg-red-50 text-red-700 border border-red-200",
  "Investigation":     "bg-amber-50 text-amber-700 border border-amber-200",
};

function FraudBar({ pct }: { pct: string }) {
  const n = parseInt(pct);
  const color = n >= 80 ? "bg-red-500" : n >= 50 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: pct }} />
      </div>
      <span className={`text-xs font-bold ${n >= 80 ? "text-red-600" : n >= 50 ? "text-amber-600" : "text-emerald-600"}`}>{pct}</span>
    </div>
  );
}

export default function ClaimsPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Claims</h1>
        <p className="text-sm text-slate-500 mt-0.5">AI-assisted claims processing with fraud probability scoring, duplicate detection, and coverage validation.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { label: "Claim Accuracy Score", score: 95, sub: "Avg across approved claims" },
          { label: "Fraud Indicator Score", score: 98, sub: "AI detection confidence" },
          { label: "Policy Persistency Score", score: 95, sub: "Customer retention quality" },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{s.label}</p>
            <p className="text-3xl font-extrabold text-slate-800 mb-2">{s.score}</p>
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${s.score}%` }} />
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5">{s.sub}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Claims Register</p>
          <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">Overall Score 94 · Renewal Bonus Eligible · Agent Incentive +2%</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 text-left">Claim Ref</th>
                <th className="px-5 py-3 text-left">Claimant</th>
                <th className="px-5 py-3 text-left">Type</th>
                <th className="px-5 py-3 text-right">Claimed</th>
                <th className="px-5 py-3 text-right">Coverage Limit</th>
                <th className="px-5 py-3 text-right">Approved Amt</th>
                <th className="px-5 py-3 text-left">Fraud Prob.</th>
                <th className="px-5 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ROWS.map(r => (
                <tr key={r.ref} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ref}</td>
                  <td className="px-5 py-3 font-medium text-slate-800">{r.claimant}</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">{r.type}</td>
                  <td className="px-5 py-3 text-right font-semibold text-slate-700">{r.amount}</td>
                  <td className="px-5 py-3 text-right text-slate-500">{r.limit}</td>
                  <td className="px-5 py-3 text-right font-bold text-emerald-700">{r.approved}</td>
                  <td className="px-5 py-3"><FraudBar pct={r.fraudProb} /></td>
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
