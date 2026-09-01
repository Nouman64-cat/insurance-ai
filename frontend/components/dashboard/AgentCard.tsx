import { Bar, PillarCard, Divider } from "./shared";
import type { CommissionLedgerEntry, IncentiveQualification, CommissionPayee } from "@/app/services/commissions";

function UserCheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  );
}

interface AgentCardProps {
  payees: CommissionPayee[];
  ledger: CommissionLedgerEntry[];
  qualifications: IncentiveQualification[];
}

export function AgentCard({ payees, ledger, qualifications }: AgentCardProps) {
  const activeAgents = payees.filter((p) => p.type === "AGENT" && p.status === "ACTIVE");
  const agentLedger = ledger.filter((e) => e.payeeType === "AGENT");
  const commissionEarned = agentLedger.reduce((s, e) => s + e.netCommission, 0);
  const avgPerAgent = activeAgents.length > 0 ? commissionEarned / activeAgents.length : 0;
  const casesPerAgent = activeAgents.length > 0 ? agentLedger.length / activeAgents.length : 0;

  const fmtCompact = (v: number) => (v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`);

  const withPersistency = activeAgents.filter((p) => p.persistency13m !== null);
  const avgPersistency = withPersistency.length > 0 ? withPersistency.reduce((s, p) => s + (p.persistency13m || 0), 0) / withPersistency.length : 0;

  const today = new Date().toISOString().slice(0, 10);
  const licensed = activeAgents.filter((p) => p.licenceNo && p.licenceExpiry);
  const compliant = licensed.filter((p) => (p.licenceExpiry as string) >= today);
  const licenceCompliancePct = licensed.length > 0 ? (compliant.length / licensed.length) * 100 : 0;

  const bonusQualifiedAgents = qualifications.filter((q) => q.qualifies && q.payee.type === "AGENT");
  const uniqueBonusAgents = new Set(bonusQualifiedAgents.map((q) => q.payee.id));
  const bonusRatePct = activeAgents.length > 0 ? (uniqueBonusAgents.size / activeAgents.length) * 100 : 0;

  const QUALITY_METRICS = [
    { label: "Avg 13-Month Persistency", pct: avgPersistency,       color: "bg-amber-500", badge: `${avgPersistency.toFixed(1)}%` },
    { label: "Licence Compliance",       pct: licenceCompliancePct, color: "bg-blue-500",  badge: `${licenceCompliancePct.toFixed(0)}%` },
    { label: "Bonus Qualification Rate", pct: bonusRatePct,         color: "bg-emerald-500", badge: `${bonusRatePct.toFixed(0)}%` },
  ];

  const agentCaseCounts = new Map<string, number>();
  agentLedger.forEach((e) => agentCaseCounts.set(e.payeeId, (agentCaseCounts.get(e.payeeId) || 0) + 1));

  const topAgents = [...activeAgents]
    .sort((a, b) => b.ytdCommission - a.ytdCommission)
    .slice(0, 3)
    .map((a) => ({
      id: a.id,
      name: a.name,
      score: a.persistency13m ?? 0,
      commission: fmtCompact(a.ytdCommission),
      cases: agentCaseCounts.get(a.id) || 0,
    }));

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
            <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-500">Commission Earned — Selected Range</p>
            <p className="text-2xl font-extrabold text-amber-700 mt-0.5">{fmtCompact(commissionEarned)}</p>
            <div className="flex gap-4 mt-2">
              <div>
                <p className="text-[10px] text-amber-400">Active Agents</p>
                <p className="text-sm font-bold text-amber-700">{activeAgents.length}</p>
              </div>
              <div>
                <p className="text-[10px] text-amber-400">Avg / Agent</p>
                <p className="text-sm font-bold text-amber-700">{fmtCompact(avgPerAgent)}</p>
              </div>
              <div>
                <p className="text-[10px] text-amber-400">Cases / Agent</p>
                <p className="text-sm font-bold text-amber-700">{casesPerAgent.toFixed(1)}</p>
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
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">Top Performers (YTD)</p>
          <div className="space-y-0">
            {topAgents.length === 0 ? (
              <p className="text-xs text-slate-400 py-2">No active agents yet.</p>
            ) : (
              topAgents.map((a, i) => (
                <div key={a.id} className="flex items-center gap-2.5 py-2.5 border-b border-slate-100 last:border-0">
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold flex-shrink-0 ${
                    i === 0 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
                  }`}>
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-800 truncate">{a.name}</p>
                    <p className="text-[10px] text-slate-400">{a.cases} cases (range) · {a.commission} YTD</p>
                  </div>
                  <span className="text-xs font-extrabold text-amber-600">{a.score}</span>
                </div>
              ))
            )}
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Bonus Eligible</p>
            <p className="text-base font-extrabold text-blue-600 mt-0.5">{uniqueBonusAgents.size} agents</p>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}
