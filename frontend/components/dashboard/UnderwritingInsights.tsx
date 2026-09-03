import { PillarCard } from "./shared";
import { worstLossRatioLine } from "@/lib/underwriting";
import type { PolicyStats } from "@/app/services/policies";

function SparkleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 4.9L19 9.8l-5.1 1.9L12 16.6l-1.9-4.9L5 9.8l5.1-1.9L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  );
}

type InsightSeverity = "critical" | "warning" | "success";

const SEVERITY_STYLE: Record<InsightSeverity, { dot: string; badge: string; icon: string }> = {
  critical: { dot: "bg-rose-500", badge: "text-rose-700 bg-rose-50 border border-rose-100", icon: "text-rose-600" },
  warning: { dot: "bg-amber-400", badge: "text-amber-700 bg-amber-50 border border-amber-100", icon: "text-amber-600" },
  success: { dot: "bg-emerald-500", badge: "text-emerald-700 bg-emerald-50 border border-emerald-100", icon: "text-emerald-600" },
};

function SeverityIcon({ severity }: { severity: InsightSeverity }) {
  if (severity === "success") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

interface Insight {
  key: string;
  severity: InsightSeverity;
  text: string;
}

interface UnderwritingInsightsProps {
  policyStats: PolicyStats | null;
  issuanceVelocity?: { value: string; direction: "up" | "down" | "neutral" };
}

/** Auto-generated, plain-English read on the portfolio — the "why" behind the numbers elsewhere on the screen. */
export function UnderwritingInsights({ policyStats, issuanceVelocity }: UnderwritingInsightsProps) {
  const insights: Insight[] = [];

  if (policyStats && policyStats.total > 0) {
    const atRisk = policyStats.grace_period + policyStats.lapsed;
    const atRiskSharePct = (atRisk / policyStats.total) * 100;
    if (atRiskSharePct >= 15) {
      insights.push({ key: "lapse", severity: "critical", text: `High lapse risk: ${atRisk} ${atRisk === 1 ? "policy is" : "policies are"} in grace period or lapsed.` });
    } else if (atRiskSharePct >= 8) {
      insights.push({ key: "lapse", severity: "warning", text: `${atRisk} ${atRisk === 1 ? "policy" : "policies"} sitting in grace period or lapsed — worth a retention push.` });
    }

    if (policyStats.expiring_30d > 0) {
      insights.push({ key: "renewals", severity: "warning", text: `${policyStats.expiring_30d} ${policyStats.expiring_30d === 1 ? "policy expires" : "policies expire"} within 30 days.` });
    }
  }

  const worstLob = worstLossRatioLine();
  if (worstLob.lossRatio >= 45) {
    insights.push({ key: "lob", severity: "critical", text: `${worstLob.name} loss ratio elevated at ${worstLob.lossRatio}% — review pricing.` });
  } else if (worstLob.lossRatio >= 38) {
    insights.push({ key: "lob", severity: "warning", text: `${worstLob.name} loss ratio at ${worstLob.lossRatio}%, trending toward the review threshold.` });
  }

  if (issuanceVelocity) {
    if (issuanceVelocity.direction === "up") {
      insights.push({ key: "velocity", severity: "success", text: `Issuance velocity ${issuanceVelocity.value} — new business is accelerating.` });
    } else if (issuanceVelocity.direction === "down") {
      insights.push({ key: "velocity", severity: "warning", text: `Issuance velocity ${issuanceVelocity.value} vs the prior period.` });
    }
  }

  if (insights.length === 0) {
    insights.push({ key: "clear", severity: "success", text: "No elevated risk signals in the selected range — portfolio is tracking within normal bounds." });
  }

  return (
    <PillarCard
      icon={<SparkleIcon />}
      title="AI Underwriting Insights"
      barClass="bg-violet-500"
      iconBg="bg-violet-50"
      iconColor="text-violet-600"
    >
      <div className="space-y-2">
        {insights.slice(0, 4).map((insight) => {
          const s = SEVERITY_STYLE[insight.severity];
          return (
            <div key={insight.key} className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 ${s.badge}`}>
              <span className={`mt-0.5 shrink-0 ${s.icon}`}>
                <SeverityIcon severity={insight.severity} />
              </span>
              <p className="text-xs leading-snug font-medium">{insight.text}</p>
            </div>
          );
        })}
      </div>
    </PillarCard>
  );
}
