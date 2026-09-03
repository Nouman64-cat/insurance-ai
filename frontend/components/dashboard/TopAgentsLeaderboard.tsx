import { PillarCard } from "./shared";
import type { CommissionPayee, CommissionLedgerEntry } from "@/app/services/commissions";

function TrophyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z" />
      <path d="M17 5h2.5a1.5 1.5 0 010 3H17M7 5H4.5a1.5 1.5 0 000 3H7" />
    </svg>
  );
}

function initials(name: string): string {
  return name.split(" ").map((n) => n[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "—";
}

const RANK_BADGE = [
  "bg-amber-400 text-amber-950",
  "bg-slate-300 text-slate-700",
  "bg-orange-300 text-orange-900",
];

interface TopAgentsLeaderboardProps {
  payees: CommissionPayee[];
  ledger: CommissionLedgerEntry[];
}

/** Named, per-agent ranking — the executive command center's "who's producing" view. */
export function TopAgentsLeaderboard({ payees, ledger }: TopAgentsLeaderboardProps) {
  const payeeById = new Map(payees.map((p) => [p.id, p]));
  const agentLedger = ledger.filter((e) => e.payeeType === "AGENT");

  const commissionByAgent = new Map<string, number>();
  agentLedger.forEach((e) => {
    commissionByAgent.set(e.payeeId, (commissionByAgent.get(e.payeeId) || 0) + e.netCommission);
  });

  const ranked = Array.from(commissionByAgent.entries())
    .map(([payeeId, commission]) => ({ payee: payeeById.get(payeeId), commission }))
    .filter((r): r is { payee: CommissionPayee; commission: number } => !!r.payee && r.commission > 0)
    .sort((a, b) => b.commission - a.commission)
    .slice(0, 6);

  const maxCommission = Math.max(...ranked.map((r) => r.commission), 1);
  const fmtCompact = (v: number) => (v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`);

  return (
    <PillarCard
      icon={<TrophyIcon />}
      title="Top Agents"
      barClass="bg-amber-500"
      iconBg="bg-amber-50"
      iconColor="text-amber-600"
      headerExtra={<span className="text-[10px] font-semibold text-slate-400">Selected range</span>}
    >
      {ranked.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">No commission activity yet in the selected range.</p>
      ) : (
        <div className="space-y-1">
          {ranked.map((r, i) => {
            const widthPct = Math.min((r.commission / maxCommission) * 100, 100);
            return (
              <div key={r.payee.id} className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${RANK_BADGE[i] ?? "bg-slate-100 text-slate-500"}`}>
                  {i + 1}
                </span>
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold shrink-0 ring-2 ring-white shadow-sm">
                  {initials(r.payee.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-slate-800 truncate">{r.payee.name}</p>
                    <p className="text-xs font-extrabold text-slate-900 font-mono tabular-nums shrink-0">{fmtCompact(r.commission)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <p className="text-[10px] text-slate-400 truncate">{r.payee.branch || "Unassigned branch"}</p>
                  </div>
                  <div className="h-1 rounded-full bg-slate-100 overflow-hidden mt-1">
                    <div className="h-full rounded-full bg-amber-500 transition-all duration-500" style={{ width: `${widthPct}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PillarCard>
  );
}
