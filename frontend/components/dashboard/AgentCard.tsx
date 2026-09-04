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
  className?: string;
}

export function AgentCard({ payees, ledger, qualifications, className = "" }: AgentCardProps) {
  const activeAgents = payees.filter((p) => p.type === "AGENT" && p.status === "ACTIVE");
  const agentLedger  = ledger.filter((e) => e.payeeType === "AGENT");
  const commissionEarned = agentLedger.reduce((s, e) => s + e.netCommission, 0);

  const fmtCompact = (v: number) =>
    v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`;

  // Persistency
  const withPersistency = activeAgents.filter((p) => p.persistency13m !== null);
  const avgPersistency =
    withPersistency.length > 0
      ? withPersistency.reduce((s, p) => s + (p.persistency13m || 0), 0) / withPersistency.length
      : 0;

  // Licence compliance
  const today = new Date().toISOString().slice(0, 10);
  const licensed = activeAgents.filter((p) => p.licenceNo && p.licenceExpiry);
  const compliant = licensed.filter((p) => (p.licenceExpiry as string) >= today);
  const licenceCompliancePct = licensed.length > 0 ? (compliant.length / licensed.length) * 100 : 0;

  // Bonus qualification
  const bonusQualifiedAgents = qualifications.filter((q) => q.qualifies && q.payee.type === "AGENT");
  const uniqueBonusAgents = new Set(bonusQualifiedAgents.map((q) => q.payee.id));
  const bonusRatePct =
    activeAgents.length > 0 ? (uniqueBonusAgents.size / activeAgents.length) * 100 : 0;

  const topAgents = [...activeAgents]
    .sort((a, b) => b.ytdCommission - a.ytdCommission)
    .slice(0, 1)
    .map((a) => ({
      id: a.id,
      name: a.name,
      commission: fmtCompact(a.ytdCommission),
    }));

  return (
    <PillarCard
      icon={<UserCheckIcon />}
      title="Agent Performance"
      barClass="bg-amber-500"
      iconBg="bg-amber-50"
      iconColor="text-amber-600"
      className={`h-full ${className}`}
    >
      <div className="flex-1 flex flex-col justify-between space-y-1">
        {/* Commission Strip */}
        <div className="bg-amber-50/80 border border-amber-100/80 rounded-lg px-2 py-1 flex items-center justify-between">
          <div>
            <p className="text-[8px] font-bold uppercase tracking-widest text-amber-500">Commission Earned</p>
            <p className="text-xs font-extrabold text-amber-700 leading-tight">{fmtCompact(commissionEarned)}</p>
          </div>
          <div className="text-right">
            <p className="text-[8px] font-bold uppercase tracking-widest text-amber-500">Active Agents</p>
            <p className="text-[11px] font-extrabold text-amber-700">{activeAgents.length} active</p>
          </div>
        </div>

        {/* Progress Bars for Quality Metrics */}
        <div className="space-y-0.5">
          <Bar label="13m Persistency" pct={avgPersistency} color="bg-amber-500" badge={`${avgPersistency.toFixed(0)}%`} />
          <Bar label="Licence Compliance" pct={licenceCompliancePct} color="bg-blue-500" badge={`${licenceCompliancePct.toFixed(0)}%`} />
          <Bar label="Bonus Qualified" pct={bonusRatePct} color="bg-emerald-500" badge={`${bonusRatePct.toFixed(0)}%`} />
        </div>

        <Divider className="my-1" />

        {/* Key stats footer */}
        <div className="grid grid-cols-2 gap-1 text-center">
          <div>
            <p className="text-[8px] text-slate-400 font-semibold uppercase tracking-wider truncate">Top Performer</p>
            <p className="text-xs font-bold text-slate-800 truncate">{topAgents[0]?.name || "—"}</p>
          </div>
          <div>
            <p className="text-[8px] text-slate-400 font-semibold uppercase tracking-wider truncate">Bonus Eligible</p>
            <p className="text-xs font-extrabold text-emerald-600 truncate">{uniqueBonusAgents.size} agents</p>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}


