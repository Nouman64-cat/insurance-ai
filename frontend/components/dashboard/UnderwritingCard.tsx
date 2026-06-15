import { RingGauge, Bar, Stat, PillarCard, Divider } from "./shared";

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

const DECISIONS = [
  { label: "Auto Approve",       pct: 42, color: "bg-emerald-500" },
  { label: "Approve w/ Loading", pct: 31, color: "bg-amber-400"   },
  { label: "Human Review",       pct: 18, color: "bg-blue-500"    },
  { label: "Decline",            pct:  9, color: "bg-red-500"     },
] as const;

const QUICK_STATS = [
  { label: "Cases Today",      value: "127",   sub: "+14 vs yesterday"      },
  { label: "Avg Med Loading",  value: "23.4%", sub: "on loaded policies"    },
  { label: "Avg Medical Risk", value: "54",    sub: "out of 100"            },
  { label: "Avg Fin. Risk",    value: "61",    sub: "out of 100"            },
  { label: "Avg Assess. Time", value: "1.8s",  sub: "end-to-end AI latency" },
] as const;

export function UnderwritingCard() {
  return (
    <PillarCard
      icon={<ShieldIcon />}
      title="Underwriting Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      {/* Top section: rings + decision bars */}
      <div className="flex flex-col sm:flex-row gap-6">

        {/* Gauges */}
        <div className="flex gap-5 flex-shrink-0">
          <RingGauge value={68} strokeHex="#1d4ed8" label="Portfolio Risk" sublabel="/ 100" size={84} strokeW={9} />
          <RingGauge value={73} strokeHex="#10b981" label="Approval Prob." sublabel="%" valueLabel="73%" size={84} strokeW={9} />
        </div>

        {/* Decision distribution */}
        <div className="flex-1 space-y-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Decision Distribution — Today</p>
          {DECISIONS.map((d) => (
            <Bar key={d.label} label={d.label} pct={d.pct} color={d.color} />
          ))}
        </div>
      </div>

      <Divider className="my-4" />

      {/* Quick stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {QUICK_STATS.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} sub={s.sub} />
        ))}
      </div>
    </PillarCard>
  );
}
