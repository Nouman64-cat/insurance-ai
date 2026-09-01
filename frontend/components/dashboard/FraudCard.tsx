import { AlertRow, PillarCard, Divider } from "./shared";
import type { Claim } from "@/app/services/claims";

function AlertTriangleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function isToday(dateStr: string): boolean {
  return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

export function FraudCard({ claims }: { claims: Claim[] }) {
  const declinedOrFlagged = claims.filter((c) => c.status === "Declined" || c.fraud_probability >= 0.7 || c.duplicate_flag);
  const preventionSavings = declinedOrFlagged.reduce((s, c) => s + c.submitted_amount, 0);
  const fmtCompact = (v: number) => (v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`);

  const flagged = claims.filter((c) => c.fraud_probability >= 0.3 || c.duplicate_flag);
  const avgFraudScore = flagged.length > 0 ? flagged.reduce((s, c) => s + c.fraud_probability, 0) / flagged.length : 0;

  const highRisk = claims.filter((c) => c.fraud_probability >= 0.7 && !c.duplicate_flag);
  const duplicates = claims.filter((c) => c.duplicate_flag);
  const investigating = claims.filter((c) => c.status === "Under Investigation");
  const reinsuranceReferred = claims.filter((c) => !!c.reinsurance_referral_id);

  const ALERTS = [
    { severity: "critical" as const, label: "High Fraud Probability", count: `${highRisk.length} cases`, detail: "Fraud score ≥ 70%, not already flagged as duplicate" },
    { severity: "critical" as const, label: "Duplicate Claims Flagged", count: `${duplicates.length} cases`, detail: "Matched against an existing claim on the same policy" },
    { severity: "high" as const, label: "Under Investigation", count: `${investigating.length} flagged`, detail: "Currently assigned for manual SIU review" },
    { severity: "medium" as const, label: "Reinsurance Referred", count: `${reinsuranceReferred.length} cases`, detail: "Escalated to the facultative reinsurance desk" },
  ];

  const highRiskInQueue = claims.filter(
    (c) => (c.fraud_probability >= 0.7 || c.duplicate_flag) && !["Approved", "Partial Approval", "Declined", "Settled", "Closed"].includes(c.status)
  ).length;
  const flaggedToday = claims.filter((c) => isToday(c.created_at) && (c.fraud_probability >= 0.3 || c.duplicate_flag)).length;

  return (
    <PillarCard
      icon={<AlertTriangleIcon />}
      title="Fraud Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
      alertCount={highRisk.length + duplicates.length}
    >
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-400">Fraud-Linked Exposure</p>
          <p className="text-xl font-extrabold text-blue-700 mt-0.5">{fmtCompact(preventionSavings)}</p>
          <p className="text-[10px] text-blue-400 mt-0.5">declined + high-risk claims</p>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-400">Avg Fraud Score</p>
          <p className="text-xl font-extrabold text-blue-700 mt-0.5">{avgFraudScore.toFixed(2)}</p>
          <p className="text-[10px] text-blue-400 mt-0.5">flagged cases</p>
        </div>
      </div>

      <Divider className="mb-1" />

      {/* Alert list */}
      <div>
        {ALERTS.map((a) => (
          <AlertRow key={a.label} severity={a.severity} label={a.label} count={a.count} detail={a.detail} />
        ))}
      </div>

      <Divider className="my-3" />

      {/* Footer stats */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest">High-Risk in Queue</p>
          <p className="text-base font-bold text-slate-800">{highRiskInQueue} cases</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest">Flagged Today</p>
          <p className="text-base font-bold text-slate-800">{flaggedToday} cases</p>
        </div>
      </div>
    </PillarCard>
  );
}
