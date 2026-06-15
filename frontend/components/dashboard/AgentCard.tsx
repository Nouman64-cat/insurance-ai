import { Bar, PillarCard, Divider } from "./shared";

function UserCheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  );
}

const TOP_AGENTS = [
  { id: "A-0047", name: "Tariq Mahmood", score: 94, commission: "PKR 412K", cases: 31 },
  { id: "A-0112", name: "Sana Khalid",   score: 91, commission: "PKR 378K", cases: 28 },
  { id: "A-0023", name: "Bilal Raza",    score: 88, commission: "PKR 341K", cases: 26 },
] as const;

const QUALITY_METRICS = [
  { label: "Sales Quality Score",  pct: 78.4, color: "bg-amber-500",   badge: "78.4 / 100" },
  { label: "Policy Activation Rate", pct: 91, color: "bg-emerald-500", badge: "91.0%"      },
  { label: "Complaint Ratio",      pct: 2.1,  color: "bg-red-400",     badge: "2.1%"       },
] as const;

export function AgentCard() {
  return (
    <PillarCard
      icon={<UserCheckIcon />}
      title="Agent Intelligence"
      barClass="bg-amber-500"
      iconBg="bg-amber-50"
      iconColor="text-amber-600"
    >
      <div className="flex flex-col sm:flex-row gap-5">

        {/* Left: Commission + quality bars */}
        <div className="flex-1 space-y-4">
          {/* Commission headline */}
          <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-500">Commission Earned — MTD</p>
            <p className="text-2xl font-extrabold text-amber-700 mt-0.5">PKR 4.2M</p>
            <div className="flex gap-4 mt-2">
              <div>
                <p className="text-[10px] text-amber-400">Active Agents</p>
                <p className="text-sm font-bold text-amber-700">234</p>
              </div>
              <div>
                <p className="text-[10px] text-amber-400">Avg / Agent</p>
                <p className="text-sm font-bold text-amber-700">PKR 17.9K</p>
              </div>
              <div>
                <p className="text-[10px] text-amber-400">Cases / Agent</p>
                <p className="text-sm font-bold text-amber-700">5.4</p>
              </div>
            </div>
          </div>

          {/* Quality bars */}
          <div className="space-y-2.5">
            {QUALITY_METRICS.map((m) => (
              <Bar key={m.label} label={m.label} pct={m.pct} color={m.color} badge={m.badge} />
            ))}
          </div>
        </div>

        <Divider className="sm:hidden" />

        {/* Right: Top performers */}
        <div className="sm:w-52 flex-shrink-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">Top Performers</p>
          <div className="space-y-0">
            {TOP_AGENTS.map((a, i) => (
              <div key={a.id} className="flex items-center gap-2.5 py-2.5 border-b border-slate-100 last:border-0">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold flex-shrink-0 ${
                  i === 0 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
                }`}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-800 truncate">{a.name}</p>
                  <p className="text-[10px] text-slate-400">{a.cases} cases · {a.commission}</p>
                </div>
                <span className="text-xs font-extrabold text-amber-600">{a.score}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Bonus Eligible</p>
            <p className="text-base font-extrabold text-emerald-600 mt-0.5">18 agents</p>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}
