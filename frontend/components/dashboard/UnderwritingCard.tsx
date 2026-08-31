import { RingGauge, Bar, Stat, PillarCard, Divider } from "./shared";
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
      title="Underwriting Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      {/* Top section: rings + decision bars */}
      <div className="flex flex-col sm:flex-row gap-6">

        {/* Gauges */}
        <div className="flex gap-5 flex-shrink-0">
          <RingGauge value={riskIndex} strokeHex="#1d4ed8" label="Portfolio Risk" sublabel="/ 100" size={84} strokeW={9} />
          <RingGauge value={issuanceRatePct} strokeHex="#3b82f6" label="Issuance Rate" sublabel="%" valueLabel={`${issuanceRatePct}%`} size={84} strokeW={9} />
        </div>

        {/* Decision distribution */}
        <div className="flex-1 space-y-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Policy Status Mix — Selected Range</p>
          {DECISIONS.map((d) => (
            <Bar key={d.label} label={d.label} pct={d.pct} color={d.color} badge={`${d.pct.toFixed(0)}%`} />
          ))}
        </div>
      </div>

      <Divider className="my-4" />

      {/* Quick stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {QUICK_STATS.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} sub={s.sub} />
        ))}
      </div>
    </PillarCard>
  );
}
