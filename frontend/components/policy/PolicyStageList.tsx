"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { listPolicies, type PolicyListItem } from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";
import { PolicyLifecycleDrawer } from "./PolicyLifecycleDrawer";
import { normStatus } from "./lifecycle";

// Which lifecycle statuses belong to each stage.
const PRE_ISSUANCE = new Set([
  "PROPOSED", "UNDERREVIEW", "INFORMATIONREQUESTED", "COUNTEROFFER",
  "APPROVED", "ACCEPTEDWITHLOADINGS", "PENDINGPAYMENT", "ISSUED",
  "POSTPONED", "REINSURERREFERRED",
]);
const POST_ISSUANCE = new Set(["ACTIVE", "GRACEPERIOD", "LAPSED", "CANCELLED"]);

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ACCEPTEDWITHLOADINGS: "bg-amber-50 text-amber-700 border-amber-200",
  COUNTEROFFER: "bg-amber-50 text-amber-700 border-amber-200",
  PENDINGPAYMENT: "bg-violet-50 text-violet-700 border-violet-200",
  ISSUED: "bg-blue-50 text-blue-700 border-blue-200",
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  GRACEPERIOD: "bg-amber-50 text-amber-700 border-amber-200",
  LAPSED: "bg-red-50 text-red-700 border-red-200",
  CANCELLED: "bg-slate-100 text-slate-600 border-slate-300",
};

interface Props {
  variant: "pre" | "post";
  title: string;
  subtitle: string;
}

/**
 * A policy list scoped to one lifecycle stage.
 *   • "pre"  — Stage A policies; a row opens the pre-issuance drawer (StageAPanel).
 *   • "post" — Stage B policies; a row routes to the post-issuance management page.
 * Both stages share this component so the two pages stay in lock-step.
 */
export function PolicyStageList({ variant, title, subtitle }: Readonly<Props>) {
  const router = useRouter();
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [drawerPolicy, setDrawerPolicy] = useState<PolicyListItem | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const all = await listPolicies();
        if (alive) setPolicies(all);
      } catch (err: any) {
        if (alive) setError(err?.response?.data?.detail ?? err?.message ?? "Failed to load policies.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const stageSet = variant === "pre" ? PRE_ISSUANCE : POST_ISSUANCE;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return policies
      .filter((p) => stageSet.has(normStatus(p.status)))
      .filter((p) => !q
        || p.customer_name?.toLowerCase().includes(q)
        || (p.policy_number ?? "").toLowerCase().includes(q)
        || p.product_name?.toLowerCase().includes(q));
  }, [policies, search, stageSet]);

  const openRow = (p: PolicyListItem) => {
    if (variant === "post") router.push(`/post-issuance/${p.id}`);
    else setDrawerPolicy(p);
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Heading */}
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wider">
            Policy Management
          </p>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
          <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-xs font-semibold text-slate-400 bg-slate-100 border border-slate-200 rounded-full px-3 py-1 flex-shrink-0">
          {rows.length} {rows.length === 1 ? "policy" : "policies"}
        </span>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, policy number or product…"
          className="w-full text-sm border border-slate-200 rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-300"
        />
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 mb-4">{error}</div>}

      {/* List */}
      {loading ? (
        <div className="py-24 flex justify-center">
          <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-emerald-500" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 py-16 text-center">
          <p className="text-sm font-semibold text-slate-500">No policies in this stage</p>
          <p className="text-xs text-slate-400 mt-1">
            {variant === "pre"
              ? "Policies appear here between underwriting approval and going in-force."
              : "Policies appear here once cover binds and the first premium is paid."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
          {rows.map((p) => (
            <button
              key={p.id}
              onClick={() => openRow(p)}
              className="w-full text-left flex items-center gap-4 px-4 py-3.5 hover:bg-slate-50 transition-colors group"
            >
              <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-500 flex-shrink-0">
                {(p.customer_name || "?").split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800 truncate">{p.customer_name}</p>
                <p className="text-[11px] text-slate-400 font-mono truncate">
                  {p.policy_number ?? "Not yet issued"} · {p.product_name}
                </p>
              </div>
              <div className="hidden sm:block text-right flex-shrink-0">
                <p className="text-xs font-semibold text-slate-700">{fmtCoverage(p.coverage_amount)}</p>
                <p className="text-[10px] text-slate-400">{p.term_years} yr term</p>
              </div>
              <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border flex-shrink-0 ${STATUS_BADGE[normStatus(p.status)] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                {p.status}
              </span>
              <span className="text-slate-300 group-hover:text-emerald-500 group-hover:translate-x-0.5 transition-all flex-shrink-0" aria-hidden>→</span>
            </button>
          ))}
        </div>
      )}

      {/* Stage A drawer (pre variant only) */}
      {drawerPolicy && (
        <PolicyLifecycleDrawer
          policyId={drawerPolicy.id}
          fallbackName={drawerPolicy.customer_name}
          onClose={() => setDrawerPolicy(null)}
        />
      )}
    </div>
  );
}
