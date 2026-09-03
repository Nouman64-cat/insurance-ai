import { RingGauge, Bar, PillarCard } from "./shared";

function PulseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

interface RiskPulseCardProps {
  /** Composite portfolio risk score, 0-100 — same figure driving the KPI strip. */
  riskIndex: number;
  /** Average fraud probability across open claims, 0-1. */
  avgOpenFraudProb: number;
  /** Share of the book sitting in grace period or lapsed, 0-1. */
  atRiskPolicyShare: number;
  trend?: { value: string; direction: "up" | "down" | "neutral" };
}

const BANDS = [
  { max: 35, label: "Stable", ring: "#059669", chip: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  { max: 60, label: "Watch", ring: "#2563eb", chip: "text-blue-700 bg-blue-50 border-blue-200" },
  { max: 80, label: "Elevated", ring: "#d97706", chip: "text-amber-700 bg-amber-50 border-amber-200" },
  { max: Infinity, label: "Critical", ring: "#e11d48", chip: "text-rose-700 bg-rose-50 border-rose-200" },
];

function bandFor(score: number) {
  return BANDS.find((b) => score < b.max) ?? BANDS[BANDS.length - 1];
}

const TREND_COLOR = { up: "text-rose-600", down: "text-emerald-600", neutral: "text-slate-500" };

/** Prominent standalone risk gauge — the "AI Risk Pulse" of the executive command center. */
export function RiskPulseCard({ riskIndex, avgOpenFraudProb, atRiskPolicyShare, trend }: RiskPulseCardProps) {
  const band = bandFor(riskIndex);

  return (
    <PillarCard
      icon={<PulseIcon />}
      title="AI Risk Pulse"
      barClass="bg-blue-700"
      iconBg="bg-blue-50"
      iconColor="text-blue-700"
    >
      <div className="flex flex-col items-center text-center">
        <RingGauge
          value={riskIndex}
          strokeHex={band.ring}
          size={132}
          strokeW={12}
          valueLabel={`${Math.round(riskIndex)}`}
          sublabel="/ 100"
        />
        <span className={`mt-3 text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border ${band.chip}`}>
          {band.label}
        </span>
        {trend && (
          <p className={`mt-1.5 text-[10px] font-semibold ${TREND_COLOR[trend.direction]}`}>{trend.value}</p>
        )}
      </div>

      <div className="mt-5 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">What's driving the score</p>
        <Bar label="Open-claim fraud probability" pct={Math.round(avgOpenFraudProb * 100)} color="bg-rose-500" badge={`${Math.round(avgOpenFraudProb * 100)}%`} />
        <Bar label="Policies in grace / lapsed" pct={Math.round(atRiskPolicyShare * 100)} color="bg-amber-500" badge={`${Math.round(atRiskPolicyShare * 100)}%`} />
      </div>
    </PillarCard>
  );
}
