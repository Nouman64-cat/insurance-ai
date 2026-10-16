"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { displayDate } from "../../../lib/dateDisplay";
import {
  listCases,
  listTrackUnderwriters,
  updateUnderwritingTrack,
  type CaseQueueItem,
  type CustomerSegment,
  type TrackUnderwriter,
  type UnderwritingReview,
  type UnderwritingReviewStatus,
  type UnderwritingTrack,
} from "@/app/services/cases";
import { fmtCoverage } from "@/lib/mock-data";
import { useCaseEvents } from "@/lib/agent/useCaseEvents";
import { underwritingUrl } from "@/lib/appLinks";
import { useNewArrivals, recentIds, NewArrivalsBanner, NEW_ARRIVAL_CLASS, scrollToFirstNew } from "@/lib/useNewArrivals";
import { Pagination, usePagination } from "@/components/Pagination";
import RowActionsMenu, { type RowAction } from "@/components/RowActionsMenu";
import { useNotify } from "@/components/NotificationContext";
import { tx } from "@/lib/i18n/tx";

// ── The admin's view of underwriting ─────────────────────────────────────────
// Every underwriting application with its two reviews side by side: the medical
// review (Medical Underwriter) and the financial review (Financial Underwriter).
// The underwriters do the work in the Underwriting Workbench; this page is where
// an Admin sees where each application stands and who has it.

type SegmentFilter = "all" | CustomerSegment;
type Stage = "NOT_STARTED" | "IN_REVIEW" | "REFERRED" | "CLEARED" | "DECLINED";

const PENDING: UnderwritingReview = { status: "PENDING", assigned_user_id: null, assigned_user_name: null, note: null, updated_at: null };

const REVIEW_LABEL: Record<UnderwritingReviewStatus, string> = {
  PENDING: "Not started",
  IN_REVIEW: "In review",
  CLEARED: "Cleared",
  REFERRED: "Referred",
  DECLINED: "Declined",
};

const REVIEW_BADGE: Record<UnderwritingReviewStatus, string> = {
  PENDING: "bg-slate-50 text-slate-500 ring-slate-500/15",
  IN_REVIEW: "bg-blue-50 text-blue-700 ring-blue-600/15",
  CLEARED: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  REFERRED: "bg-amber-50 text-amber-800 ring-amber-600/20",
  DECLINED: "bg-rose-50 text-rose-700 ring-rose-600/15",
};

const STAGES: { id: Stage | "ALL"; label: string; dot: string }[] = [
  { id: "ALL", label: "All", dot: "bg-slate-400" },
  { id: "NOT_STARTED", label: "Not started", dot: "bg-slate-400" },
  { id: "IN_REVIEW", label: "In review", dot: "bg-blue-500" },
  { id: "REFERRED", label: "Referred", dot: "bg-amber-400" },
  { id: "CLEARED", label: "Cleared", dot: "bg-emerald-500" },
  { id: "DECLINED", label: "Declined", dot: "bg-rose-500" },
];

const AI_BADGE: Record<string, string> = {
  "Auto Approve": "text-emerald-700",
  "Approve with Loading": "text-amber-700",
  "Human Review": "text-blue-700",
  Decline: "text-rose-700",
};

const medical = (c: CaseQueueItem) => c.medical_review ?? PENDING;
const financial = (c: CaseQueueItem) => c.financial_review ?? PENDING;

/** One state for the application, from its two reviews: a decline or a referral on either wins; cleared needs both. */
function stageOf(c: CaseQueueItem): Stage {
  const both = [medical(c).status, financial(c).status];
  if (both.includes("DECLINED") || c.caseStatus === "Rejected") return "DECLINED";
  if (both.includes("REFERRED")) return "REFERRED";
  if (both.every((s) => s === "CLEARED")) return "CLEARED";
  if (both.every((s) => s === "PENDING")) return "NOT_STARTED";
  return "IN_REVIEW";
}

