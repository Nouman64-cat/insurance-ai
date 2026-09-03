import type { ReactNode } from "react";

// ── SVG Ring Gauge ───────────────────────────────────────────────────────────

interface RingGaugeProps {
  value: number;
  max?: number;
  size?: number;
  strokeW?: number;
  strokeHex: string;
  label?: string;
  sublabel?: string;
  valueLabel?: string;
}

export function RingGauge({
  value, max = 100, size = 80, strokeW = 8,
  strokeHex, label, sublabel, valueLabel,
}: RingGaugeProps) {
  const r     = (size - strokeW * 2) / 2;
  const circ  = 2 * Math.PI * r;
  const filled = Math.min(Math.max(value / max, 0), 1) * circ;
  const displayLabel = valueLabel ?? `${value}%`;

  const len = displayLabel.length;
  let fontClass = "text-xs";
  if (size < 48) {
    fontClass = len > 4 ? "text-[8.5px]" : "text-[10px]";
  } else if (size <= 70) {
    fontClass = len > 4 ? "text-[10px]" : "text-[11.5px]";
  } else {
    fontClass = len > 4 ? "text-xs" : "text-sm";
  }

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", display: "block" }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={strokeW} />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={strokeHex} strokeWidth={strokeW} strokeLinecap="round"
            strokeDasharray={`${filled} ${circ}`}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none text-center px-1">
          <span className={`font-black text-slate-900 leading-none tracking-tighter ${fontClass}`}>
            {displayLabel}
          </span>
        </div>
      </div>
      {label && (
        <div className="text-center leading-tight">
          <p className="text-[9px] font-bold text-slate-600 uppercase tracking-wide truncate max-w-[100px]">
            {label}
          </p>
          {sublabel && sublabel !== "%" && (
            <p className="text-[8px] font-medium text-slate-400 truncate max-w-[100px]">
              {sublabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Labeled Progress Bar ─────────────────────────────────────────────────────

interface BarProps {
  label: string;
  pct: number;
  color: string;
  badge?: string;
}

export function Bar({ label, pct, color, badge }: BarProps) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-slate-600 truncate">{label}</span>
        <span className="text-[11px] font-bold text-slate-800 shrink-0 ml-1.5">{badge ?? `${pct}%`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

// ── Stat Box ─────────────────────────────────────────────────────────────────

interface StatProps {
  label: string;
  value: ReactNode;
  sub?: string;
  valueClass?: string;
}

export function Stat({ label, value, sub, valueClass = "text-slate-900" }: StatProps) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 truncate">{label}</p>
      <p className={`text-sm font-extrabold leading-snug mt-0.5 truncate ${valueClass}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-400 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// ── Alert Row ────────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium";

const SEV: Record<Severity, { dot: string; badge: string }> = {
  critical: { dot: "bg-red-500",    badge: "text-red-700 bg-red-50 border border-red-200"       },
  high:     { dot: "bg-orange-500", badge: "text-orange-700 bg-orange-50 border border-orange-200" },
  medium:   { dot: "bg-amber-400",  badge: "text-amber-700 bg-amber-50 border border-amber-200"  },
};

interface AlertRowProps {
  severity: Severity;
  label: string;
  count: ReactNode;
  detail?: string;
}

export function AlertRow({ severity, label, count, detail }: AlertRowProps) {
  const s = SEV[severity];
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />
        <div>
          <p className="text-xs font-semibold text-slate-800 leading-tight">{label}</p>
          {detail && <p className="text-[10px] text-slate-400 mt-0.5">{detail}</p>}
        </div>
      </div>
      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${s.badge}`}>{count}</span>
    </div>
  );
}

// ── Pillar Card Wrapper ──────────────────────────────────────────────────────

interface PillarCardProps {
  icon: ReactNode;
  title: string;
  barClass: string;
  iconBg: string;
  iconColor: string;
  alertCount?: number;
  hideLive?: boolean;
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function PillarCard({
  icon, title, barClass, iconBg, iconColor, alertCount, hideLive = false, headerExtra, children, className = "",
}: PillarCardProps) {
  return (
    <div className={`bg-white rounded-xl border border-slate-200 shadow-card flex flex-col overflow-hidden ${className}`}>
      <div className={`h-[3px] ${barClass}`} />
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 flex-wrap gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
            <span className={iconColor}>{icon}</span>
          </div>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">{title}</h3>
          {headerExtra}
        </div>
        <div className="flex items-center gap-1.5">
          {alertCount !== undefined && alertCount > 0 && (
            <span className="text-[9px] font-bold text-red-700 bg-red-50 border border-red-100 px-1.5 py-0.5 rounded-full">
              {alertCount} alerts
            </span>
          )}
          {!hideLive && (
            <span className="flex items-center gap-1 text-[9px] font-semibold text-blue-600">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
              Live
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 p-2.5 flex flex-col">{children}</div>
    </div>
  );
}

// ── Divider ──────────────────────────────────────────────────────────────────

export function Divider({ className = "" }: { className?: string }) {
  return <div className={`h-px bg-slate-100 ${className}`} />;
}
