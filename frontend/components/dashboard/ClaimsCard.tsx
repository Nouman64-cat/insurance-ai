import { RingGauge, Bar, PillarCard, Divider } from "./shared";

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

export function ClaimsCard() {
  return (
    <PillarCard
      icon={<ClipboardIcon />}
      title="Claims Intelligence"
      barClass="bg-teal-600"
      iconBg="bg-teal-50"
      iconColor="text-teal-600"
    >
      {/* AI Confidence ring + status bars */}
      <div className="flex items-start gap-4 mb-4">
        <RingGauge value={87} max={100} strokeHex="#0d9488" label="AI Confidence" sublabel="%" valueLabel="87.4%" size={82} />
        <div className="flex-1 space-y-2.5 pt-1">
          <Bar label="Approval Rate"      pct={63.8} color="bg-emerald-500" badge="63.8%" />
          <Bar label="Rejection Rate"     pct={22.1} color="bg-red-500"     badge="22.1%" />
          <Bar label="Under Investigation" pct={14.1} color="bg-amber-400"  badge="14.1%" />
        </div>
      </div>

      <Divider className="mb-3" />

      {/* Key stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Claims Today</p>
          <p className="text-xl font-extrabold text-slate-800 mt-0.5">47</p>
          <p className="text-[10px] text-slate-400">new submissions</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Approved MTD</p>
          <p className="text-xl font-extrabold text-emerald-600 mt-0.5">PKR 12.4M</p>
          <p className="text-[10px] text-slate-400">total payout</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Avg. Process</p>
          <p className="text-xl font-extrabold text-teal-600 mt-0.5">2.3d</p>
          <p className="text-[10px] text-slate-400">end-to-end</p>
        </div>
      </div>
    </PillarCard>
  );
}
