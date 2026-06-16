import { MetricCard }       from "@/components/MetricCard";
import { UnderwritingCard } from "@/components/dashboard/UnderwritingCard";
import { FraudCard }        from "@/components/dashboard/FraudCard";
import { ArtifactCard }     from "@/components/dashboard/ArtifactCard";
import { ClaimsCard }       from "@/components/dashboard/ClaimsCard";
import { CustomerCard }     from "@/components/dashboard/CustomerCard";
import { AgentCard }        from "@/components/dashboard/AgentCard";
import { FinancialCard }    from "@/components/dashboard/FinancialCard";

// ── Top-level executive KPIs ─────────────────────────────────────────────────

const KPIs = [
  {
    title:    "Cases Evaluated Today",
    value:    "127",
    subtitle: "across all underwriting queues",
    accent:   "blue"    as const,
    trend:    { value: "+14 vs yesterday",      direction: "up"      as const },
  },
  {
    title:    "Portfolio Risk Index",
    value:    "68 / 100",
    subtitle: "composite AI risk score",
    accent:   "amber"   as const,
    trend:    { value: "stable (±1 pt vs prior)", direction: "neutral" as const },
  },
  {
    title:    "Premium Collected MTD",
    value:    "PKR 143M",
    subtitle: "month-to-date collections",
    accent:   "emerald" as const,
    trend:    { value: "+12.3% vs last month",  direction: "up"      as const },
  },
  {
    title:    "Fraud Savings MTD",
    value:    "PKR 8.7M",
    subtitle: "blocked by AI detection",
    accent:   "red"     as const,
    trend:    { value: "14 cases prevented",    direction: "up"      as const },
  },
] as const;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPIs.map((k) => (
          <MetricCard
            key={k.title}
            title={k.title}
            value={k.value}
            subtitle={k.subtitle}
            accent={k.accent}
            trend={k.trend}
          />
        ))}
      </div>

      {/* ── Row 1: Underwriting (7/12) + Fraud (5/12) ────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7"><UnderwritingCard /></div>
        <div className="lg:col-span-5"><FraudCard /></div>
      </div>

      {/* ── Row 2: Artifact · Claims · Customer (equal thirds) ───────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ArtifactCard />
        <ClaimsCard   />
        <CustomerCard />
      </div>

      {/* ── Row 3: Agent · Financial (equal halves) ──────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AgentCard    />
        <FinancialCard />
      </div>

      {/* ── Footer disclaimer ─────────────────────────────────────────────── */}
      <p className="text-center text-[10px] text-slate-400 pb-2 leading-relaxed">
        All metrics are AI-generated simulations for demonstration purposes only.
        Data auto-refreshes every 60 seconds.
        &nbsp;·&nbsp; Model suite: <span className="font-mono">insurance-ai v0.1.0-proto</span>
        &nbsp;·&nbsp; Adamjee Life Assurance Co. Ltd. — Internal Use Only
      </p>

    </div>
  );
}
