import type { AIDecision } from "@/lib/mock-data";

interface StatusBadgeProps {
  decision: AIDecision;
  size?: "sm" | "md" | "lg";
}

const CONFIG: Record<
  AIDecision,
  { label: string; classes: string; dot: string; icon: string }
> = {
  "Auto Approve": {
    label: "Auto Approved",
    classes: "bg-emerald-50 text-emerald-800 border border-emerald-200",
    dot: "bg-emerald-500",
    icon: "✓",
  },
  "Approve with Loading": {
    label: "Approve + Loading",
    classes: "bg-amber-50 text-amber-800 border border-amber-200",
    dot: "bg-amber-400",
    icon: "↗",
  },
  "Human Review": {
    label: "Human Review",
    classes: "bg-blue-50 text-blue-800 border border-blue-200",
    dot: "bg-blue-500",
    icon: "⚑",
  },
  Decline: {
    label: "Declined",
    classes: "bg-red-50 text-red-800 border border-red-200",
    dot: "bg-red-500",
    icon: "✕",
  },
};

const SIZE = {
  sm: "px-2 py-0.5 text-xs gap-1",
  md: "px-2.5 py-1 text-xs gap-1.5",
  lg: "px-3 py-1.5 text-sm gap-2",
};

export function StatusBadge({ decision, size = "md" }: StatusBadgeProps) {
  const cfg = CONFIG[decision];
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold tracking-wide ${cfg.classes} ${SIZE[size]}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

/** Large banner variant used in the AI Recommendation panel */
export function DecisionBanner({ decision }: { decision: AIDecision }) {
  const BANNER: Record<AIDecision, { bg: string; border: string; text: string; sub: string; icon: string }> = {
    "Auto Approve": {
      bg: "bg-emerald-50",
      border: "border-emerald-300",
      text: "text-emerald-800",
      sub: "text-emerald-600",
      icon: "✓",
    },
    "Approve with Loading": {
      bg: "bg-amber-50",
      border: "border-amber-300",
      text: "text-amber-800",
      sub: "text-amber-600",
      icon: "↗",
    },
    "Human Review": {
      bg: "bg-blue-50",
      border: "border-blue-300",
      text: "text-blue-800",
      sub: "text-blue-600",
      icon: "⚠",
    },
    Decline: {
      bg: "bg-red-50",
      border: "border-red-300",
      text: "text-red-800",
      sub: "text-red-600",
      icon: "✕",
    },
  };

  const LABEL: Record<AIDecision, string> = {
    "Auto Approve": "AUTO APPROVED",
    "Approve with Loading": "APPROVED WITH PREMIUM LOADING",
    "Human Review": "REFERRED FOR HUMAN REVIEW",
    Decline: "APPLICATION DECLINED",
  };

  const SUB: Record<AIDecision, string> = {
    "Auto Approve": "No manual intervention required. Policy may be issued.",
    "Approve with Loading": "Policy approved subject to premium adjustment.",
    "Human Review": "Composite risk falls in the 51–75 range. Senior underwriter review required.",
    Decline: "Risk profile exceeds acceptable thresholds. Application cannot proceed.",
  };

  const cfg = BANNER[decision];
  return (
    <div className={`rounded-xl border-2 ${cfg.bg} ${cfg.border} p-5`}>
      <div className="flex items-center gap-3">
        <span className={`text-3xl font-bold ${cfg.text}`}>{cfg.icon}</span>
        <div>
          <p className={`text-sm font-bold tracking-widest uppercase ${cfg.text}`}>
            {LABEL[decision]}
          </p>
          <p className={`mt-0.5 text-xs leading-relaxed ${cfg.sub}`}>{SUB[decision]}</p>
        </div>
      </div>
    </div>
  );
}
