import { RingGauge, Bar, PillarCard, Divider } from "./shared";

function FileCheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function ArtifactCard() {
  return (
    <PillarCard
      icon={<FileCheckIcon />}
      title="Artifact Intelligence"
      barClass="bg-indigo-600"
      iconBg="bg-indigo-50"
      iconColor="text-indigo-600"
      alertCount={3}
    >
      {/* OCR ring + key scores */}
      <div className="flex items-start gap-4 mb-4">
        <RingGauge value={98} max={100} strokeHex="#4f46e5" label="OCR Confidence" sublabel="%" valueLabel="98.2%" size={82} />
        <div className="flex-1 space-y-2.5 pt-1">
          <Bar label="Authenticity Score" pct={94.7} color="bg-indigo-500" badge="94.7%" />
          <Bar label="Quality Score"      pct={91.3} color="bg-violet-500"  badge="91.3%" />
          <Bar label="Auto-Accept Rate"   pct={94.4} color="bg-emerald-500" badge="94.4%" />
        </div>
      </div>

      <Divider className="mb-3" />

      {/* Count stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Processed</p>
          <p className="text-xl font-extrabold text-slate-800 mt-0.5">412</p>
          <p className="text-[10px] text-slate-400">today</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Accepted</p>
          <p className="text-xl font-extrabold text-emerald-600 mt-0.5">389</p>
          <p className="text-[10px] text-slate-400">94.4%</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Tamper Alerts</p>
          <p className="text-xl font-extrabold text-red-600 mt-0.5">3</p>
          <p className="text-[10px] text-slate-400">flagged today</p>
        </div>
      </div>
    </PillarCard>
  );
}
