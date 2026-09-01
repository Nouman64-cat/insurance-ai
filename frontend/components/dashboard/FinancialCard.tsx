import { Bar, PillarCard, Divider } from "./shared";
import type { Claim } from "@/app/services/claims";
import type { CommissionLedgerEntry } from "@/app/services/commissions";

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
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const h = 32, w = 100;
  const coords = points.map((v, i) => {
    const x = points.length > 1 ? (i / (points.length - 1)) * w : 0;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none">
      <polyline points={coords} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

interface FinancialCardProps {
  ledger: CommissionLedgerEntry[];
  claims: Claim[];
}

const RISK_LOW = 0.3, RISK_HIGH = 0.7;

export function FinancialCard({ ledger, claims }: FinancialCardProps) {
  const totalPremium = ledger.reduce((s, e) => s + e.collectedPremium, 0);
  const fmtCompact = (v: number) => (v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`);

  // Trailing 6-month premium trend built from the ledger's accrual dates.
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleString("en", { month: "short" }) };
  });
  const premiumByMonth = months.map((m) => ({
    ...m,
    total: ledger.filter((e) => e.accruedAt.slice(0, 7) === m.key).reduce((s, e) => s + e.collectedPremium, 0) / 1_000_000,
  }));
  const thisMonthPremium = premiumByMonth[premiumByMonth.length - 1]?.total ?? 0;
  const lastMonthPremium = premiumByMonth[premiumByMonth.length - 2]?.total ?? 0;
  const momChangePct = lastMonthPremium > 0 ? ((thisMonthPremium - lastMonthPremium) / lastMonthPremium) * 100 : 0;

  const claimsApprovedSum = claims.reduce((s, c) => s + (c.approved_amount || 0), 0);
  const lossRatioPct = totalPremium > 0 ? (claimsApprovedSum / totalPremium) * 100 : 0;

  const terminal = ["Approved", "Partial Approval", "Declined", "Settled", "Closed"];
  const closedClaims = claims.filter((c) => terminal.includes(c.status));
  const approvedClaims = claims.filter((c) => ["Approved", "Partial Approval", "Settled"].includes(c.status));
  const approvalRatePct = closedClaims.length > 0 ? (approvedClaims.length / closedClaims.length) * 100 : 0;

  const renewalPremium = ledger.filter((e) => e.premiumType === "RENEWAL").reduce((s, e) => s + e.collectedPremium, 0);
  const renewalMixPct = totalPremium > 0 ? (renewalPremium / totalPremium) * 100 : 0;

  const PORTFOLIO_METRICS = [
    { label: "Claims Loss Ratio",   pct: Math.min(lossRatioPct, 100), color: "bg-amber-500", badge: `${lossRatioPct.toFixed(1)}%` },
    { label: "Claims Approval Rate", pct: approvalRatePct,            color: "bg-blue-500",  badge: `${approvalRatePct.toFixed(1)}%` },
    { label: "Renewal Premium Mix",  pct: renewalMixPct,              color: "bg-blue-500",  badge: `${renewalMixPct.toFixed(1)}%` },
  ] as const;

  const lowRisk = claims.filter((c) => c.fraud_probability < RISK_LOW && !c.duplicate_flag).length;
  const medRisk = claims.filter((c) => c.fraud_probability >= RISK_LOW && c.fraud_probability < RISK_HIGH && !c.duplicate_flag).length;
  const highRisk = claims.filter((c) => c.fraud_probability >= RISK_HIGH || c.duplicate_flag).length;
  const riskTotal = lowRisk + medRisk + highRisk;
  const RISK_BANDS = [
    { label: "Low Risk",    pct: riskTotal > 0 ? (lowRisk / riskTotal) * 100 : 0,  color: "bg-blue-400" },
    { label: "Medium Risk", pct: riskTotal > 0 ? (medRisk / riskTotal) * 100 : 0,  color: "bg-amber-400" },
    { label: "High Risk",   pct: riskTotal > 0 ? (highRisk / riskTotal) * 100 : 0, color: "bg-red-500" },
  ];

  const healthLabel = lossRatioPct < 60 ? "Healthy" : lossRatioPct < 80 ? "Moderate Risk" : "High Risk";
  const healthClass = lossRatioPct < 60 ? "text-emerald-700 bg-emerald-50 border-emerald-200" : lossRatioPct < 80 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-red-700 bg-red-50 border-red-200";

  return (
    <PillarCard
      icon={<TrendingUpIcon />}
      title="Financial Intelligence"
      barClass="bg-blue-700"
      iconBg="bg-blue-50"
      iconColor="text-blue-700"
    >
      <div className="flex flex-col sm:flex-row gap-5">

        {/* Left: Premium trend + sparkline */}
        <div className="flex-1 space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-500">Collected Premium — This Month</p>
            <p className="text-2xl font-extrabold text-blue-800 mt-0.5">PKR {thisMonthPremium.toFixed(1)}M</p>
            <p className="text-[10px] text-blue-500 mt-0.5">{momChangePct >= 0 ? "↑" : "↓"} {Math.abs(momChangePct).toFixed(1)}% vs last month</p>
            <div className="mt-3">
              <Sparkline points={premiumByMonth.map((m) => m.total)} color="#2563eb" />
              <p className="text-[9px] text-slate-400 mt-1 text-right">6-month trend (PKR M)</p>
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
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Claims Risk Bands</p>
            <div className="space-y-2.5">
              {RISK_BANDS.map((b) => (
                <Bar key={b.label} label={b.label} pct={b.pct} color={b.color} badge={`${b.pct.toFixed(0)}%`} />
              ))}
            </div>
          </div>

          <Divider />

          <div className="space-y-3">
            <div>
              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Gross Written Premium</p>
              <p className="text-base font-extrabold text-slate-800 mt-0.5">{fmtCompact(totalPremium)}</p>
              <p className="text-[10px] text-slate-400">selected range</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest">Portfolio Health</p>
              <span className={`inline-flex items-center gap-1 mt-0.5 text-xs font-bold border px-2 py-0.5 rounded-full ${healthClass}`}>
                {healthLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}
