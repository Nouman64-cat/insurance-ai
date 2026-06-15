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
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-5">

      {/* ── Dashboard title bar ──────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full">
              Adamjee Life Assurance Co. Ltd.
            </span>
            <span className="hidden sm:inline text-[10px] text-slate-400 font-medium">— Strictly Confidential</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight leading-tight">
            Management Intelligence Dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            AI-powered underwriting command centre
            &nbsp;·&nbsp;
            <span className="font-semibold text-slate-700">15 June 2026, 22:30 PKT</span>
            &nbsp;·&nbsp;
            <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              All systems operational
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1.5">
            <DownloadIcon />
            Export PDF
          </button>
          <button className="px-3 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors shadow-sm flex items-center gap-1.5">
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </div>

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

// ── Micro-icons (inline SVG — zero new dependencies) ────────────────────────

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}
