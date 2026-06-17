import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Premium Collected MTD", value: "PKR 143M", subtitle: "month-to-date collections", accent: "emerald" as const, trend: { value: "+12.3% vs last month", direction: "up" as const } },
  { title: "Commissions Paid MTD", value: "PKR 18.2M", subtitle: "all agent tiers", accent: "blue" as const },
  { title: "Incentives Earned", value: "PKR 2.1M", subtitle: "quality & persistency bonuses", accent: "amber" as const },
  { title: "Portfolio Risk Index", value: "68 / 100", subtitle: "composite AI risk score", accent: "slate" as const, trend: { value: "stable ±1 pt", direction: "neutral" as const } },
] as const;

const COMMISSION_MATRIX = [
  { tier: "Individual Life (Score ≥ 90)", rate: "15%", cases: 98, premium: "PKR 78.4M", paidOut: "PKR 11.76M", scenario: "Scenario 1" },
  { tier: "Individual Life (Score 80–89)", rate: "12%", cases: 18, premium: "PKR 14.2M", paidOut: "PKR 1.70M", scenario: "Scenario 1" },
  { tier: "Individual Life (Score 70–79)", rate: "10%", cases: 11, premium: "PKR 8.1M", paidOut: "PKR 0.81M", scenario: "Scenario 1" },
  { tier: "Medical Underwriting", rate: "10%", cases: 12, premium: "PKR 9.6M", paidOut: "PKR 0.96M", scenario: "Scenario 2" },
  { tier: "Health Rider Reimbursement (Score ≥ 90)", rate: "15%", cases: 28, premium: "PKR 5.6M", paidOut: "PKR 0.84M", scenario: "Scenario 4" },
  { tier: "Corporate Group (Score ≥ 90)", rate: "18%", cases: 4, premium: "PKR 108M", paidOut: "PKR 1.44M", scenario: "Scenario 5" },
  { tier: "Corporate Group (Score 80–89)", rate: "15%", cases: 3, premium: "PKR 44M", paidOut: "PKR 0.66M", scenario: "Scenario 5" },
];

const FORECAST = [
  { month: "Jan 2026", premium: 118, commissions: 14.9, risk: 71 },
  { month: "Feb 2026", premium: 124, commissions: 15.6, risk: 70 },
  { month: "Mar 2026", premium: 131, commissions: 16.5, risk: 69 },
  { month: "Apr 2026", premium: 127, commissions: 16.0, risk: 69 },
  { month: "May 2026", premium: 135, commissions: 17.1, risk: 68 },
  { month: "Jun 2026", premium: 143, commissions: 18.2, risk: 68 },
];

const maxPremium = Math.max(...FORECAST.map(f => f.premium));

export default function FinancialPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Financial Intelligence</h1>
        <p className="text-sm text-slate-500 mt-0.5">Dynamic commission calculations, quality incentives, premium forecasting, and portfolio risk analysis.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-700">Premium Trend (PKR M)</p>
            <p className="text-xs text-slate-400 mt-0.5">Jan – Jun 2026</p>
          </div>
          <div className="p-5">
            <div className="flex items-end gap-3 h-36">
              {FORECAST.map(f => (
                <div key={f.month} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-[9px] font-bold text-slate-600">{f.premium}M</span>
                  <div
                    className="w-full rounded-t-md bg-blue-500 opacity-80 hover:opacity-100 transition-opacity"
                    style={{ height: `${(f.premium / maxPremium) * 100}%` }}
                  />
                  <span className="text-[9px] text-slate-400">{f.month.slice(0, 3)}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { label: "Total H1 Premium", value: "PKR 778M" },
                { label: "Total H1 Commissions", value: "PKR 98.3M" },
                { label: "Avg Portfolio Risk", value: "69.2" },
              ].map(s => (
                <div key={s.label} className="text-center">
                  <p className="text-xs font-bold text-slate-800">{s.value}</p>
                  <p className="text-[10px] text-slate-400">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-700">Commission Matrix by Scenario</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-2.5 text-left">Tier</th>
                  <th className="px-3 py-2.5 text-right">Rate</th>
                  <th className="px-3 py-2.5 text-right">Cases</th>
                  <th className="px-4 py-2.5 text-right">Paid Out</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {COMMISSION_MATRIX.map(r => (
                  <tr key={r.tier} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-700">{r.tier}</p>
                      <p className="text-[10px] text-slate-400">{r.scenario}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-blue-700">{r.rate}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{r.cases}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-emerald-700">{r.paidOut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
