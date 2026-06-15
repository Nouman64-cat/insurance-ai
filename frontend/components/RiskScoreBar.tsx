interface RiskScoreBarProps {
  label: string;
  score: number;    // 0–100 (always normalised — pass fraudProbability * 100 for fraud)
  valueLabel?: string; // overrides default "score / 100" display
  showTier?: boolean;
  size?: "sm" | "md";
}

function scoreColor(score: number) {
  if (score <= 25) return "bg-emerald-500";
  if (score <= 50) return "bg-amber-400";
  if (score <= 75) return "bg-orange-500";
  return "bg-red-600";
}

function scoreTier(score: number) {
  if (score <= 25) return { label: "Low Risk",      color: "text-emerald-700" };
  if (score <= 50) return { label: "Moderate Risk", color: "text-amber-700"   };
  if (score <= 75) return { label: "Elevated Risk", color: "text-orange-700"  };
  return              { label: "High Risk",      color: "text-red-700"     };
}

export function RiskScoreBar({
  label,
  score,
  valueLabel,
  showTier = true,
  size = "md",
}: RiskScoreBarProps) {
  const pct = Math.min(Math.max(score, 0), 100);
  const tier = scoreTier(pct);
  const barH = size === "sm" ? "h-1.5" : "h-2.5";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <div className="flex items-center gap-2">
          {showTier && (
            <span className={`text-xs font-medium ${tier.color}`}>{tier.label}</span>
          )}
          <span className="text-sm font-bold text-slate-900 tabular-nums">
            {valueLabel ?? (
              <>
                {pct}
                <span className="text-slate-400 font-normal text-xs"> / 100</span>
              </>
            )}
          </span>
        </div>
      </div>
      <div className={`w-full ${barH} rounded-full bg-slate-100 overflow-hidden`}>
        <div
          className={`${barH} rounded-full ${scoreColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Large composite score ring used in the Case 360 recommendation panel */
export function CompositeScoreRing({ score }: { score: number }) {
  const tier = scoreTier(score);
  const ringColor =
    score <= 25 ? "border-emerald-500" :
    score <= 50 ? "border-amber-400"   :
    score <= 75 ? "border-orange-500"  :
                  "border-red-600";

  return (
    <div className="flex items-center gap-5">
      <div
        className={`relative w-24 h-24 rounded-full border-[6px] ${ringColor} flex items-center justify-center flex-shrink-0`}
      >
        <div className="text-center">
          <span className="block text-2xl font-extrabold text-slate-900 leading-none">
            {score}
          </span>
          <span className="block text-xs text-slate-400 mt-0.5">/ 100</span>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Composite Risk Score
        </p>
        <p className={`text-lg font-bold mt-0.5 ${tier.color}`}>{tier.label}</p>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed max-w-xs">
          Weighted aggregate: medical × 0.40 + financial × 0.35 + fraud × 0.25
        </p>
      </div>
    </div>
  );
}
