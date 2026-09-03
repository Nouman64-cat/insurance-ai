import { PillarCard, Divider } from "./shared";
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

const DOT: Record<string, string> = {
  critical: "bg-red-500",
  high:     "bg-orange-500",
  medium:   "bg-amber-400",
};

const BADGE: Record<string, string> = {
  critical: "text-red-700 bg-red-50 border border-red-200",
  high:     "text-orange-700 bg-orange-50 border border-orange-200",
  medium:   "text-amber-700 bg-amber-50 border border-amber-200",
};

export function FraudCard({ claims }: { claims: Claim[] }) {
  const highRisk          = claims.filter((c) => c.fraud_probability >= 0.7 && !c.duplicate_flag);
  const duplicates        = claims.filter((c) => c.duplicate_flag);
  const investigating     = claims.filter((c) => c.status === "Under Investigation");
  const reinsuranceReferred = claims.filter((c) => !!c.reinsurance_referral_id);

  const ALERTS = [
    { severity: "critical", label: "High Fraud Probability",   count: highRisk.length,           unit: "cases",   detail: "Fraud score ≥ 70%, not already flagged as duplicate" },
    { severity: "critical", label: "Duplicate Claims Flagged", count: duplicates.length,          unit: "cases",   detail: "Matched against an existing claim on the same policy" },
    { severity: "high",     label: "Under Investigation",      count: investigating.length,       unit: "flagged", detail: "Currently assigned for manual SIU review" },
    { severity: "medium",   label: "Reinsurance Referred",     count: reinsuranceReferred.length, unit: "cases",   detail: "Escalated to the facultative reinsurance desk" },
  ];

  const highRiskInQueue = claims.filter(
    (c) => (c.fraud_probability >= 0.7 || c.duplicate_flag) &&
           !["Approved", "Partial Approval", "Declined", "Settled", "Closed"].includes(c.status)
  ).length;

  const flaggedToday = claims.filter(
    (c) => isToday(c.created_at) && (c.fraud_probability >= 0.3 || c.duplicate_flag)
  ).length;

  return (
    <PillarCard
      icon={<AlertTriangleIcon />}
      title="Fraud Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
      alertCount={highRisk.length + duplicates.length}
      className="h-full"
    >
      <div className="flex-1 flex flex-col justify-between space-y-2">
        {/* Compact alert rows */}
        <div className="space-y-1 flex-1 flex flex-col justify-between">
          {ALERTS.map((a) => (
            <div key={a.label} className="flex items-center gap-2 py-2 border-b border-slate-100 last:border-0">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[a.severity]}`} />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-semibold text-slate-800 leading-tight truncate">{a.label}</p>
                <p className="text-[9px] text-slate-400 leading-tight truncate">{a.detail}</p>
              </div>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${BADGE[a.severity]}`}>
                {a.count} {a.unit}
              </span>
            </div>
          ))}
        </div>

        <Divider className="my-2" />

        {/* Footer — single compact line */}
        <div className="flex items-center justify-between text-[10px] pt-0.5">
          <span className="text-slate-500 font-medium">
            High-Risk in Queue: <strong className="text-slate-800">{highRiskInQueue} cases</strong>
          </span>
          <span className="text-slate-500 font-medium">
            Flagged Today: <strong className="text-slate-800">{flaggedToday} cases</strong>
          </span>
        </div>
      </div>
    </PillarCard>
  );
}
