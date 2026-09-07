import { RingGauge, Stat, PillarCard, Divider } from "./shared";
import type { Claim } from "@/app/services/claims";
import type { PolicyListItem, PolicyStats } from "@/app/services/policies";

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function isToday(dateStr: string): boolean {
  return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

interface UnderwritingCardProps {
  policies: PolicyListItem[];
  claims: Claim[];
  policyStats: PolicyStats | null;
  /** Composite risk score computed once on the page and shared with the KPI strip. */
  riskIndex: number;
}

export function UnderwritingCard({ policies, claims, policyStats, riskIndex }: UnderwritingCardProps) {
  const PENDING_STATUSES = ["Quoted", "Proposed", "UnderReview", "InformationRequested", "PendingPayment", "CounterOffer", "Postponed"];
  const LAPSED_LIKE_STATUSES = ["Lapsed", "Cancelled", "Declined", "NotTakenUp"];

  const total = policies.length;
  const issuedOrBetter = policies.filter((p) => p.status !== "Quoted").length;
  const issuanceRatePct = total > 0 ? Math.round((issuedOrBetter / total) * 100) : 0;

  const activePct = total > 0 ? (policies.filter((p) => p.status === "Active").length / total) * 100 : 0;
  const gracePct = total > 0 ? (policies.filter((p) => p.status === "GracePeriod").length / total) * 100 : 0;
  const pendingPct = total > 0 ? (policies.filter((p) => PENDING_STATUSES.includes(p.status)).length / total) * 100 : 0;
  const lapsedPct = total > 0 ? (policies.filter((p) => LAPSED_LIKE_STATUSES.includes(p.status)).length / total) * 100 : 0;

  const DECISIONS = [
    { label: "Active",             pct: activePct,  color: "bg-blue-500" },
    { label: "Grace Period",       pct: gracePct,   color: "bg-amber-400" },
    { label: "Pending Issuance",   pct: pendingPct, color: "bg-blue-500" },
    { label: "Lapsed / Cancelled", pct: lapsedPct,  color: "bg-red-500" },
  ];

  const policiesToday = policies.filter((p) => isToday(p.created_at)).length;

  const QUICK_STATS = [
    { label: "Policies Today", value: String(policiesToday), sub: "new business" },
    { label: "Active Policies", value: policyStats ? String(policyStats.active) : "—", sub: "in force" },
    { label: "Grace Period", value: policyStats ? String(policyStats.grace_period) : "—", sub: "at risk of lapse" },
    { label: "Lapsed", value: policyStats ? String(policyStats.lapsed) : "—", sub: "non-recoverable" },
    { label: "Expiring (30d)", value: policyStats ? String(policyStats.expiring_30d) : "—", sub: "renewal due" },
  ];

  return (
    <PillarCard
      icon={<ShieldIcon />}
      title="Underwriting Risk"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
      className="h-full"
    >
      <div className="flex-1 flex flex-col justify-between space-y-2">
        {/* Top section: rings + vertical status bar chart */}
        <div className="flex flex-col sm:flex-row gap-6">

          {/* Gauges */}
          <div className="flex gap-4 flex-shrink-0">
            <RingGauge value={riskIndex} strokeHex="#1d4ed8" label="Portfolio Risk" sublabel="/ 100" size={68} strokeW={8} />
            <RingGauge value={issuanceRatePct} strokeHex="#3b82f6" label="Issuance Rate" sublabel="%" valueLabel={`${issuanceRatePct}%`} size={68} strokeW={8} />
          </div>

          {/* Policy Status Mix — Vertical Bar Chart */}
          <div className="flex-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Policy Status Mix — Selected Range</p>

            {/* Chart: fixed height container, bars bottom-aligned */}
            <div className="grid grid-cols-4 gap-2 h-[76px] items-end">
              {DECISIONS.map((d) => {
                const barH = Math.min(Math.max(d.pct, d.pct > 0 ? 8 : 0), 100);
                return (
                  <div key={d.label} className="flex flex-col items-center h-full justify-end group">
                    {/* Value label — always above the bar, never overlapping */}
                    <span className="text-[10px] font-extrabold font-mono text-slate-700 mb-1 leading-none whitespace-nowrap group-hover:text-blue-600 transition-colors">
                      {d.pct.toFixed(0)}%
                    </span>
                    {/* Bar track */}
                    <div className="w-7 bg-slate-100 rounded-t-md flex-1 flex flex-col justify-end overflow-hidden">
                      <div
                        className={`w-full rounded-t-sm ${d.color} transition-all duration-500`}
                        style={{ height: barH > 0 ? `${barH}%` : "3px", minHeight: "3px" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Labels row — separated below the chart */}
            <div className="grid grid-cols-4 gap-2 mt-2 pt-2 border-t border-slate-100">
              {DECISIONS.map((d) => (
                <div key={d.label} className="flex flex-col items-center gap-0.5">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: d.color.includes("blue") ? "#3b82f6" : d.color.includes("amber") ? "#f59e0b" : d.color.includes("red") ? "#ef4444" : "#64748b" }}
                  />
                  <span className="text-[9px] font-semibold text-slate-500 text-center leading-tight">
                    {d.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Divider className="my-2" />

        {/* Quick stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {QUICK_STATS.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} sub={s.sub} />
          ))}
        </div>
      </div>
    </PillarCard>
  );
}
