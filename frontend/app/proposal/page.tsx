"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import api from "../services/api";
import { getQuote, listQuotes, QuoteDetail, QuoteListItem } from "../services/quotes";
import { MetricCard } from "@/components/MetricCard";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import { StatusDropdown, StatusFilter } from "@/components/StatusDropdown";
import { FancyDropdown, FancyDropdownOption } from "@/components/FancyDropdown";
import { fmtCoverage } from "@/lib/mock-data";

import { updateQuote } from "../services/quotes";
import { listUnderwriters, Agent } from "../services/agents";
import { listAcquisitionSources, AcquisitionSource } from "../services/acquisitionSources";
import { updateCustomer } from "../services/customers";

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  GROUP_LIFE: "Group Life",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Direct",
  DIGITAL: "Digital",
};

function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function formatLeadDisplayId(customerId: string, createdAt: string, segment: "individual" | "family" | "organization"): string {
  const prefix = segment === "family" ? "FAM" : segment === "organization" ? "CORP" : "IND";
  const dt = new Date(createdAt);
  const yymm = `${dt.getFullYear().toString().slice(-2)}${(dt.getMonth() + 1).toString().padStart(2, "0")}`;
  const seq = customerId.slice(-3).toUpperCase();
  return `${prefix}-${yymm}-${seq}`;
}

// A quote only ever carries one of organization_id / family_group_id, never
// both — same mutually-exclusive segmentation the grouping logic below relies on.
function quoteSegment(q: QuoteListItem): "individual" | "family" | "organization" {
  if (q.organization_id && q.master_policy_id) return "organization";
  if (q.family_group_id && q.family_policy_id) return "family";
  return "individual";
}

function dedupeQuotesByCustomer(quotes: QuoteListItem[]): QuoteListItem[] {
  const latestByCustomer = new Map<string, QuoteListItem>();

  for (const quote of quotes) {
    const current = latestByCustomer.get(quote.customer_id);
    const quoteTime = new Date(quote.created_at || 0).getTime();
    const currentTime = current ? new Date(current.created_at || 0).getTime() : -Infinity;

    if (!current || quoteTime > currentTime) {
      latestByCustomer.set(quote.customer_id, quote);
    }
  }

  return Array.from(latestByCustomer.values()).sort((a, b) => {
    const aTime = new Date(a.created_at || 0).getTime();
    const bTime = new Date(b.created_at || 0).getTime();
    return bTime - aTime;
  });
}

const STATUS_TABS = [
  { id: "ALL", label: "All Proposals" },
  { id: "Quoted", label: "Draft" },
  { id: "Proposed", label: "Submitted" },
  { id: "UnderReview", label: "Under Review" },
  { id: "InformationRequested", label: "Info Requested" },
  { id: "Approved", label: "Approved" },
  { id: "Declined", label: "Rejected" },
  { id: "Issued", label: "Issued" },
];

// ── Status badge / SLA / underwriter presentation ───────────────────────────
// Same stage vocabulary and colors as StatusDropdown's dots, so the pill on a
// row and the filter used to find that row always agree visually.

const STATUS_LABEL: Record<string, string> = {
  Quoted: "Draft",
  Proposed: "Submitted",
  UnderReview: "Under Review",
  InformationRequested: "Info Requested",
  Approved: "Approved",
  AcceptedWithLoadings: "Accepted (Loadings)",
  Declined: "Rejected",
  Issued: "Issued",
};

const STATUS_BADGE_STYLE: Record<string, string> = {
  Quoted: "bg-slate-100 text-slate-600 border-slate-200",
  Proposed: "bg-blue-50 text-blue-700 border-blue-200",
  UnderReview: "bg-amber-50 text-amber-700 border-amber-200",
  InformationRequested: "bg-amber-50 text-amber-600 border-amber-200",
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  AcceptedWithLoadings: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Declined: "bg-rose-50 text-rose-700 border-rose-200",
  Issued: "bg-violet-50 text-violet-700 border-violet-200",
};

const STATUS_DOT: Record<string, string> = {
  Quoted: "bg-slate-400",
  Proposed: "bg-blue-500",
  UnderReview: "bg-amber-500",
  InformationRequested: "bg-amber-300",
  Approved: "bg-emerald-500",
  AcceptedWithLoadings: "bg-emerald-500",
  Declined: "bg-rose-500",
  Issued: "bg-violet-500",
};

