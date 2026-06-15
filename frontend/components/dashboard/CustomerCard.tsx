import { RingGauge, Bar, PillarCard, Divider } from "./shared";

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

const SEGMENTS = [
  { label: "High Value (LTV > 5M)", pct: 28, color: "bg-violet-500" },
  { label: "Standard (LTV 2–5M)",   pct: 54, color: "bg-blue-400"   },
  { label: "Entry-Level (LTV < 2M)", pct: 18, color: "bg-slate-300" },
] as const;

export function CustomerCard() {
  return (
    <PillarCard
      icon={<UsersIcon />}
      title="Customer Intelligence"
      barClass="bg-violet-600"
      iconBg="bg-violet-50"
      iconColor="text-violet-600"
    >
      {/* Persistency ring + segments */}
      <div className="flex items-start gap-4 mb-4">
        <RingGauge value={84} max={100} strokeHex="#7c3aed" label="Persistency" sublabel="%" valueLabel="84.3%" size={82} />
        <div className="flex-1 space-y-2.5 pt-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Portfolio Segments</p>
          {SEGMENTS.map((s) => (
            <Bar key={s.label} label={s.label} pct={s.pct} color={s.color} />
          ))}
        </div>
      </div>

      <Divider className="mb-3" />

      {/* Key stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Avg LTV</p>
          <p className="text-lg font-extrabold text-violet-700 mt-0.5">PKR 2.8M</p>
          <p className="text-[10px] text-slate-400">per customer</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">At-Risk</p>
          <p className="text-lg font-extrabold text-red-600 mt-0.5">12</p>
          <p className="text-[10px] text-slate-400">lapse predicted</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Renewals Due</p>
          <p className="text-lg font-extrabold text-amber-600 mt-0.5">23</p>
          <p className="text-[10px] text-slate-400">next 30 days</p>
        </div>
      </div>
    </PillarCard>
  );
}
