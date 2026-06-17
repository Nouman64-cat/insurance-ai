import { MetricCard } from "@/components/MetricCard";

const KPIS = [
  { title: "Avg Score Today", value: "82.3", subtitle: "across 127 evaluations", accent: "blue" as const },
  { title: "High Risk (≥ 90)", value: "34", subtitle: "auto-approved", accent: "emerald" as const },
  { title: "Medium Risk (70–89)", value: "68", subtitle: "review or loading", accent: "amber" as const },
  { title: "Low Risk (< 70)", value: "25", subtitle: "declined or escalated", accent: "red" as const },
] as const;

const INPUTS = [
  { label: "Customer Risk Profile", weight: "15%", score: 88, desc: "Age, occupation, lifestyle" },
  { label: "Medical Risk Assessment", weight: "20%", score: 72, desc: "Health history & conditions" },
  { label: "Artifact Quality Score", weight: "15%", score: 94, desc: "OCR confidence & authenticity" },
  { label: "Fraud Probability Score", weight: "20%", score: 91, desc: "Forgery & duplicate detection" },
  { label: "Claims History", weight: "10%", score: 85, desc: "Historical claim behavior" },
  { label: "Policy Persistency", weight: "5%", score: 95, desc: "Renewal and lapse history" },
  { label: "Premium Volume", weight: "5%", score: 100, desc: "Portfolio size contribution" },
  { label: "Agent Performance", weight: "5%", score: 82, desc: "Quality & complaint ratio" },
  { label: "Customer Retention", weight: "5%", score: 90, desc: "Loyalty and persistency score" },
];

const OUTPUTS = [
  { label: "Underwriting Decision", value: "Auto Approve / Review / Decline", color: "bg-emerald-500" },
  { label: "Risk Classification", value: "Low / Medium / High / Very High", color: "bg-blue-500" },
  { label: "Medical Loading", value: "0% to 100% loading recommendation", color: "bg-violet-500" },
  { label: "Claim Approval", value: "Approve / Partial / Reject", color: "bg-amber-500" },
  { label: "Fraud Alert", value: "Flagged / Investigation / Clear", color: "bg-red-500" },
  { label: "Reimbursement", value: "Eligible / Partial / Rejected", color: "bg-teal-500" },
  { label: "Agent Commission", value: "10% / 12% / 15% / 18%", color: "bg-emerald-600" },
  { label: "Quality Bonus", value: "Eligible / Not Eligible", color: "bg-blue-600" },
];

const SCENARIOS = [
  { name: "Scenario 1 — Individual Life", ref: "PRO-2026-A1", score: 93.75, decision: "Auto Approve", commission: "15%", accent: "emerald" },
  { name: "Scenario 2 — High-Risk Medical", ref: "MED-2026-B1", score: 70.0, decision: "Manual Review", commission: "10%", accent: "amber" },
  { name: "Scenario 3 — Claims Processing", ref: "CLM-2026-C1", score: 94.0, decision: "Approved", commission: "+2% Bonus", accent: "emerald" },
  { name: "Scenario 4 — Reimbursements", ref: "RMB-2026-D1", score: 90.0, decision: "Eligible", commission: "15%", accent: "emerald" },
  { name: "Scenario 5 — Corporate Group", ref: "CORP-2026-E1", score: 91.0, decision: "Auto Approve", commission: "18%", accent: "emerald" },
];

const DECISION_STYLE: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  amber:   "bg-amber-50 text-amber-700 border border-amber-200",
  red:     "bg-red-50 text-red-700 border border-red-200",
};

export default function ScoreEnginePage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">AI Score Engine</h1>
          <p className="text-sm text-slate-500 mt-0.5">Centralized intelligence engine consolidating risk, artifact, fraud, and persistency signals into a unified decision score.</p>
        </div>
        <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold tracking-wide">insurance-ai v0.1.0-proto</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIS.map(k => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-700">Score Inputs</p>
            <p className="text-xs text-slate-400 mt-0.5">9 weighted signals processed per evaluation</p>
          </div>
          <div className="p-5 space-y-4">
            {INPUTS.map(inp => (
              <div key={inp.label}>
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <span className="text-xs font-semibold text-slate-700">{inp.label}</span>
                    <span className="ml-2 text-[10px] text-slate-400">{inp.desc}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{inp.weight}</span>
                    <span className="text-xs font-bold text-slate-800 w-6 text-right">{inp.score}</span>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${inp.score >= 90 ? "bg-emerald-500" : inp.score >= 75 ? "bg-amber-400" : "bg-red-400"}`}
                    style={{ width: `${inp.score}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-700">Score Outputs</p>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
              {OUTPUTS.map(o => (
                <div key={o.label} className="flex items-start gap-2.5">
                  <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${o.color}`} />
                  <div>
                    <p className="text-xs font-semibold text-slate-700">{o.label}</p>
                    <p className="text-[10px] text-slate-400">{o.value}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-700">Demo Scenario Scores</p>
            </div>
            <div className="divide-y divide-slate-50">
              {SCENARIOS.map(s => (
                <div key={s.ref} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div>
                    <p className="text-xs font-semibold text-slate-700">{s.name}</p>
                    <p className="text-[10px] text-slate-400 font-mono">{s.ref}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-extrabold text-slate-800">{s.score}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${DECISION_STYLE[s.accent]}`}>{s.decision}</span>
                    <span className="text-xs font-bold text-emerald-700">{s.commission}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