/** The six pre-underwriting clearance gates, and whether each is through. */
function gatesOf(c: CaseQueueItem): { label: string; done: boolean }[] {
  return [
    { label: "E-application", done: c.e_application_status === "Submitted" || c.e_application_status === "Verified" },
    { label: "Agent's report", done: c.acr_status === "Submitted" || c.acr_status === "Waived" },
    { label: "Compliance", done: c.compliance_status === "Passed" },
    { label: "Initial premium", done: c.ipp_status === "Realized" },
    { label: "Insurance history", done: c.insurance_history_status === "Clear" },
    { label: "Medical exam", done: ["NotRequired", "Completed", "Waived"].includes(c.medical_exam_status ?? "") },
  ];
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";

function ReviewCell({ review }: { review: UnderwritingReview }) {
  return (
    <div className="flex flex-col items-start gap-1" title={review.note ?? undefined}>
      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${REVIEW_BADGE[review.status]}`}>
        {tx(REVIEW_LABEL[review.status])}
      </span>
      {review.assigned_user_name ? (
        <span className="text-[11px] text-slate-500 truncate max-w-[160px]">{review.assigned_user_name}</span>
      ) : review.status === "CLEARED" || review.status === "DECLINED" ? null : (
        <span className="text-[11px] text-amber-700">{tx("Unassigned")}</span>
      )}
    </div>
  );
}

function GatesCell({ c }: { c: CaseQueueItem }) {
  const gates = gatesOf(c);
  const done = gates.filter((g) => g.done).length;
  return (
    <div title={gates.map((g) => `${g.done ? "✓" : "○"} ${tx(g.label)}`).join("\n")}>
      <div className="flex gap-0.5">
        {gates.map((g) => (
          <span key={g.label} className={`h-1.5 w-5 rounded-full ${g.done ? "bg-emerald-500" : "bg-slate-200"}`} />
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{tx("{0} of 6 cleared", { 0: done })}</p>
    </div>
  );
}

function AssignDialog({
  target, underwriters, onClose, onSaved,
}: {
  target: { c: CaseQueueItem; track: UnderwritingTrack };
  underwriters: TrackUnderwriter[];
  onClose: () => void;
  onSaved: (review: UnderwritingReview) => void;
}) {
  const { notify } = useNotify();
  const current = target.track === "medical" ? medical(target.c) : financial(target.c);
  const eligible = underwriters.filter((u) => u.tracks.includes(target.track));
  const [userId, setUserId] = useState(current.assigned_user_id ?? "");
  const [saving, setSaving] = useState(false);
  const trackLabel = target.track === "medical" ? tx("Medical") : tx("Financial");
  const roleLabel = target.track === "medical" ? tx("Medical Underwriter") : tx("Financial Underwriter");

  const save = async () => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setSaving(true);
    try {
      const review = await updateUnderwritingTrack(
        tenantId, target.c.caseld, target.track,
        userId ? { assigned_user_id: userId } : { clear_assignee: true },
      );
      onSaved(review);
    } catch (err: any) {
      notify(err?.response?.data?.detail ?? tx("Could not save the assignment."), false);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-bold text-slate-900">{tx("Assign {0} underwriter", { 0: trackLabel.toLowerCase() })}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{target.c.customer_name} · <span className="font-mono">{target.c.caseNumber}</span></p>
        </div>
        <div className="space-y-2 px-5 py-4 max-h-[50vh] overflow-y-auto">
          {eligible.length === 0 ? (
            <p className="text-sm text-slate-500">
              {tx("No {0}s yet. Add a user with that role in User Management.", { 0: roleLabel })}
            </p>
          ) : (
            [{ id: "", full_name: tx("Unassigned"), role: "", email: "" } as Pick<TrackUnderwriter, "id" | "full_name" | "role" | "email">, ...eligible].map((u) => (
              <label
                key={u.id || "none"}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${userId === u.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}
              >
                <input type="radio" name="assignee" className="accent-blue-600" checked={userId === u.id} onChange={() => setUserId(u.id)} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">{u.full_name}</span>
                  {u.id && <span className="block text-[11px] text-slate-400">{u.role} · {u.email}</span>}
                </span>
              </label>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            {tx("Cancel")}
          </button>
          <button
            onClick={save}
            disabled={saving || eligible.length === 0 || userId === (current.assigned_user_id ?? "")}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? tx("Saving…") : tx("Save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function AdminUnderwritingPage() {
  const { notify } = useNotify();
  const [role, setRole] = useState<string | null>(null);
  const [cases, setCases] = useState<CaseQueueItem[]>([]);
  const [underwriters, setUnderwriters] = useState<TrackUnderwriter[]>([]);
  const [loading, setLoading] = useState(true);
  const arrivalIds = useMemo(() => cases.map((c) => c.caseld), [cases]);
  const arrivals = useNewArrivals("admin-underwriting", arrivalIds, !loading, recentIds(cases, (c) => c.caseld, (c) => c.createdAt));
  const [error, setError] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [stage, setStage] = useState<Stage | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [assigning, setAssigning] = useState<{ c: CaseQueueItem; track: UnderwritingTrack } | null>(null);

  const load = async (silent = false) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError(tx("No active organization tenant found."));
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const [rows, uws] = await Promise.all([
        listCases(tenantId, "Underwriting"),
        listTrackUnderwriters(tenantId).catch(() => [] as TrackUnderwriter[]),
      ]);
      setCases(rows);
      setUnderwriters(uws);
      setError("");
    } catch (err: any) {
      if (!silent) setError(err?.response?.data?.detail ?? err?.message ?? tx("Failed to load applications."));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    const r = localStorage.getItem("user_role");
    setRole(r);
    if (r === "Admin" || r === "SuperAdmin") load();
    else setLoading(false);
  }, []);

  // Live: an underwriter picking up or clearing a review in the workbench updates this page in place.
  useCaseEvents(
    (evt) => {
      const resource = evt.event_type === "DataChanged" ? (evt.detail?.resource as string | undefined) : undefined;
      if (resource === "cases" || evt.case_id) load(true);
    },
    role === "Admin" || role === "SuperAdmin",
    () => load(true),
  );

  // Search first (the segment tabs count from this), then the segment; the stage pills count from `scoped`.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter((c) =>
      [c.customer_name, c.customer_cnic, c.caseNumber, c.product_name, medical(c).assigned_user_name, financial(c).assigned_user_name]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [cases, search]);
  const scoped = useMemo(
    () => (segment === "all" ? searched : searched.filter((c) => (c.customer_segment ?? "individual") === segment)),
    [searched, segment],
  );

  const filtered = useMemo(() => (stage === "ALL" ? scoped : scoped.filter((c) => stageOf(c) === stage)), [scoped, stage]);
  const { pageItems, pagination } = usePagination(filtered, 15, `${segment}|${stage}|${search}`);

  const segmentCounts: Record<SegmentFilter, number> = {
    all: searched.length,
    individual: searched.filter((c) => (c.customer_segment ?? "individual") === "individual").length,
    family: searched.filter((c) => c.customer_segment === "family").length,
    organization: searched.filter((c) => c.customer_segment === "organization").length,
  };

  const open = (c: CaseQueueItem) => c.caseStatus !== "Closed" && stageOf(c) !== "CLEARED" && stageOf(c) !== "DECLINED";
  const unassignedMedical = scoped.filter((c) => open(c) && !medical(c).assigned_user_id && medical(c).status !== "CLEARED").length;
  const unassignedFinancial = scoped.filter((c) => open(c) && !financial(c).assigned_user_id && financial(c).status !== "CLEARED").length;

  const onSaved = (review: UnderwritingReview) => {
    if (!assigning) return;
    const key = assigning.track === "medical" ? "medical_review" : "financial_review";
    setCases((prev) => prev.map((c) => (c.caseld === assigning.c.caseld ? { ...c, [key]: review } : c)));
    notify(review.assigned_user_name
      ? tx("{0} now has the {1} review of {2}.", { 0: review.assigned_user_name, 1: assigning.track, 2: assigning.c.customer_name ?? "" })
      : tx("The {0} review of {1} is unassigned.", { 0: assigning.track, 1: assigning.c.customer_name ?? "" }), true);
    setAssigning(null);
  };

  if (role !== null && role !== "Admin" && role !== "SuperAdmin") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="font-bold text-slate-800">{tx("This overview is for Admins")}</p>
          <p className="mt-1 text-sm text-slate-500">{tx("Your underwriting work is in the Underwriting Workbench.")}</p>
          <a href={underwritingUrl("/underwriting")} className="mt-4 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700">
            {tx("Open the Workbench")}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-4 max-w-screen-2xl mx-auto w-full font-sans">
      <NewArrivalsBanner count={arrivals.newIds.size} noun="case" onShow={scrollToFirstNew} onDismiss={arrivals.markAllSeen} />
      {/* Header — same shape as the Leads page */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Underwriting")}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {tx("Where every application stands in its medical and financial review, and who has it.")}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={() => load()}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}>
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            {tx("Refresh")}
          </button>
          <a
            href={underwritingUrl("/underwriting")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm"
          >
            {tx("Open Workbench")}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
          </a>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}

      <div className="flex flex-col gap-3">
        {/* Toolbar: segment tabs with counts and search — every control 42px tall */}
        <div className="flex flex-wrap items-center gap-3 w-full">
          <div className="inline-flex h-[42px] items-stretch bg-white p-1 rounded-xl shadow-sm border border-slate-200 shrink-0">
            {([["all", "All"], ["individual", "Individual"], ["family", "Family"], ["organization", "Corporate"]] as [SegmentFilter, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setSegment(value)}
                className={`inline-flex items-center gap-2 px-3.5 rounded-lg text-sm font-semibold transition-colors ${segment === value
                  ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"}`}
              >
                {tx(label)}
                <span className={`min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${segment === value ? "bg-white text-blue-700 ring-1 ring-inset ring-blue-100" : "bg-slate-100 text-slate-500"}`}>
                  {loading ? "—" : segmentCounts[value]}
                </span>
              </button>
            ))}
          </div>

          <div className="relative w-full max-w-[320px] shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              type="text"
              placeholder={tx("Search applicant, application, plan or underwriter…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-[42px] pl-9 pr-8 text-sm border border-slate-200 rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-shadow"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">✕</button>
            )}
          </div>
        </div>

        {/* Overall stage: quiet pills, the selected one dark; unassigned reviews on the right */}
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={tx("Underwriting stage")}>
          {STAGES.map((st) => {
            const on = stage === st.id;
            const count = st.id === "ALL" ? scoped.length : scoped.filter((c) => stageOf(c) === st.id).length;
            return (
              <button
                key={st.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setStage(st.id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  on ? "bg-slate-900 text-white" : count === 0 ? "text-slate-400 hover:bg-slate-100" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {st.id !== "ALL" && <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-white" : count === 0 ? "bg-slate-300" : st.dot}`} />}
                {tx(st.label)}
                <span className={`tabular-nums ${on ? "text-slate-300" : "text-slate-400"}`}>{loading ? "—" : count}</span>
              </button>
            );
          })}
          {!loading && (
            <div className="ml-auto flex items-center gap-4 text-xs text-slate-500">
              <span className="whitespace-nowrap">{tx("Unassigned medical")} <span className={`font-semibold tabular-nums ${unassignedMedical ? "text-amber-700" : "text-slate-800"}`}>{unassignedMedical}</span></span>
              <span className="whitespace-nowrap">{tx("Unassigned financial")} <span className={`font-semibold tabular-nums ${unassignedFinancial ? "text-amber-700" : "text-slate-800"}`}>{unassignedFinancial}</span></span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden w-full">
        {loading ? (
          <div className="py-16 flex justify-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-blue-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center px-6">
            <p className="text-sm font-semibold text-slate-600">
              {cases.length === 0 ? tx("No applications in underwriting yet") : tx("No applications match your filters")}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {cases.length === 0 ? tx("Applications appear here once they are sent to underwriting.") : tx("Try a different segment, stage or search.")}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto w-full">
              <table className="w-full min-w-[1080px] text-left text-sm whitespace-nowrap">
                <thead className="bg-white border-b border-slate-200">
                  <tr className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pl-6 pr-4 py-3">{tx("Applicant")}</th>
                    <th className="px-4 py-3">{tx("Plan")}</th>
                    <th className="px-4 py-3">{tx("Pre-underwriting")}</th>
                    <th className="px-4 py-3">{tx("Medical review")}</th>
                    <th className="px-4 py-3">{tx("Financial review")}</th>
                    <th className="px-4 py-3">{tx("AI assessment")}</th>
                    <th className="px-4 py-3">{tx("Received")}</th>
                    <th className="pl-4 pr-6 py-3 text-right w-16"><span className="sr-only">{tx("Actions")}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageItems.map((c) => {
                    const workbench = underwritingUrl(`/case/${c.caseld}`);
                    const actions: RowAction[] = [
                      { key: "medical", label: medical(c).assigned_user_id ? tx("Reassign medical review") : tx("Assign medical review"), icon: "stethoscope", onSelect: () => setAssigning({ c, track: "medical" }) },
                      { key: "financial", label: financial(c).assigned_user_id ? tx("Reassign financial review") : tx("Assign financial review"), icon: "wallet", onSelect: () => setAssigning({ c, track: "financial" }) },
                      { key: "open", label: tx("Open in Workbench"), icon: "external", onSelect: () => { arrivals.markSeen(c.caseld); window.open(workbench, "_blank", "noopener"); } },
                    ];
                    return (
                      <tr
                        key={c.caseld}
                        onClick={() => { arrivals.markSeen(c.caseld); window.open(workbench, "_blank", "noopener"); }}
                        className={`group cursor-pointer transition-colors hover:bg-slate-50/70 ${c.caseStatus === "Closed" ? "opacity-60" : ""} ${arrivals.newIds.has(c.caseld) ? NEW_ARRIVAL_CLASS : ""}`}
                      >
                        <td className="pl-6 pr-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-100">
                              {initials(c.customer_name ?? "")}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{c.customer_name ?? "—"}</span>
                                {c.on_hold && (
                                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-600/20" title={c.hold_reason ?? undefined}>
                                    {tx("On hold")}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5">
                                <span className="font-mono">{c.caseNumber}</span>
                                {" · "}
                                {c.customer_segment === "organization" ? tx("Corporate") : c.customer_segment === "family" ? (c.family_group_name ?? tx("Family")) : tx("Individual")}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="text-[13px] text-slate-700">{c.product_name ?? "—"}</div>
                          <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">{c.coverage_amount != null ? fmtCoverage(c.coverage_amount) : "—"}</div>
                        </td>
                        <td className="px-4 py-3.5"><GatesCell c={c} /></td>
                        <td className="px-4 py-3.5"><ReviewCell review={medical(c)} /></td>
                        <td className="px-4 py-3.5"><ReviewCell review={financial(c)} /></td>
                        <td className="px-4 py-3.5">
                          {c.latest_ai_decision ? (
                            <div>
                              <div className={`text-[13px] font-medium ${AI_BADGE[c.latest_ai_decision] ?? "text-slate-700"}`}>{tx(c.latest_ai_decision)}</div>
                              {c.latest_composite_score != null && (
                                <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">{tx("Risk score {0}", { 0: c.latest_composite_score })}</div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">{tx("Not run")}</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-xs text-slate-500">{displayDate(c.createdAt)}</td>
                        <td className="pl-4 pr-6 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <RowActionsMenu actions={actions} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pagination={pagination} noun={tx("applications")} inline />
          </>
        )}
      </div>

      {assigning && (
        <AssignDialog target={assigning} underwriters={underwriters} onClose={() => setAssigning(null)} onSaved={onSaved} />
      )}
    </div>
  );
}