function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${
        STATUS_BADGE_STYLE[status] ?? "bg-slate-100 text-slate-600 border-slate-200"
      } ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[status] ?? "bg-slate-400"}`} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

const SLA_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  within_sla: { dot: "bg-emerald-500", text: "text-emerald-600", label: "On track" },
  approaching_breach: { dot: "bg-amber-500", text: "text-amber-600", label: "Due soon" },
  breached: { dot: "bg-rose-500", text: "text-rose-600", label: "SLA breached" },
};

function SlaHint({ status, daysRemaining }: { status: QuoteListItem["sla_status"]; daysRemaining: number | null }) {
  if (!status) return null;
  const s = SLA_STYLE[status];
  if (!s) return null;
  const label = status !== "breached" && daysRemaining != null ? `${daysRemaining}d left` : s.label;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      {label}
    </span>
  );
}

function initials(name?: string | null): string {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

function UnderwriterInitial({ name }: { name?: string | null }) {
  return (
    <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[9px] font-bold shrink-0">
      {initials(name)}
    </span>
  );
}

function UnderwriterAvatar({ name }: { name?: string | null }) {
  if (!name) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
        <span className="w-5 h-5 rounded-full border border-dashed border-slate-300 flex items-center justify-center shrink-0">–</span>
        Unassigned
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-slate-600" title={name}>
      <UnderwriterInitial name={name} />
      <span className="truncate max-w-[90px]">{name}</span>
    </span>
  );
}

function OrgIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="3" width="12" height="18" rx="1" />
      <path d="M9 8h2M9 12h2M9 16h2" />
      <path d="M16 21v-8h4v8" />
    </svg>
  );
}

function FamilyIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="8" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M2 21c0-3.6 2.7-6 6-6s6 2.4 6 6" />
      <path d="M14.5 21c.3-2.8 2-4.5 4.5-4.5s4.2 1.7 4.5 4" />
    </svg>
  );
}

function KpiIcon({ name, className = "w-4.5 h-4.5" }: { name: "document" | "shield" | "coin"; className?: string }) {
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className };
  if (name === "shield") {
    return (
      <svg {...props}>
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      </svg>
    );
  }
  if (name === "coin") {
    return (
      <svg {...props}>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path d="M14 3v4a1 1 0 001 1h4" />
      <path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

const STORAGE_KEY = "proposal_view_state";

// ── Available next actions per status ───────────────────────────────────────
// A single source of truth for "what can this proposal legally do next,"
// mirroring shared/services/policy_state_machine.py's _TRANSITIONS map (minus
// Approved/AcceptedWithLoadings, which stay Case-only — see canDecideProposals
// below for why Reject doesn't get the same restriction). Both the per-lead
// dropdown and the batch dropdown read from this one function so the two
// never drift apart.
//
//   kind "status"       — a plain PATCH /quotes/{id} {status}
//   kind "underwriting" — opens/advances the underwriting Case (not a status PATCH)
//   kind "save_info"    — saves the missing customer fields (single-lead only)

interface ProposalActionOption {
  value: string;
  label: string;
  tier: "submission" | "decision"; // submission: Agent+; decision: Underwriter+
}

function getAvailableActions(status: string, hasMissingFields: boolean, forBatch: boolean): ProposalActionOption[] {
  const opts: ProposalActionOption[] = [];

  if (status === "Quoted") { // Draft
    if (forBatch || !hasMissingFields) {
      opts.push({ value: "status:Proposed", label: "Submit Proposal", tier: "submission" });
    }
    opts.push({ value: "status:InformationRequested", label: "Request Info", tier: "submission" });
  } else if (status === "Proposed") { // Submitted
    opts.push({ value: "status:UnderReview", label: "Start Review", tier: "submission" });
    opts.push({ value: "status:InformationRequested", label: "Request Info", tier: "submission" });
    // Undo an accidental Submit — back to Draft, no harm done.
    opts.push({ value: "status:Quoted", label: "Step Back to Draft", tier: "submission" });
  } else if (status === "UnderReview") {
    opts.push({ value: "underwriting", label: "Send to Underwriting", tier: "submission" });
    opts.push({ value: "status:InformationRequested", label: "Request Info", tier: "submission" });
    // Undo an accidental Start Review — back to Submitted, no harm done.
    opts.push({ value: "status:Proposed", label: "Step Back to Submitted", tier: "submission" });
  } else if (status === "InformationRequested") {
    if (!forBatch && hasMissingFields) {
      opts.push({ value: "save_info", label: "Save Information", tier: "submission" });
    }
    opts.push({ value: "status:Proposed", label: "Re-Submit Proposal", tier: "submission" });
    opts.push({ value: "status:UnderReview", label: "Return to Under Review", tier: "submission" });
  } else {
    // Approved / AcceptedWithLoadings / Declined / Issued: no actions here —
    // these are outcomes reached only via the underwriting Case's decision.
    return [];
  }

  // Reject is legal directly from any of the four statuses above
  opts.push({ value: "status:Declined", label: "Reject Proposal", tier: "decision" });

  return opts;
}

// ── Grouping types ───────────────────────────────────────────────────────────
// Corporate/group-life quotes (Policy.master_policy_id set) nest three levels
// deep — Organization -> Master Policy -> Customer — so an underwriter can
// browse a census the same way they'd browse folders on disk. Retail quotes
// (no organization) have no policy/org to nest under, so they keep the
// original flat one-folder-per-customer view.

interface CustomerFolderData {
  customer_id: string;
  customer_name: string;
  customer_cnic: string;
  quotes: QuoteListItem[];
}

interface PolicyFolderData {
  master_policy_id: string;
  master_policy_label: string;
  customers: CustomerFolderData[];
}

interface OrganizationFolderData {
  organization_id: string;
  organization_name: string;
  policies: PolicyFolderData[];
}

// Family quotes (Policy.family_policy_id set) nest the same three levels —
// FamilyGroup -> FamilyPolicy (Floater or Life Bundle) -> Customer — reusing
// the identical CustomerFolder leaf. Kept as separate types (not reusing
// OrganizationFolderData/PolicyFolderData) since a FamilyPolicy carries
// plan_type-specific fields an employer MasterPolicy doesn't.

interface FamilyPolicyFolderData {
  family_policy_id: string;
  family_policy_label: string;
  customers: CustomerFolderData[];
}

interface FamilyGroupFolderData {
  family_group_id: string;
  family_group_name: string;
  policies: FamilyPolicyFolderData[];
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QuotePage() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");

  const [activeTab, setActiveTab] = useState<StatusFilter>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [underwriters, setUnderwriters] = useState<Agent[]>([]);
  const [sources, setSources] = useState<AcquisitionSource[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);

  const underwriterFilterOptions: FancyDropdownOption[] = useMemo(
    () => [
      { value: "", label: "All Underwriters" },
      ...underwriters.map((u) => ({ value: u.id, label: u.full_name, description: u.email, icon: <UnderwriterInitial name={u.full_name} /> })),
    ],
    [underwriters]
  );

  const sourceFilterOptions: FancyDropdownOption[] = useMemo(
    () => [
      { value: "", label: "All Sources" },
      ...sources.map((s) => ({
        value: s.id,
        label: s.name,
        description: [SOURCE_TYPE_LABELS[s.source_type] ?? s.source_type, s.partner_name].filter(Boolean).join(" · "),
      })),
    ],
    [sources]
  );

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.activeTab) setActiveTab(parsed.activeTab);
      } catch (e) {}
    }
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) {
      listUnderwriters(tenantId).then(setUnderwriters).catch(console.error);
      listAcquisitionSources(tenantId).then(setSources).catch(console.error);
    }
    setUserRole(localStorage.getItem("user_role"));
    setIsHydrated(true);
  }, []);

  // Submitting/moving a proposal along (Submit, Start Review, Send to
  // Underwriting) is something an Agent can do. A Viewer (or unrecognized
  // role) gets no action buttons on this page at all.
  const canActOnProposals = userRole != null && ["Agent", "Underwriter", "Admin", "SuperAdmin"].includes(userRole);
  // Deciding a proposal is Underwriter/Admin-only, but the two decisions
  // aren't symmetric: Approve genuinely requires underwriting to have run
  // (risk assessment, documents) — that stays Case-only (see /case/[id]
  // "Override: Approve"). Reject has no such requirement — the backend state
  // machine (shared/services/policy_state_machine.py) legally allows
  // Draft/Submitted/Under Review/Info Requested -> Rejected directly, since a
  // real underwriter can decline outright (e.g. plain ineligibility) without
  // running a full assessment first. So Reject gets its own button here.
  const canDecideProposals = userRole != null && ["Underwriter", "Admin", "SuperAdmin"].includes(userRole);

  const isMounted = useRef(false);
  useEffect(() => {
    if (!isMounted.current) {
      isMounted.current = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeTab }));
  }, [activeTab]);


  const [selectedQuoteId, setSelectedProposalId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [selectedQuoteIds, setSelectedProposalIds] = useState<Set<string>>(new Set());
  const [isBulkProceeding, setIsBulkProceeding] = useState(false);
  const [bulkProceedError, setBulkProceedError] = useState<string | null>(null);
  const [bulkProceedSuccess, setBulkProceedSuccess] = useState<string | null>(null);

  // Expand state — one Set/id-per-level. IDs are globally unique UUIDs so a
  // flat Set per level is enough; no need to scope by parent. The Family tree
  // reuses expandedCustomerId at its leaf (same reasoning: customer IDs are
  // globally unique whether the customer sits under an org or a family).
  const [viewMode, setViewMode] = useState<'list'|'grid'>('list');



  const toggleSelection = (quoteId: string) => {
    setSelectedProposalIds((prev) => {
      const next = new Set(prev);
      if (next.has(quoteId)) next.delete(quoteId);
      else next.add(quoteId);
      return next;
    });
  };

  const toggleAllInFolder = (quoteIds: string[]) => {
    setSelectedProposalIds((prev) => {
      const next = new Set(prev);
      const allSelected = quoteIds.every((id) => next.has(id));
      if (allSelected) {
        for (const id of quoteIds) next.delete(id);
      } else {
        for (const id of quoteIds) next.add(id);
      }
      return next;
    });
  };

  const handleBulkProceed = async (customerQuotes: QuoteListItem[]) => {
    const selectedQuotes = customerQuotes.filter((q) => selectedQuoteIds.has(q.quote_id));
    if (selectedQuotes.length === 0) return;
    
    if (selectedQuotes.some((q) => q.quote_id.startsWith("draft-"))) {
      setBulkProceedError("Cannot proceed with an unquoted Draft. Please generate a Quotation in the Leads Hub first.");
      return;
    }

    setIsBulkProceeding(true);
    setBulkProceedError(null);
    setBulkProceedSuccess(null);
    try {
      const tenantId = localStorage.getItem("tenant_id");
      if (!tenantId) throw new Error("Tenant ID not found");

      if (selectedQuotes.length === 1) {
        const q = selectedQuotes[0];
        const caseRes = await api.post(`/tenants/${tenantId}/cases`, {
          customer_id: q.customer_id,
          policy_id: q.policy_id,
          caseType: "Underwriting",
          sourceChannel: "Online",
        });
        router.push(`/case/${caseRes.data.caseld}?autoRun=true`);
        setSelectedProposalIds(new Set());
        setIsBulkProceeding(false);
        return;
      }

      // Multiple items selected — open the same AI underwriting page the single
      // flow uses, but as a switchable group (one case per selected plan).
      // 1. Create a case for each selected plan, keeping the plan label so the
      //    underwriting page can render a plan switcher dropdown.
      const group = await Promise.all(
        selectedQuotes.map(async (q) => {
          const caseRes = await api.post(`/tenants/${tenantId}/cases`, {
            customer_id: q.customer_id,
            policy_id: q.policy_id,
            caseType: "Underwriting",
            sourceChannel: "Online",
          });
          return {
            caseId: caseRes.data.caseld as string,
            planLabel: q.plan_label,
            insuranceType: q.insurance_type,
          };
        })
      );

      // 2. Persist the group so /case/[id] can offer a dropdown to switch plans.
      sessionStorage.setItem("underwriting_group", JSON.stringify(group));

      // 3. Navigate to the first plan's case and auto-run underwriting there.
      router.push(`/case/${group[0].caseId}?autoRun=true`);

      setSelectedProposalIds(new Set());
    } catch (err: any) {
      setBulkProceedError(err.message ?? "Failed to initialize bulk processing.");
    } finally {
      setIsBulkProceeding(false);
    }
  };

  const handleBulkStatusUpdate = async (customerQuotes: QuoteListItem[], targetStatus: string) => {
    const selectedQuotes = customerQuotes.filter((q) => selectedQuoteIds.has(q.quote_id));
    if (selectedQuotes.length === 0) return;
    
    if (selectedQuotes.some((q) => q.quote_id.startsWith("draft-"))) {
      setBulkProceedError("Cannot change status of an unquoted Draft. Please generate a Quotation in the Leads Hub first.");
      return;
    }

    setIsBulkProceeding(true);
    setBulkProceedError(null);
    setBulkProceedSuccess(null);
    try {
      await Promise.all(
        selectedQuotes.map((q) => updateQuote(q.quote_id, { status: targetStatus }))
      );
      setBulkProceedSuccess("Successfully updated statuses.");
      fetchQuotes();
      setSelectedProposalIds(new Set());
      // Jump to the destination tab so the just-moved lead(s) are visible
      // right away instead of vanishing from the tab the user was on.
      setActiveTab(targetStatus as StatusFilter);
    } catch (err: any) {
      setBulkProceedError(err.message ?? "Failed to update statuses.");
    } finally {
      setIsBulkProceeding(false);
    }
  };

  // Same option list the per-lead modal uses (getAvailableActions), just with
  // forBatch=true so it doesn't try to reason about any one customer's
  // missing fields — both Submit and Send-to-Info-Requested are offered
  // together and the underwriter picks whichever fits the selected batch.
  const batchOptions = useMemo(() => getAvailableActions(activeTab, false, true), [activeTab]);

  const handleBatchApply = async (value: string, quotesToProcess: QuoteListItem[]) => {
    if (value === "underwriting") {
      await handleBulkProceed(quotesToProcess);
      return;
    }
    if (value.startsWith("status:")) {
      await handleBulkStatusUpdate(quotesToProcess, value.slice("status:".length));
    }
  };

  const getBatchConfirmMessage = (option: ProposalActionOption, selectedCount: number) =>
    option.tier === "decision" ? `Reject ${selectedCount} proposal(s)? This cannot be undone.` : undefined;

  const openQuote = useCallback(async (quoteId: string) => {
    if (quoteId.startsWith("draft-")) {
      alert("This is an unquoted draft lead. Please go to the Leads Hub and generate a Quotation for this customer before proceeding here.");
      return;
    }
    setSelectedProposalId(quoteId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const data = await getQuote(quoteId);
      setDetail(data);
    } catch (err: any) {
      setDetailError(err.message ?? "Failed to load quotation details.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeQuote = useCallback(() => {
    setSelectedProposalId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  // Status is filtered client-side (like segment already was) so the status
  // dropdown can show a live count per status and switching status feels
  // instant — no network round-trip just to change which status you're
  // looking at. Only the other filters (date range, underwriter, source)
  // still go to the server.
  const fetchQuotes = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const filters: any = {};
      if (dateFrom) filters.created_from = dateFrom;
      if (dateTo) filters.created_to = dateTo;
      if (agentFilter) filters.assigned_underwriter_id = agentFilter;
      if (sourceFilter) filters.acquisition_source_id = sourceFilter;

      const data = await listQuotes(filters);
      let quotesList = data || [];

      // Fetch customers still moving through the Leads pipeline (no status yet,
      // Lead, In Progress, or explicit Draft) that don't have a real quote yet,
      // so they still show up in the Draft tab. `customers` has no server-side
      // status filter, so the pipeline/dead-lead/policyholder split happens
      // client-side here.
      const tenantId = localStorage.getItem("tenant_id");
      if (tenantId) {
        try {
          const draftRes = await api.get(`/tenants/${tenantId}/customers`);
          if (draftRes.data && Array.isArray(draftRes.data)) {
            const pipelineCustomers = draftRes.data.filter(
              (c: any) => !c.profile_status || !["NOT_INTERESTED", "POLICYHOLDER"].includes(c.profile_status)
            );
            // Filter out customers that already have a quoted policy
            const unquoted = pipelineCustomers.filter(
              (c: any) => !quotesList.some((q) => q.customer_id === c.id)
            );
            const fakeQuotes = unquoted.map((c: any) => ({
              quote_id: `draft-${c.id}`,
              customer_id: c.id,
              customer_name: c.name,
              customer_cnic: c.cnic || "Pending",
              policy_id: `draft-${c.id}`,
              plan_label: "Unassigned Plan",
              insurance_type: "UNKNOWN",
              coverage_amount: 0,
              term_years: 0,
              base_premium: 0,
              loading_applied: 0,
              total_premium: 0,
              rate_version: "v0",
              created_at: c.created_at,
              status: "Quoted", // Forces it into the Draft tab
              effective_date: null,
              updated_at: c.updated_at,
              assigned_underwriter_id: null,
              assigned_underwriter_name: null,
              sla_status: null,
              sla_days_remaining: null,
            }));
            quotesList = [...quotesList, ...fakeQuotes];
          }
        } catch (e) {
          console.warn("Failed to fetch pipeline customers:", e);
        }
      }

      setQuotes(quotesList);
    } catch (err: any) {
      setError(err.message ?? "Failed to load quotations.");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, agentFilter, sourceFilter]);

  useEffect(() => {
    if (!isHydrated) return;
    fetchQuotes();
  }, [fetchQuotes, isHydrated]);

  const statusFilteredQuotes = useMemo(() => {
    return activeTab === "ALL" ? quotes : quotes.filter((q) => q.status === activeTab);
  }, [quotes, activeTab]);

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<StatusFilter, number>> = { ALL: dedupeQuotesByCustomer(quotes).length };
    for (const tab of STATUS_TABS) {
      if (tab.id === "ALL") continue;
      counts[tab.id as StatusFilter] = dedupeQuotesByCustomer(quotes.filter((q) => q.status === tab.id)).length;
    }
    return counts;
  }, [quotes]);

  // The dropdown-selected segment scopes which quotes count toward the stats
  // and folder list; the search box then narrows within that scope.
  const segmentQuotes = useMemo(() => {
    const filtered = segment === "all" ? statusFilteredQuotes : statusFilteredQuotes.filter((q) => quoteSegment(q) === segment);
    return dedupeQuotesByCustomer(filtered);
  }, [statusFilteredQuotes, segment]);

  const segmentCounts = useMemo(() => {
    const counts: Partial<Record<SegmentFilter, number>> = { all: dedupeQuotesByCustomer(statusFilteredQuotes).length };
    for (const s of ["individual", "family", "organization"] as const) {
      const filtered = statusFilteredQuotes.filter((q) => quoteSegment(q) === s);
      counts[s] = dedupeQuotesByCustomer(filtered).length;
    }
    return counts;
  }, [statusFilteredQuotes]);

  const kpis = useMemo(() => {
    const q = search.trim().toLowerCase();
    let fullyFilteredQuotes = segmentQuotes;
    if (q) {
      fullyFilteredQuotes = segmentQuotes.filter(
        (qt) =>
          qt.customer_name?.toLowerCase().includes(q) ||
          qt.policy_name?.toLowerCase().includes(q) ||
          (qt.customer_type === "ORGANIZATION" && qt.registration_number?.toLowerCase().includes(q))
      );
    }
    const totalCoverage = fullyFilteredQuotes.reduce((sum, qt) => sum + qt.coverage_amount, 0);
    const totalPremium = fullyFilteredQuotes.reduce((sum, qt) => sum + qt.total_premium, 0);
    return [
      { title: "Proposals", value: fullyFilteredQuotes.length, subtitle: "plans generated", accent: "slate" as const, icon: <KpiIcon name="document" /> },
      { title: "Total Coverage", value: fullyFilteredQuotes.length > 0 ? fmtCoverage(totalCoverage) : "—", subtitle: "sum assured", accent: "amber" as const, icon: <KpiIcon name="shield" /> },
      { title: "Total Premium", value: fullyFilteredQuotes.length > 0 ? fmtCoverage(totalPremium) : "—", subtitle: "annualized", accent: "emerald" as const, icon: <KpiIcon name="coin" /> },
    ];
  }, [segmentQuotes, search]);

  const { organizationGroups, familyGroups, individualGroups } = useMemo(() => {
    const q = search.trim().toLowerCase();
    let filteredList = segmentQuotes;
    if (q) {
      filteredList = segmentQuotes.filter(
        (row) =>
          row.customer_name.toLowerCase().includes(q) ||
          row.customer_cnic.toLowerCase().includes(q) ||
          row.plan_label.toLowerCase().includes(q) ||
          (row.organization_name?.toLowerCase().includes(q) ?? false) ||
          (row.family_group_name?.toLowerCase().includes(q) ?? false),
      );
    }

    const orgMap = new Map<string, OrganizationFolderData>();
    const familyMap = new Map<string, FamilyGroupFolderData>();
    const individualMap = new Map<string, CustomerFolderData>();

    for (const quote of filteredList) {
      if (quote.organization_id && quote.master_policy_id) {
        let org = orgMap.get(quote.organization_id);
        if (!org) {
          org = {
            organization_id: quote.organization_id,
            organization_name: quote.organization_name ?? "Unknown Organization",
            policies: [],
          };
          orgMap.set(quote.organization_id, org);
        }

        let policy = org.policies.find((p) => p.master_policy_id === quote.master_policy_id);
        if (!policy) {
          policy = {
            master_policy_id: quote.master_policy_id,
            master_policy_label: quote.master_policy_label ?? "Master Policy",
            customers: [],
          };
          org.policies.push(policy);
        }

        let customer = policy.customers.find((c) => c.customer_id === quote.customer_id);
        if (!customer) {
          customer = {
            customer_id: quote.customer_id,
            customer_name: quote.customer_name,
            customer_cnic: quote.customer_cnic,
            quotes: [],
          };
          policy.customers.push(customer);
        }
        customer.quotes.push(quote);
      } else if (quote.family_group_id && quote.family_policy_id) {
        let family = familyMap.get(quote.family_group_id);
        if (!family) {
          family = {
            family_group_id: quote.family_group_id,
            family_group_name: quote.family_group_name ?? "Unknown Family",
            policies: [],
          };
          familyMap.set(quote.family_group_id, family);
        }

        let policy = family.policies.find((p) => p.family_policy_id === quote.family_policy_id);
        if (!policy) {
          policy = {
            family_policy_id: quote.family_policy_id,
            family_policy_label: quote.family_policy_label ?? "Family Policy",
            customers: [],
          };
          family.policies.push(policy);
        }

        let customer = policy.customers.find((c) => c.customer_id === quote.customer_id);
        if (!customer) {
          customer = {
            customer_id: quote.customer_id,
            customer_name: quote.customer_name,
            customer_cnic: quote.customer_cnic,
            quotes: [],
          };
          policy.customers.push(customer);
        }
        customer.quotes.push(quote);
      } else {
        let customer = individualMap.get(quote.customer_id);
        if (!customer) {
          customer = {
            customer_id: quote.customer_id,
            customer_name: quote.customer_name,
            customer_cnic: quote.customer_cnic,
            quotes: [],
          };
          individualMap.set(quote.customer_id, customer);
        }
        customer.quotes.push(quote);
      }
    }

    return {
      organizationGroups: Array.from(orgMap.values()),
      familyGroups: Array.from(familyMap.values()),
      individualGroups: Array.from(individualMap.values()),
    };
  }, [segmentQuotes, search]);

  const totalResults = organizationGroups.length + familyGroups.length + individualGroups.length;
  const activeTabLabel = STATUS_TABS.find((t) => t.id === activeTab)?.label ?? activeTab;
  const activeFilterCount = [dateFrom, dateTo, agentFilter, sourceFilter].filter(Boolean).length;
  const clearFilters = () => {
    setDateFrom("");
    setDateTo("");
    setAgentFilter("");
    setSourceFilter("");
  };

  return (
    <div className="px-6 py-5 max-w-screen-2xl mx-auto w-full space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-sm shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M14 3v4a1 1 0 001 1h4" />
              <path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
              <path d="M9 13h6M9 17h4" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Proposals</h1>
            <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">
              Generated automatically the moment a customer is registered — no form to fill in. Corporate
              proposals nest by organization and master policy; family proposals by family and floater/life-bundle policy.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold tracking-wide font-mono shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          GET /quotes
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k) => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <StatusDropdown value={activeTab} onChange={setActiveTab} counts={statusCounts} />
          <p className="text-[11px] text-slate-400 px-1">
            Draft → Submitted → Under Review → Approved/Rejected → Issued — one way, no skipping stages.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border rounded-lg transition-colors ${
              filtersOpen ? "bg-blue-50 border-blue-200 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="11" y1="18" x2="13" y2="18" />
            </svg>
            {filtersOpen ? "Hide Filters" : "Advanced Filters"}
            {activeFilterCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white">{activeFilterCount}</span>
            )}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs font-semibold text-slate-400 hover:text-slate-600 transition-colors">
              Clear filters
            </button>
          )}
        </div>
        {filtersOpen && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Created From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Created To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Underwriter</label>
              <FancyDropdown
                value={agentFilter}
                onChange={setAgentFilter}
                options={underwriterFilterOptions}
                placeholder="All Underwriters"
                searchable={underwriters.length > 6}
                size="sm"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Source</label>
              <FancyDropdown
                value={sourceFilter}
                onChange={setSourceFilter}
                options={sourceFilterOptions}
                placeholder="All Sources"
                searchable={sources.length > 6}
                size="sm"
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
          <div className="relative w-full max-w-xs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search by customer, CNIC, organization, or plan…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
            />
          </div>
          <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner border border-slate-200/60 shrink-0">
            <button
              onClick={() => setViewMode("list")}
              title="List View"
              className={`p-2 rounded-lg transition-all ${viewMode === "list" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
            </button>
            <button
              onClick={() => setViewMode("grid")}
              title="Grid View"
              className={`p-2 rounded-lg transition-all ${viewMode === "grid" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
            </button>
          </div>
          <button
            onClick={fetchQuotes}
            disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 h-[36px]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <ProposalsSkeleton viewMode={viewMode} />
        ) : totalResults === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-slate-400">
                <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-slate-600">
              {quotes.length === 0
                ? "No proposals yet"
                : segmentQuotes.length === 0
                  ? `No ${segment === "all" ? "" : segment + " "}proposals in "${activeTabLabel}"`
                  : "No proposals match your search"}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {quotes.length === 0
                ? "Register a customer and a proposal will be generated automatically in the background."
                : segmentQuotes.length === 0
                  ? "Try a different status or switch the segment filter to All Cases."
                  : "Try a different customer name, CNIC, organization, or plan."}
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {organizationGroups.length > 0 && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-600 px-1">
                  <OrgIcon className="w-3.5 h-3.5" />
                  Corporate / Group Life
                  <span className="text-slate-400 font-medium normal-case tracking-normal">
                    · {organizationGroups.length} {organizationGroups.length === 1 ? "organization" : "organizations"} ·{" "}
                    {organizationGroups.reduce((n, o) => n + o.policies.reduce((m, p) => m + p.customers.length, 0), 0)} insured
                  </span>
                </p>
                {(() => {
                  const allOrgQuotes = organizationGroups.flatMap(org => org.policies.flatMap(p => p.customers.flatMap(c => c.quotes)));
                  const selectedQuotes = allOrgQuotes.filter(q => selectedQuoteIds.has(q.quote_id));
                  const selectedOrgCount = selectedQuotes.length;
                  const allSelected = allOrgQuotes.length > 0 && selectedOrgCount === allOrgQuotes.length;
                  return (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col">
                      <BatchActionBar
                        selectedCount={selectedOrgCount}
                        totalCount={allOrgQuotes.length}
                        allSelected={allSelected}
                        onToggleAll={() => toggleAllInFolder(allOrgQuotes.map(q => q.quote_id))}
                        options={batchOptions}
                        onApply={(value) => handleBatchApply(value, allOrgQuotes)}
                        getConfirmMessage={(o) => getBatchConfirmMessage(o, selectedOrgCount)}
                        disabled={isBulkProceeding || selectedOrgCount === 0}
                        canAct={canActOnProposals}
                        canDecide={canDecideProposals}
                      />
                      {viewMode === 'grid' ? (
                        <div className="p-4 bg-slate-50/30">
                          <ProposalsGrid
                            quotes={allOrgQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        </div>
                      ) : (
                        <ProposalsTable
                          quotes={allOrgQuotes}
                          selectedQuoteIds={selectedQuoteIds}
                          toggleSelection={toggleSelection}
                          toggleAllInFolder={toggleAllInFolder}
                          openQuote={openQuote}
                        />
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {familyGroups.length > 0 && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-violet-600 px-1">
                  <FamilyIcon className="w-3.5 h-3.5" />
                  Family Insurance
                  <span className="text-slate-400 font-medium normal-case tracking-normal">
                    · {familyGroups.length} {familyGroups.length === 1 ? "family" : "families"} ·{" "}
                    {familyGroups.reduce((n, f) => n + f.policies.reduce((m, p) => m + p.customers.length, 0), 0)} insured
                  </span>
                </p>
                {(() => {
                  const allFamQuotes = familyGroups.flatMap(family => family.policies.flatMap(p => p.customers.flatMap(c => c.quotes)));
                  const selectedQuotes = allFamQuotes.filter(q => selectedQuoteIds.has(q.quote_id));
                  const selectedFamCount = selectedQuotes.length;
                  const allSelected = allFamQuotes.length > 0 && selectedFamCount === allFamQuotes.length;
                  return (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col">
                      <BatchActionBar
                        selectedCount={selectedFamCount}
                        totalCount={allFamQuotes.length}
                        allSelected={allSelected}
                        onToggleAll={() => toggleAllInFolder(allFamQuotes.map(q => q.quote_id))}
                        options={batchOptions}
                        onApply={(value) => handleBatchApply(value, allFamQuotes)}
                        getConfirmMessage={(o) => getBatchConfirmMessage(o, selectedFamCount)}
                        disabled={isBulkProceeding || selectedFamCount === 0}
                        canAct={canActOnProposals}
                        canDecide={canDecideProposals}
                      />
                      {viewMode === 'grid' ? (
                        <div className="p-4 bg-slate-50/30">
                          <ProposalsGrid
                            quotes={allFamQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        </div>
                      ) : (
                        <ProposalsTable
                          quotes={allFamQuotes}
                          selectedQuoteIds={selectedQuoteIds}
                          toggleSelection={toggleSelection}
                          toggleAllInFolder={toggleAllInFolder}
                          openQuote={openQuote}
                        />
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {individualGroups.length > 0 && (
              <div className="space-y-3">
                {(organizationGroups.length > 0 || familyGroups.length > 0) && (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-blue-600 px-1 pt-1">
                    Individual
                    <span className="text-slate-400 font-medium normal-case tracking-normal">
                      {" "}· {individualGroups.length} {individualGroups.length === 1 ? "customer" : "customers"}
                    </span>
                  </p>
                )}
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                  {(() => {
                    const allIndividualQuotes = individualGroups.flatMap(g => g.quotes);
                    const selectedQuotes = allIndividualQuotes.filter(q => selectedQuoteIds.has(q.quote_id));
                    const selectedIndividualCount = selectedQuotes.length;
                    const allSelected = allIndividualQuotes.length > 0 && selectedIndividualCount === allIndividualQuotes.length;
                    return (
                      <div className="flex flex-col">
                        <BatchActionBar
                          selectedCount={selectedIndividualCount}
                          totalCount={allIndividualQuotes.length}
                          allSelected={allSelected}
                          onToggleAll={() => toggleAllInFolder(allIndividualQuotes.map(q => q.quote_id))}
                          options={batchOptions}
                          onApply={(value) => handleBatchApply(value, allIndividualQuotes)}
                          getConfirmMessage={(o) => getBatchConfirmMessage(o, selectedIndividualCount)}
                          disabled={isBulkProceeding || selectedIndividualCount === 0}
                          canAct={canActOnProposals}
                          canDecide={canDecideProposals}
                        />
                        {bulkProceedError && (
                          <div className="mx-4 mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                            <p className="text-xs text-red-600">{bulkProceedError}</p>
                          </div>
                        )}
                        {bulkProceedSuccess && (
                          <div className="mx-4 mt-4 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                            <p className="text-xs text-emerald-700 font-semibold">Success</p>
                            <p className="text-xs text-emerald-600">{bulkProceedSuccess}</p>
                          </div>
                        )}
                        {viewMode === 'grid' ? (
                          <div className="p-4 bg-slate-50/30">
                            <ProposalsGrid
                              quotes={allIndividualQuotes}
                              selectedQuoteIds={selectedQuoteIds}
                              toggleSelection={toggleSelection}
                              toggleAllInFolder={toggleAllInFolder}
                              openQuote={openQuote}
                            />
                          </div>
                        ) : (
                          <ProposalsTable
                            quotes={allIndividualQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedQuoteId && (
        <QuoteDetailModal
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={closeQuote}
          onRefresh={fetchQuotes}
          onStatusChange={(newStatus) => setActiveTab(newStatus as StatusFilter)}
          canAct={canActOnProposals}
          canDecide={canDecideProposals}
          onStartUnderwriting={async () => {
            if (!detail) return;
            const tenantId = localStorage.getItem("tenant_id");
            if (!tenantId) return;
            const res = await api.post(`/tenants/${tenantId}/cases`, {
              customer_id: detail.customer_id,
              policy_id: detail.policy_id,
              caseType: "Underwriting",
              sourceChannel: "Online",
            });
            const caseId = res.data.caseld;
            router.push(`/case/${caseId}?autoRun=true`);
          }}
        />
      )}
    </div>
  );
}

// ── Action dropdown ────────────────────────────────────────────────────────
// The standard "pick one, then Go" bulk-action pattern (Gmail, GitHub issue
// lists, Django admin) — shows only the options legal from wherever this
// lead/batch currently sits, so there's never a button for a move that isn't
// actually allowed. Shared between the single-lead modal and the batch bar.

const ACTION_ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  width: 15,
  height: 15,
};

function ActionIcon({ value }: { value: string }) {
  if (value === "status:Declined") {
    return (
      <svg {...ACTION_ICON_PROPS}><circle cx="12" cy="12" r="9" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
    );
  }
  if (value === "underwriting") {
    return (
      <svg {...ACTION_ICON_PROPS}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><polyline points="9 12 11 14 15 10" /></svg>
    );
  }
  if (value === "save_info") {
    return (
      <svg {...ACTION_ICON_PROPS}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
    );
  }
  if (value === "status:InformationRequested") {
    return (
      <svg {...ACTION_ICON_PROPS}><path d="M21 11.5a8.4 8.4 0 01-1 4 8.5 8.5 0 01-7.5 4.5 8.4 8.4 0 01-4-1L3 20l1-5.5a8.4 8.4 0 01-1-4A8.5 8.5 0 0111 3a8.5 8.5 0 0110 8.5z" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="15.5" x2="12" y2="15.51" /></svg>
    );
  }
  if (value === "status:UnderReview") {
    return (
      <svg {...ACTION_ICON_PROPS}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
    );
  }
  if (value === "status:Proposed") {
    return (
      <svg {...ACTION_ICON_PROPS}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
    );
  }
  return <svg {...ACTION_ICON_PROPS}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>;
}

function ActionDropdown({
  options, onApply, isOptionDisabled, getConfirmMessage, disabled, canAct, canDecide,
}: {
  options: ProposalActionOption[];
  onApply: (value: string) => void | Promise<void>;
  isOptionDisabled?: (value: string) => boolean;
  getConfirmMessage?: (option: ProposalActionOption) => string | undefined;
  disabled?: boolean;
  canAct: boolean;
  canDecide: boolean;
}) {
  const visible = options.filter((o) => (o.tier === "decision" ? canDecide : canAct));
  const [selected, setSelected] = useState(visible[0]?.value ?? "");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!visible.find((o) => o.value === selected)) {
      setSelected(visible[0]?.value ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((o) => o.value).join("|")]);

  if (visible.length === 0) return null;
  const selectedOption = visible.find((o) => o.value === selected) ?? null;
  const optionDisabled = selectedOption ? (isOptionDisabled?.(selectedOption.value) ?? false) : true;

  const dropdownOptions: FancyDropdownOption[] = visible.map((o) => ({
    value: o.value,
    label: o.label,
    icon: (
      <span className={o.tier === "decision" ? "text-rose-500" : "text-blue-500"}>
        <ActionIcon value={o.value} />
      </span>
    ),
  }));

  const handleApply = async () => {
    if (!selectedOption) return;
    const confirmMessage = getConfirmMessage?.(selectedOption);
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setApplying(true);
    try {
      await onApply(selectedOption.value);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <FancyDropdown
        value={selected}
        onChange={setSelected}
        options={dropdownOptions}
        disabled={disabled || applying}
        size="sm"
        className="min-w-[190px]"
      />
      <button
        onClick={handleApply}
        disabled={disabled || applying || optionDisabled}
        className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 ${
          selectedOption?.tier === "decision"
            ? "bg-rose-600 text-white hover:bg-rose-700"
            : "bg-blue-600 text-white hover:bg-blue-700"
        }`}
      >
        {applying ? (
          <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {applying ? "Applying…" : "Apply"}
      </button>
    </div>
  );
}

// ── Batch action bar (folder header) ──────────────────────────────────────────
// Reused across the Corporate/Family/Individual folder headers.

function BatchActionBar({
  selectedCount, totalCount, allSelected, onToggleAll, options, onApply, getConfirmMessage, disabled, canAct, canDecide,
}: {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  options: ProposalActionOption[];
  onApply: (value: string) => void | Promise<void>;
  getConfirmMessage?: (option: ProposalActionOption) => string | undefined;
  disabled: boolean;
  canAct: boolean;
  canDecide: boolean;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap border-b border-slate-200 bg-slate-50/50">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          checked={allSelected}
          onChange={onToggleAll}
        />
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          {selectedCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold">
              {selectedCount}
            </span>
          )}
          {selectedCount > 0 ? `of ${totalCount} plan(s) selected` : `${totalCount} plan(s) in this folder`}
        </p>
      </div>
      <ActionDropdown
        options={options}
        onApply={onApply}
        getConfirmMessage={getConfirmMessage}
        disabled={disabled}
        canAct={canAct}
        canDecide={canDecide}
      />
    </div>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────
// Shaped like whichever view is active, so the transition from "loading" to
// "here are your rows" doesn't jump — the skeleton already has the right
// silhouette instead of a generic centered spinner.

function ProposalsSkeleton({ viewMode }: { viewMode: "list" | "grid" }) {
  if (viewMode === "grid") {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4 animate-pulse">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="h-3.5 bg-slate-200 rounded w-2/3" />
            <div className="h-2.5 bg-slate-100 rounded w-1/3" />
            <div className="flex items-center justify-between">
              <div className="h-4 w-16 bg-slate-100 rounded-full" />
              <div className="h-3 w-10 bg-slate-100 rounded" />
            </div>
            <div className="h-12 bg-slate-100 rounded-lg" />
            <div className="flex justify-between pt-2 border-t border-slate-100">
              <div className="h-3 bg-slate-100 rounded w-1/4" />
              <div className="h-3 bg-slate-100 rounded w-1/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-2 py-2">
          <div className="w-4 h-4 rounded bg-slate-200 shrink-0" />
          <div className="flex-1 space-y-1.5 min-w-0">
            <div className="h-3.5 bg-slate-200 rounded w-1/3 max-w-[160px]" />
            <div className="h-2.5 bg-slate-100 rounded w-1/5 max-w-[100px]" />
          </div>
          <div className="h-5 w-20 bg-slate-100 rounded-full shrink-0" />
          <div className="h-3.5 w-20 bg-slate-100 rounded shrink-0" />
          <div className="h-3.5 w-20 bg-slate-100 rounded shrink-0" />
          <div className="h-3.5 w-16 bg-slate-100 rounded shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ── Level 3: Proposals Views ───────────────────────────────────────────────────

function ProposalsTable({
  quotes,
  selectedQuoteIds,
  toggleSelection,
  toggleAllInFolder,
  openQuote,
}: {
  quotes: QuoteListItem[];
  selectedQuoteIds: Set<string>;
  toggleSelection: (quoteId: string) => void;
  toggleAllInFolder: (quoteIds: string[]) => void;
  openQuote: (quoteId: string) => void;
}) {
  if (quotes.length === 0) return null;
  const allSelected = quotes.length > 0 && quotes.every(q => selectedQuoteIds.has(q.quote_id));

  return (
    <div className="overflow-x-auto bg-white w-full border-t border-slate-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <th className="px-5 py-3 text-left w-12">
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  checked={allSelected}
                  onChange={() => toggleAllInFolder(quotes.map(q => q.quote_id))}
                />
              </div>
            </th>
            <th className="px-5 py-3 text-left">Customer</th>
            <th className="px-2 py-3 text-left">Plan</th>
            <th className="px-5 py-3 text-left">Status</th>
            <th className="px-5 py-3 text-right">Coverage</th>
            <th className="px-5 py-3 text-center">Term</th>
            <th className="px-5 py-3 text-right">Premium</th>
            <th className="px-5 py-3 text-right">Risk</th>
            <th className="px-5 py-3 text-right">Total</th>
            <th className="px-5 py-3 text-left">Underwriter</th>
            <th className="px-5 py-3 text-left">Generated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {quotes.map((row) => (
            <tr
              key={row.quote_id}
              onClick={() => openQuote(row.quote_id)}
              className={`transition-colors cursor-pointer ${selectedQuoteIds.has(row.quote_id) ? "bg-blue-50/40" : "hover:bg-slate-50"}`}
            >
              <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    checked={selectedQuoteIds.has(row.quote_id)}
                    onChange={() => toggleSelection(row.quote_id)}
                  />
                </div>
              </td>
              <td className="px-5 py-3.5">
                <p className="text-slate-900 font-bold truncate max-w-[150px]" title={row.customer_name}>{row.customer_name}</p>
                <p className="text-slate-500 text-[10px] font-mono">{row.customer_cnic}</p>
                <p className="text-[11px] font-medium text-slate-500 mt-1">
                  Lead ID: {formatLeadDisplayId(row.customer_id, row.created_at, quoteSegment(row))}
                </p>
                {row.acquisition_source_name && (
                  <p className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[150px]" title={row.acquisition_source_name}>
                    {row.acquisition_source_name}
                  </p>
                )}
              </td>
              <td className="px-2 py-3.5">
                <p className="text-slate-700 font-medium">{row.plan_label}</p>
                <span className="inline-flex mt-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                  {INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type}
                </span>
              </td>
              <td className="px-5 py-3.5">
                <StatusBadge status={row.status} />
              </td>
              <td className="px-5 py-3.5 text-right font-medium text-slate-700">{formatPKR(row.coverage_amount)}</td>
              <td className="px-5 py-3.5 text-center text-slate-600">{row.term_years}y</td>
              <td className="px-5 py-3.5 text-right text-slate-600">{formatPKR(row.base_premium)}</td>
              <td className="px-5 py-3.5 text-right text-slate-600">{formatPKR(row.loading_applied)}</td>
              <td className="px-5 py-3.5 text-right font-bold text-slate-900">{formatPKR(row.total_premium)}</td>
              <td className="px-5 py-3.5">
                <UnderwriterAvatar name={row.assigned_underwriter_name} />
                <div className="mt-1">
                  <SlaHint status={row.sla_status} daysRemaining={row.sla_days_remaining} />
                </div>
              </td>
              <td className="px-5 py-3.5 text-slate-500 text-xs whitespace-nowrap">
                {new Date(row.created_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProposalsGrid({
  quotes,
  selectedQuoteIds,
  toggleSelection,
  openQuote,
}: {
  quotes: QuoteListItem[];
  selectedQuoteIds: Set<string>;
  toggleSelection: (quoteId: string) => void;
  toggleAllInFolder: (quoteIds: string[]) => void;
  openQuote: (quoteId: string) => void;
}) {
  if (quotes.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
      {quotes.map((row) => (
        <div
          key={row.quote_id}
          onClick={() => openQuote(row.quote_id)}
          className={`relative border rounded-xl p-4 flex flex-col gap-3 cursor-pointer transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg bg-white ${selectedQuoteIds.has(row.quote_id) ? "border-blue-300 ring-1 ring-blue-400/20 shadow-md" : "border-slate-200 shadow-sm"}`}
        >
          <div className="absolute top-3 right-3 z-10" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              checked={selectedQuoteIds.has(row.quote_id)}
              onChange={() => toggleSelection(row.quote_id)}
            />
          </div>

          <div className="pr-6">
            <h4 className="font-bold text-slate-900 truncate">{row.customer_name}</h4>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{row.customer_cnic}</p>
            <p className="text-[11px] font-medium text-slate-500 mt-1">
              Lead ID: {formatLeadDisplayId(row.customer_id, row.created_at, quoteSegment(row))}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2">
            <StatusBadge status={row.status} />
            <SlaHint status={row.sla_status} daysRemaining={row.sla_days_remaining} />
          </div>

          <div className="bg-slate-50 rounded-lg p-2.5 border border-slate-100 flex items-center justify-between">
            <div className="min-w-0 pr-2">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Plan</p>
              <p className="text-xs font-semibold text-slate-700 truncate">{row.plan_label}</p>
            </div>
            <span className="flex-shrink-0 inline-flex px-1.5 py-0.5 rounded-[4px] text-[9px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200">
              {INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type}
            </span>
          </div>

          <UnderwriterAvatar name={row.assigned_underwriter_name} />

          <div className="grid grid-cols-2 gap-3 mt-auto pt-2 border-t border-slate-100">
            <div>
              <p className="text-[10px] font-medium text-slate-500">Coverage</p>
              <p className="text-sm font-semibold text-slate-800">{formatPKR(row.coverage_amount)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-medium text-slate-500">Premium</p>
              <p className="text-sm font-bold text-emerald-600">{formatPKR(row.total_premium)}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}


// ── Detail modal ─────────────────────────────────────────────────────────────

function QuoteDetailModal({
  detail, loading, error, onClose, onStartUnderwriting, onRefresh, onStatusChange, canAct, canDecide
}: {
  detail: QuoteDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onStartUnderwriting: () => Promise<void>;
  onRefresh: () => void;
  onStatusChange: (newStatus: string) => void;
  canAct: boolean;
  canDecide: boolean;
}) {
  const [underwriters, setUnderwriters] = useState<Agent[]>([]);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) listUnderwriters(tenantId).then(setUnderwriters).catch(console.error);
  }, []);

  const underwriterOptions: FancyDropdownOption[] = useMemo(
    () => [
      { value: "", label: "Unassigned" },
      ...underwriters.map((u) => ({ value: u.id, label: u.full_name, description: u.email, icon: <UnderwriterInitial name={u.full_name} /> })),
    ],
    [underwriters]
  );

  const handleUpdate = async (updates: { status?: string; assigned_underwriter_id?: string | null }) => {
    if (!detail) return;
    setUpdating(true);
    try {
      await updateQuote(detail.quote_id, updates);
      onRefresh();
      onClose(); // Alternatively just refresh details, but close is simpler.
    } catch (err: any) {
      alert(err.message || "Update failed");
    } finally {
      setUpdating(false);
    }
  };

  const [startError, setStartError] = useState<string | null>(null);

  const missingFields = useMemo(() => {
    if (!detail) return [];
    const missing: { key: string; label: string; type: string }[] = [];
    if (!detail.customer_dob) missing.push({ key: 'date_of_birth', label: 'Date of Birth', type: 'date' });
    if (!detail.customer_gender) missing.push({ key: 'gender', label: 'Gender', type: 'select' });
    if (!detail.customer_occupation) missing.push({ key: 'occupation', label: 'Occupation', type: 'text' });
    if (!detail.customer_declared_income) missing.push({ key: 'declared_income', label: 'Annual Income', type: 'number' });
    return missing;
  }, [detail]);

  const [missingFormData, setMissingFormData] = useState<Record<string, any>>({});

  // Same option list (and the same reasoning for why Reject always tags
  // along) as the batch dropdown — see getAvailableActions above.
  const modalOptions = useMemo(() => {
    if (!detail) return [];
    return getAvailableActions(detail.status, missingFields.length > 0, false);
  }, [detail?.status, missingFields.length]);

  const handleApplyAction = async (value: string) => {
    if (!detail) return;
    setStartError(null);
    try {
      if (value === "underwriting") {
        await onStartUnderwriting();
        return;
      }
      if (value === "save_info") {
        const tenantId = localStorage.getItem("tenant_id");
        if (tenantId) await updateCustomer(tenantId, detail.customer_id, missingFormData);
      } else if (value.startsWith("status:")) {
        const newStatus = value.slice("status:".length);
        await updateQuote(detail.quote_id, { status: newStatus });
        // Jump to the destination tab so this lead is immediately visible
        // where it landed, instead of vanishing from the tab it was on.
        onStatusChange(newStatus);
      }
      onRefresh();
      onClose();
    } catch (err: any) {
      setStartError(err.message ?? "Failed to update.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px] flex items-start justify-center overflow-y-auto py-10 px-4"
      onClick={onClose}
    >
      <div
        className="modal-pop bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <p className="text-sm font-semibold text-slate-700">Proposal Details</p>
            {detail && <StatusBadge status={detail.status} />}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="py-16 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading details…</span>
          </div>
        )}

        {error && (
          <div className="p-5">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          </div>
        )}

        {detail && !loading && (
          <div className="p-5 space-y-5">
            {/* Proposal Statement */}
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-5 py-4 space-y-1.5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Proposal Statement</p>
                <span className="text-[10px] font-mono text-slate-400">Ref: {detail.quote_id.slice(0, 8).toUpperCase()}</span>
              </div>
              {detail.organization_name && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-600 font-semibold">
                  <OrgIcon className="w-3 h-3" />
                  Corporate — {detail.organization_name}
                  {detail.master_policy_label ? ` · ${detail.master_policy_label}` : ""}
                </p>
              )}
              {detail.family_group_name && (
                <p className="flex items-center gap-1.5 text-[11px] text-violet-600 font-semibold">
                  <FamilyIcon className="w-3 h-3" />
                  Family — {detail.family_group_name}
                  {detail.family_policy_label ? ` · ${detail.family_policy_label}` : ""}
                </p>
              )}
              <p className="text-sm text-slate-700 leading-relaxed">
                We are pleased to present the following insurance proposal for{" "}
                <span className="font-semibold text-slate-900">{detail.customer_name}</span>. Based on the
                information provided, we propose a{" "}
                <span className="font-semibold text-slate-900">
                  {INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type}
                </span>{" "}
                policy under the{" "}
                <span className="font-semibold text-slate-900">{detail.plan_label}</span>{" "}
                plan, providing a sum assured of{" "}
                <span className="font-semibold text-slate-900">{formatPKR(detail.coverage_amount)}</span>{" "}
                over a term of{" "}
                <span className="font-semibold text-slate-900">{detail.term_years} years</span>.
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">
                The total annual premium for this coverage is{" "}
                <span className="font-bold text-slate-900">{formatPKR(detail.total_premium)}</span>{" "}
                (expected premium of {formatPKR(detail.base_premium)} plus a risk of{" "}
                {formatPKR(detail.loading_applied)}). This proposal is valid subject to
                satisfactory underwriting assessment and is generated as of{" "}
                <span className="font-medium text-slate-800">{formatDate(detail.created_at)}</span>.
              </p>
            </div>

            <p className="text-[11px] text-slate-500 mt-1 mb-2 text-center italic">
              Opens an Underwriting case for this customer on this exact proposal — documents, AI risk scoring, and the final decision all happen there.
            </p>

            
            {/* Status and Underwriter Update */}
            <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">Assigned Underwriter</label>
                <FancyDropdown
                  className="w-full max-w-sm"
                  value={detail.assigned_underwriter_id || ""}
                  onChange={(v) => handleUpdate({ assigned_underwriter_id: v || null })}
                  options={underwriterOptions}
                  placeholder="Unassigned"
                  searchable={underwriters.length > 6}
                  disabled={updating}
                />
              </div>
            </div>

            {/* Headline */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{detail.customer_name}</h2>
                <p className="text-xs text-slate-400">{detail.customer_cnic}</p>
              </div>
              <p className="text-[11px] text-slate-400 text-right mt-1.5">
                Rate version {detail.rate_version} · Generated {new Date(detail.created_at).toLocaleString()}
              </p>
            </div>

            {/* Customer */}
            <section>
              <SectionLabel>Customer</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label="Date of Birth" value={`${formatDate(detail.customer_dob)} (${detail.customer_age} yrs)`} />
                <DetailField label="Gender" value={detail.customer_gender} />
                <DetailField label="Occupation" value={detail.customer_occupation} />
                <DetailField label="Annual Income" value={formatPKR(detail.customer_declared_income)} />
                <DetailField label="Smoker" value={detail.customer_is_smoker ? "Yes" : "No"} />
                <DetailField
                  label="Height / Weight"
                  value={`${detail.customer_height_cm} cm / ${detail.customer_weight_kg} kg${detail.customer_bmi ? ` (BMI ${detail.customer_bmi})` : ""}`}
                />
                {detail.acquisition_source_name && (
                  <DetailField
                    label="Lead Generated By"
                    value={`${detail.acquisition_source_name} (${SOURCE_TYPE_LABELS[detail.acquisition_source_type ?? ""] ?? detail.acquisition_source_type ?? ""})${detail.acquisition_source_partner ? ` — ${detail.acquisition_source_partner}` : ""}`}
                  />
                )}
              </div>
            </section>

            {/* Policy */}
            <section>
              <SectionLabel>Policy</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label="Plan" value={detail.plan_label} />
                <DetailField label="Type" value={INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type} />
                <DetailField label="Coverage" value={formatPKR(detail.coverage_amount)} />
                <DetailField label="Term" value={`${detail.term_years} years`} />
                {detail.organization_name && <DetailField label="Organization" value={detail.organization_name} />}
                {detail.master_policy_label && <DetailField label="Master Policy" value={detail.master_policy_label} />}
                {detail.family_group_name && <DetailField label="Family" value={detail.family_group_name} />}
                {detail.family_policy_label && <DetailField label="Family Policy" value={detail.family_policy_label} />}
                {detail.nominee_name && <DetailField label="Nominee" value={`${detail.nominee_name}${detail.nominee_relationship ? ` (${detail.nominee_relationship})` : ""}`} />}
                {detail.dependent_name && <DetailField label="Dependent" value={`${detail.dependent_name}${detail.dependent_dob ? ` — b. ${formatDate(detail.dependent_dob)}` : ""}`} />}
              </div>
            </section>

            {/* Premium breakdown */}
            <section>
              <SectionLabel>Premium Breakdown</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Premium" value={formatPKR(detail.base_premium)} />
                {/* <StatTile label="Risk" value={formatPKR(detail.loading_applied)} /> */}
                <StatTile
                  label="Total Payable"
                  value={
                    <span>
                      {formatPKR(detail.total_premium)}{" "}
                      <span className="text-[10px] font-medium text-slate-300"></span>
                    </span>
                  }
                  highlight
                />
              </div>
            </section>

            {/* Missing Information section */}
            {missingFields.length > 0 && detail.status === "Quoted" && (
              <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl">
                <p className="text-xs font-bold text-amber-700 uppercase tracking-widest mb-1">Missing Information</p>
                <p className="text-sm text-amber-600 mb-2">The following information is missing and must be completed:</p>
                <ul className="list-disc list-inside text-sm text-amber-700">
                  {missingFields.map(f => <li key={f.key}>{f.label}</li>)}
                </ul>
              </div>
            )}

            {missingFields.length > 0 && detail.status === "InformationRequested" && (
              <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl">
                <p className="text-xs font-bold text-blue-700 uppercase tracking-widest mb-3">Provide Missing Information</p>
                <div className="space-y-3">
                  {missingFields.map(f => (
                    <div key={f.key}>
                      <label className="text-xs font-semibold text-slate-700 block mb-1">{f.label}</label>
                      {f.type === 'select' ? (
                        <FancyDropdown
                          className="w-full"
                          value={missingFormData[f.key] || ''}
                          onChange={(v) => setMissingFormData({...missingFormData, [f.key]: v})}
                          placeholder={`Select ${f.label}`}
                          options={f.key === 'gender' ? [
                            { value: "Male", label: "Male" },
                            { value: "Female", label: "Female" },
                          ] : []}
                        />
                      ) : (
                        <input
                          type={f.type}
                          className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                          value={missingFormData[f.key] || ''}
                          onChange={e => setMissingFormData({...missingFormData, [f.key]: e.target.value})}
                          placeholder={`Enter ${f.label}`}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(detail.status === "Approved" || detail.status === "AcceptedWithLoadings" || detail.status === "Declined") && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500">
                This proposal's outcome was decided on its underwriting case, not here — open the case to review the decision.
              </div>
            )}

            {/* Dynamic action dropdown — only the moves legal from here */}
            {modalOptions.length > 0 && (
              <section className="pt-1 border-t border-slate-100 space-y-2">
                {startError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-1">{startError}</p>
                )}
                <ActionDropdown
                  options={modalOptions}
                  onApply={handleApplyAction}
                  isOptionDisabled={(value) => value === "save_info" && Object.keys(missingFormData).length === 0}
                  getConfirmMessage={(o) => (o.tier === "decision" ? "Reject this proposal? This cannot be undone." : undefined)}
                  canAct={canAct}
                  canDecide={canDecide}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">{children}</p>;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm text-slate-700 font-medium">{value}</p>
    </div>
  );
}

function StatTile({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-slate-900" : "bg-slate-50"}`}>
      <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${highlight ? "text-slate-300" : "text-slate-400"}`}>
        {label}
      </p>
      <p className={`text-sm font-bold ${highlight ? "text-white" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}
