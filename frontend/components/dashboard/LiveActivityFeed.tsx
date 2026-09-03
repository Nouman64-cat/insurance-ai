import { PillarCard } from "./shared";
import type { PolicyListItem } from "@/app/services/policies";
import type { Claim } from "@/app/services/claims";

function BoltIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

const CLAIM_APPROVED_LIKE = ["Approved", "Partial Approval", "Settled"];

interface ActivityEvent {
  key: string;
  dot: string;
  label: string;
  detail: string;
  at: string;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

interface LiveActivityFeedProps {
  policies: PolicyListItem[];
  claims: Claim[];
  limit?: number;
}

/** Merged, timestamp-sorted feed of the most recent policy and claim events — the command center's pulse. */
export function LiveActivityFeed({ policies, claims, limit = 8 }: LiveActivityFeedProps) {
  const events: ActivityEvent[] = [
    ...policies.map((p): ActivityEvent => ({
      key: `policy-${p.id}`,
      dot: "bg-blue-500",
      label: "Policy Issued",
      detail: `#${p.policy_number ?? p.id.slice(0, 8)} — ${p.customer_name}`,
      at: p.created_at,
    })),
    ...claims.map((c): ActivityEvent => ({
      key: `claim-${c.id}`,
      dot: CLAIM_APPROVED_LIKE.includes(c.status) ? "bg-emerald-500" : "bg-rose-500",
      label: CLAIM_APPROVED_LIKE.includes(c.status) ? "Claim Settled" : "Claim Filed",
      detail: `#${c.claim_number} — ${c.claim_type}`,
      at: c.created_at,
    })),
  ]
    .filter((e) => !!e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);

  return (
    <PillarCard
      icon={<BoltIcon />}
      title="Live Activity"
      barClass="bg-emerald-500"
      iconBg="bg-emerald-50"
      iconColor="text-emerald-600"
      headerExtra={
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-600">
          <span className="relative flex w-1.5 h-1.5">
            <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500" />
          </span>
          Live
        </span>
      }
    >
      {events.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">No activity yet in the selected range.</p>
      ) : (
        <div className="space-y-0.5">
          {events.map((e) => (
            <div key={e.key} className="flex items-center gap-2.5 py-2 border-b border-slate-100 last:border-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${e.dot}`} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-800 truncate">
                  {e.label} <span className="font-normal text-slate-500">{e.detail}</span>
                </p>
              </div>
              <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">{formatRelativeTime(e.at)}</span>
            </div>
          ))}
        </div>
      )}
    </PillarCard>
  );
}
