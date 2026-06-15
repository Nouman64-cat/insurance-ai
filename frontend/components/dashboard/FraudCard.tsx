import { AlertRow, PillarCard, Divider } from "./shared";

function AlertTriangleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

const ALERTS = [
  { severity: "critical" as const, label: "Early Claim Detection",  count: "7 cases",    detail: "Claims filed within 90 days of policy"        },
  { severity: "critical" as const, label: "Document Forgery",       count: "3 cases",    detail: "Tamper score > 0.85 on submitted CNICs"        },
  { severity: "high"     as const, label: "Suspicious Patterns",    count: "4 flagged",  detail: "Duplicate CNIC across tenant boundaries"       },
  { severity: "medium"   as const, label: "Income Inconsistency",   count: "8 cases",    detail: "Declared income vs bank statement mismatch"    },
] as const;

export function FraudCard() {
  return (
    <PillarCard
      icon={<AlertTriangleIcon />}
      title="Fraud Intelligence"
      barClass="bg-red-600"
      iconBg="bg-red-50"
      iconColor="text-red-600"
      alertCount={14}
    >
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-red-50 border border-red-100 rounded-lg p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-red-400">Prevention Savings</p>
          <p className="text-xl font-extrabold text-red-700 mt-0.5">PKR 8.7M</p>
          <p className="text-[10px] text-red-400 mt-0.5">month-to-date</p>
        </div>
        <div className="bg-orange-50 border border-orange-100 rounded-lg p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-orange-400">Avg Fraud Score</p>
          <p className="text-xl font-extrabold text-orange-700 mt-0.5">0.73</p>
          <p className="text-[10px] text-orange-400 mt-0.5">flagged cases</p>
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
          <p className="text-base font-bold text-slate-800">14 cases</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest">Models Active</p>
          <p className="text-base font-bold text-slate-800">4 / 4</p>
        </div>
      </div>
    </PillarCard>
  );
}
