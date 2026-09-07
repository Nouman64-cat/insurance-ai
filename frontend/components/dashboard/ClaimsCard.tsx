import { RingGauge, Bar, PillarCard, Divider } from "./shared";
import type { Claim } from "@/app/services/claims";

function ClipboardIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="2" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
}

const TERMINAL = ["Approved", "Partial Approval", "Declined", "Settled", "Closed"];
const INVESTIGATING = ["Under Investigation", "Referred to Manager", "Pending Documents"];
const APPROVED_LIKE = ["Approved", "Partial Approval", "Settled"];

function isToday(dateStr: string): boolean {
  return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

export function ClaimsCard({ claims, className = "" }: { claims: Claim[]; className?: string }) {
  const total = claims.length;
  const approvedPct = total > 0 ? (claims.filter((c) => APPROVED_LIKE.includes(c.status)).length / total) * 100 : 0;
  const rejectedPct = total > 0 ? (claims.filter((c) => c.status === "Declined").length / total) * 100 : 0;
  const investigatingPct = total > 0 ? (claims.filter((c) => INVESTIGATING.includes(c.status)).length / total) * 100 : 0;

  // "AI confidence" proxied as the inverse of average fraud risk across the
  // filtered book — the closest real signal to an adjudication-confidence
  // score this app currently computes.
  const avgFraudProb = total > 0 ? claims.reduce((s, c) => s + c.fraud_probability, 0) / total : 0;
  const aiConfidencePct = Math.round((1 - avgFraudProb) * 1000) / 10;

  const claimsToday = claims.filter((c) => isToday(c.created_at)).length;

  const resolved = claims.filter((c) => TERMINAL.includes(c.status) && (c.settled_at || c.closed_at));
  const approvedSum = resolved.reduce((s, c) => s + (c.approved_amount || 0), 0);
  const avgProcessDays =
    resolved.length > 0
      ? resolved.reduce((sum, c) => {
          const end = new Date((c.settled_at || c.closed_at) as string).getTime();
          const start = new Date(c.created_at).getTime();
          return sum + Math.max(0, end - start) / 86_400_000;
        }, 0) / resolved.length
      : null;

  const fmtCompact = (v: number) => (v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`);

  return (
    <PillarCard
      icon={<ClipboardIcon />}
      title="Claims Status"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
      className={`h-full ${className}`}
    >
      <div className="flex-1 flex flex-col justify-between space-y-1">
        {/* AI Confidence ring + status bars */}
        <div className="flex items-center gap-2.5">
          <RingGauge value={aiConfidencePct} max={100} strokeHex="#2563eb" label="AI Confidence" valueLabel={`${aiConfidencePct}%`} size={44} strokeW={5} />
          <div className="flex-1 space-y-0.5 min-w-0">
            <Bar label="Approval Rate"       pct={approvedPct}     color="bg-blue-500"  badge={`${approvedPct.toFixed(0)}%`} />
            <Bar label="Rejection Rate"      pct={rejectedPct}     color="bg-red-500"   badge={`${rejectedPct.toFixed(0)}%`} />
            <Bar label="Under Investigation" pct={investigatingPct} color="bg-amber-400" badge={`${investigatingPct.toFixed(0)}%`} />
          </div>
        </div>

        <Divider className="my-1" />

        {/* Key stats */}
        <div className="grid grid-cols-3 gap-1">
          <div className="text-center">
            <p className="text-[8px] text-slate-400 font-semibold uppercase tracking-wider truncate">Claims Today</p>
            <p className="text-xs font-extrabold text-slate-800 mt-0.5">{claimsToday}</p>
            <p className="text-[8px] text-slate-400 truncate">new entries</p>
          </div>
          <div className="text-center">
            <p className="text-[8px] text-slate-400 font-semibold uppercase tracking-wider truncate">Approved</p>
            <p className="text-xs font-extrabold text-blue-600 mt-0.5">{fmtCompact(approvedSum)}</p>
            <p className="text-[8px] text-slate-400 truncate">payout</p>
          </div>
          <div className="text-center">
            <p className="text-[8px] text-slate-400 font-semibold uppercase tracking-wider truncate">Avg Process</p>
            <p className="text-xs font-extrabold text-blue-600 mt-0.5">{avgProcessDays !== null ? `${avgProcessDays.toFixed(1)}d` : "—"}</p>
            <p className="text-[8px] text-slate-400 truncate">end-to-end</p>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}
