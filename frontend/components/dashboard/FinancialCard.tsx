import { Bar, PillarCard, Divider } from "./shared";

function TrendingUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  );
}

// Simple inline sparkline using SVG polyline
function Sparkline({ points, color }: { points: number[]; color: string }) {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const h = 32, w = 100;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none">
      <polyline points={coords} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const PREMIUM_TREND = [120, 131, 118, 142, 138, 155, 143, 161, 158, 172, 168, 187];

const PORTFOLIO_METRICS = [
  { label: "Loss Ratio",         pct: 67.3, color: "bg-amber-500",   badge: "67.3%" },
  { label: "Combined Ratio",     pct: 94.2, color: "bg-blue-500",    badge: "94.2%" },
  { label: "Reserve Adequacy",   pct: 100,  color: "bg-emerald-500", badge: "112%"  },
] as const;

const RISK_BANDS = [
  { label: "Low Risk",    pct: 34, color: "bg-emerald-400" },
  { label: "Medium Risk", pct: 43, color: "bg-amber-400"   },
  { label: "High Risk",   pct: 23, color: "bg-red-500"     },
] as const;

export function FinancialCard() {
  return (
    <PillarCard
      icon={<TrendingUpIcon />}
      title="Financial Intelligence"
      barClass="bg-emerald-700"
      iconBg="bg-emerald-50"
      iconColor="text-emerald-700"
    >
      <div className="flex flex-col sm:flex-row gap-5">

        {/* Left: Premium forecast + sparkline */}
        <div className="flex-1 space-y-4">
          <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500">Premium Forecast — This Month</p>
            <p className="text-2xl font-extrabold text-emerald-800 mt-0.5">PKR 187M</p>
            <p className="text-[10px] text-emerald-500 mt-0.5">↑ 12.3% vs last month</p>
            <div className="mt-3">
              <Sparkline points={PREMIUM_TREND} color="#059669" />
              <p className="text-[9px] text-slate-400 mt-1 text-right">12-month trend (PKR M)</p>
            </div>
          </div>

          {/* Portfolio metrics */}
          <div className="space-y-2.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Key Ratios</p>
            {PORTFOLIO_METRICS.map((m) => (
              <Bar key={m.label} label={m.label} pct={m.pct} color={m.color} badge={m.badge} />
            ))}
          </div>
        </div>

        <Divider className="sm:hidden" />

        {/* Right: Portfolio risk analysis */}
        <div className="sm:w-48 flex-shrink-0 space-y-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Portfolio Risk Bands</p>
            <div className="space-y-2.5">
              {RISK_BANDS.map((b) => (
                <Bar key={b.label} label={b.label} pct={b.pct} color={b.color} />
              ))}
            </div>
          </div>

          <Divider />

          <div className="space-y-3">
            <div>
              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Gross Written Premium</p>
              <p className="text-base font-extrabold text-slate-800 mt-0.5">PKR 2.24B</p>
              <p className="text-[10px] text-slate-400">year-to-date</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Portfolio Health</p>
              <span className="inline-flex items-center gap-1 mt-0.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                Medium-High Risk
              </span>
            </div>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}
