"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getPolicyStats,
  getUpcomingRenewals,
  renewPolicy,
  lapsePolicy,
  UpcomingRenewal,
  PolicyStats,
  fmtPKR,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";

const URGENCY_CONFIG = {
  "90d": { label: "90 Days", color: "bg-slate-100 text-slate-600 border-slate-200", dot: "bg-slate-400", header: "bg-slate-50 border-slate-200" },
  "60d": { label: "60 Days", color: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-400", header: "bg-blue-50 border-blue-200" },
  "30d": { label: "30 Days", color: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-400", header: "bg-amber-50 border-amber-200" },
  "15d": { label: "15 Days", color: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500", header: "bg-orange-50 border-orange-200" },
  grace: { label: "Grace Period", color: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500", header: "bg-red-50 border-red-200" },
} as const;

type UrgencyKey = keyof typeof URGENCY_CONFIG;

function RenewalCard({
  renewal,
  onRenewed,
  onLapsed,
}: {
  renewal: UpcomingRenewal;
  onRenewed: () => void;
  onLapsed: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<"renew" | "lapse" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urgency = (renewal.urgency as UrgencyKey) in URGENCY_CONFIG ? (renewal.urgency as UrgencyKey) : "90d";
  const cfg = URGENCY_CONFIG[urgency];

  const handle = async (action: "renew" | "lapse") => {
    setActionLoading(action);
    setError(null);
    try {
      if (action === "renew") await renewPolicy(renewal.policy_id);
      else await lapsePolicy(renewal.policy_id);
      action === "renew" ? onRenewed() : onLapsed();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Action failed.");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className={`bg-white rounded-xl border ${urgency === "grace" ? "border-red-200 ring-1 ring-red-200/50" : "border-slate-200"} shadow-sm overflow-hidden transition-all hover:shadow-md`}>
      {/* Urgency bar */}
      <div className={`h-1 ${cfg.dot}`} />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono text-slate-500 truncate">{renewal.policy_number ?? renewal.policy_id.slice(0, 8)}</p>
            <p className="text-sm font-bold text-slate-900 mt-0.5 truncate">{renewal.product_name}</p>
          </div>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${cfg.color} shrink-0`}>
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            {cfg.label}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-slate-50 rounded-lg px-3 py-2">
            <p className="text-slate-400 text-[10px] font-medium">Sum Assured</p>
            <p className="font-bold text-slate-800 mt-0.5">{fmtCoverage(renewal.coverage_amount)}</p>
          </div>
          <div className="bg-slate-50 rounded-lg px-3 py-2">
            <p className="text-slate-400 text-[10px] font-medium">Expiry</p>
            <p className="font-bold text-slate-800 mt-0.5">{renewal.expiry_date}</p>
          </div>
          <div className="bg-slate-50 rounded-lg px-3 py-2 col-span-2">
            <p className="text-slate-400 text-[10px] font-medium">Days to Expiry</p>
            <p className={`font-bold mt-0.5 ${renewal.days_to_expiry <= 15 ? "text-red-600" : renewal.days_to_expiry <= 30 ? "text-orange-600" : "text-slate-800"}`}>
              {renewal.days_to_expiry <= 0 ? "Expired" : `${renewal.days_to_expiry} days`}
              {renewal.status === "GracePeriod" && renewal.grace_period_end_date && (
                <span className="text-red-500 text-[10px] font-normal ml-1">· Grace ends {renewal.grace_period_end_date}</span>
              )}
            </p>
          </div>
        </div>

        {/* STP badge */}
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-2.5 h-2.5"><polyline points="20 6 9 17 4 12" /></svg>
            STP Auto-Rate
          </span>
          <span className="text-[10px] text-slate-400">No claims — straight-through processing</span>
        </div>

        {error && <p className="text-[10px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => handle("renew")}
            disabled={!!actionLoading}
            className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {actionLoading === "renew" ? "Binding…" : "Bind Renewal"}
          </button>
          <button
            onClick={() => handle("lapse")}
            disabled={!!actionLoading}
            className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            {actionLoading === "lapse" ? "…" : "Lapse"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RenewalsPage() {
  const [stats, setStats] = useState<PolicyStats | null>(null);
  const [renewals, setRenewals] = useState<UpcomingRenewal[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UrgencyKey | "all">("all");

  const load = async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([getPolicyStats(), getUpcomingRenewals(90)]);
      setStats(s);
      setRenewals(r);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? renewals.filter(r =>
          (r.policy_number ?? "").toLowerCase().includes(q) ||
          r.product_name.toLowerCase().includes(q)
        )
      : renewals;
    const filtered = filter === "all" ? list : list.filter(r => r.urgency === filter);
    const groups: Record<UrgencyKey, UpcomingRenewal[]> = {
      "15d": [], "30d": [], "60d": [], "90d": [], grace: [],
    };
    for (const r of filtered) {
      const key = (r.urgency as UrgencyKey) in groups ? (r.urgency as UrgencyKey) : "90d";
      groups[key].push(r);
    }
    return groups;
  }, [renewals, search, filter]);

  const totalRenewing = renewals.length;
  const graceCount = renewals.filter(r => r.urgency === "grace").length;
  const urgentCount = renewals.filter(r => ["15d", "30d"].includes(r.urgency)).length;

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Premium Renewals</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Lifecycle pipeline for policies approaching expiry — automated re-rating, grace period management, and lapse state machine.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Renewing (90d)", value: loading ? "—" : totalRenewing, sub: "in renewal pipeline", color: "blue" },
          { title: "Urgent (≤30d)", value: loading ? "—" : urgentCount, sub: "immediate action needed", color: "orange" },
          { title: "Grace Period", value: loading ? "—" : (stats?.grace_period ?? graceCount), sub: "expired, claims honoured", color: "red" },
          { title: "Active Policies", value: loading ? "—" : (stats?.active ?? "—"), sub: "total in-force", color: "emerald" },
        ].map(k => (
          <div key={k.title} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{k.title}</p>
            <p className={`text-3xl font-bold mt-1 ${k.color === "orange" ? "text-orange-600" : k.color === "red" ? "text-red-600" : k.color === "emerald" ? "text-emerald-600" : "text-blue-600"}`}>
              {k.value}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-2">
          {(["all", "grace", "15d", "30d", "60d", "90d"] as const).map(f => {
            const cfg = f === "all" ? null : URGENCY_CONFIG[f];
            const count = f === "all" ? renewals.length : grouped[f]?.length ?? 0;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${filter === f ? (cfg ? `${cfg.color} shadow-sm` : "bg-slate-900 text-white border-slate-900") : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`}
              >
                {f === "all" ? `All (${count})` : `${cfg!.label} (${count})`}
              </button>
            );
          })}
        </div>
        <input
          type="text"
          placeholder="Search policy number or product…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
        />
      </div>

      {loading ? (
        <div className="py-16 flex justify-center"><div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" /></div>
      ) : renewals.length === 0 ? (
        <div className="py-20 flex flex-col items-center text-center bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
            <span className="text-2xl">🔄</span>
          </div>
          <p className="text-sm font-semibold text-slate-600">No policies in the renewal pipeline</p>
          <p className="text-xs text-slate-400 mt-1.5 max-w-xs">Active policies approaching expiry will appear here 90 days out.</p>
        </div>
      ) : (
        /* Pipeline columns */
        <div className="space-y-8">
          {(["grace", "15d", "30d", "60d", "90d"] as UrgencyKey[]).map(key => {
            const cfg = URGENCY_CONFIG[key];
            const cards = grouped[key];
            if (cards.length === 0 && filter !== "all" && filter !== key) return null;
            return (
              <div key={key}>
                {/* Column header */}
                <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border ${cfg.header} mb-3`}>
                  <span className={`w-2.5 h-2.5 rounded-full ${cfg.dot}`} />
                  <h3 className="text-sm font-bold text-slate-700">{cfg.label} Out</h3>
                  <span className="ml-auto text-xs font-semibold text-slate-500">{cards.length} {cards.length === 1 ? "policy" : "policies"}</span>
                </div>
                {cards.length === 0 ? (
                  <p className="text-xs text-slate-400 pl-4">No policies in this window.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {cards.map(r => (
                      <RenewalCard
                        key={r.policy_id}
                        renewal={r}
                        onRenewed={load}
                        onLapsed={load}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
