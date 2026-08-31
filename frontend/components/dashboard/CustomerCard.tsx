import { RingGauge, Bar, PillarCard, Divider } from "./shared";
import type { CommissionPayee } from "@/app/services/commissions";
import type { PolicyListItem, PolicyStats } from "@/app/services/policies";

function UsersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

const SEGMENT_LABELS: Record<string, string> = {
  individual: "Individual",
  family: "Family Takaful",
  organization: "Corporate / Group",
};

interface CustomerCardProps {
  policyStats: PolicyStats | null;
  policies: PolicyListItem[];
  payees: CommissionPayee[];
}

export function CustomerCard({ policyStats, policies, payees }: CustomerCardProps) {
  const total = policies.length;
  const segmentCounts: Record<string, number> = {};
  policies.forEach((p) => {
    const seg = p.segment || "individual";
    segmentCounts[seg] = (segmentCounts[seg] || 0) + 1;
  });
  const SEGMENTS = Object.entries(segmentCounts).map(([seg, count], i) => ({
    label: SEGMENT_LABELS[seg] || seg,
    pct: total > 0 ? Math.round((count / total) * 100) : 0,
    color: ["bg-blue-500", "bg-blue-400", "bg-slate-300"][i % 3],
  }));

  const agentPayees = payees.filter((p) => p.type === "AGENT" && p.persistency13m !== null);
  const avgPersistency =
    agentPayees.length > 0
      ? Math.round((agentPayees.reduce((s, p) => s + (p.persistency13m || 0), 0) / agentPayees.length) * 10) / 10
      : 0;

  const avgCoverage = total > 0 ? policies.reduce((s, p) => s + (p.coverage_amount || 0), 0) / total : 0;
  const fmtCompact = (v: number) => (v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`);

  const atRisk = policyStats ? policyStats.grace_period + policyStats.lapsed : 0;
  const renewalsDue = policyStats ? policyStats.expiring_30d : 0;

  return (
    <PillarCard
      icon={<UsersIcon />}
      title="Customer Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      {/* Persistency ring + segments */}
      <div className="flex items-start gap-4 mb-4">
        <RingGauge value={avgPersistency} max={100} strokeHex="#7c3aed" label="Persistency" sublabel="%" valueLabel={`${avgPersistency}%`} size={82} />
        <div className="flex-1 space-y-2.5 pt-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Portfolio Segments</p>
          {SEGMENTS.length === 0 ? (
            <p className="text-xs text-slate-400">No policies in the selected range.</p>
          ) : (
            SEGMENTS.map((s) => <Bar key={s.label} label={s.label} pct={s.pct} color={s.color} badge={`${s.pct}%`} />)
          )}
        </div>
      </div>

      <Divider className="mb-3" />

      {/* Key stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Avg Coverage</p>
          <p className="text-lg font-extrabold text-blue-700 mt-0.5">{fmtCompact(avgCoverage)}</p>
          <p className="text-[10px] text-slate-400">per policy</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">At-Risk</p>
          <p className="text-lg font-extrabold text-red-600 mt-0.5">{atRisk}</p>
          <p className="text-[10px] text-slate-400">grace period + lapsed</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Renewals Due</p>
          <p className="text-lg font-extrabold text-amber-600 mt-0.5">{renewalsDue}</p>
          <p className="text-[10px] text-slate-400">next 30 days</p>
        </div>
      </div>
    </PillarCard>
  );
}
