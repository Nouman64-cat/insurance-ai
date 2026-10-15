"use client";

import { displayDate, displayDateTime } from '../../lib/dateDisplay';
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import api from "../services/api";
import { getQuote, listQuotes, QuoteDetail, QuoteListItem } from "../services/quotes";
import { MetricCard } from "@/components/MetricCard";
import { SegmentDropdown, SegmentFilter } from "@/components/SegmentDropdown";
import { type StatusFilter } from "@/components/StatusDropdown";
import { FancyDropdown, FancyDropdownOption } from "@/components/FancyDropdown";
import { fmtCoverage } from "@/lib/mock-data";

import { updateQuote } from "../services/quotes";
import { listUnderwriters, Agent } from "../services/agents";
import { listAcquisitionSources, AcquisitionSource } from "../services/acquisitionSources";
import { updateCustomer } from "../services/customers";
import { getPolicyIPP, requestPolicyPayment, type IPP } from "../services/initialPremiumPayment";
import { PaymentPanel } from "@/components/proposal/PaymentPanel";
import { listInsurancePlans, InsurancePlan } from "../services/insurancePlans";
import { getPlanValidationError } from "@/components/entities/customerShared";
import SourcePicker, { useAcquisitionSources } from "@/components/entities/SourcePicker";
import { Pagination, usePagination } from "@/components/Pagination";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { tx } from "@/lib/i18n/tx";
import { appHref, portalUrl } from "@/lib/appLinks";

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
  DIRECT: "Walk-in",
  DIGITAL: "Digital",
};

function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatDate(s: string): string {
  return displayDate(s, { year: "numeric", month: "long", day: "numeric" });
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
  { id: "ALL", label: "All" },
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
  Approved: "bg-blue-50 text-blue-700 border-blue-200",
  AcceptedWithLoadings: "bg-blue-50 text-blue-700 border-blue-200",
  Declined: "bg-rose-50 text-rose-700 border-rose-200",
  Issued: "bg-blue-50 text-blue-700 border-blue-200",
};

const STATUS_DOT: Record<string, string> = {
  Quoted: "bg-slate-400",
  Proposed: "bg-blue-500",
  UnderReview: "bg-amber-500",
  InformationRequested: "bg-amber-300",
  Approved: "bg-blue-500",
  AcceptedWithLoadings: "bg-blue-500",
  Declined: "bg-rose-500",
  Issued: "bg-blue-500",
};

function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const { tx } = useI18n();
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${
        STATUS_BADGE_STYLE[status] ?? "bg-slate-100 text-slate-600 border-slate-200"
      } ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[status] ?? "bg-slate-400"}`} />
      {tx(STATUS_LABEL[status] ?? status)}
    </span>
  );
}

const SLA_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  within_sla: { dot: "bg-blue-500", text: "text-blue-600", label: "On track" },
  approaching_breach: { dot: "bg-amber-500", text: "text-amber-600", label: "Due soon" },
  breached: { dot: "bg-rose-500", text: "text-rose-600", label: "SLA breached" },
};

function SlaHint({ status, daysRemaining }: { status: QuoteListItem["sla_status"]; daysRemaining: number | null }) {
  const { tx } = useI18n();
  if (!status) return null;
  const s = SLA_STYLE[status];
  if (!s) return null;
  const label = status !== "breached" && daysRemaining != null ? tx("{days}d left", { days: daysRemaining }) : tx(s.label);
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
  const { tx } = useI18n();
  if (!name) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
        <span className="w-5 h-5 rounded-full border border-dashed border-slate-300 flex items-center justify-center shrink-0">–</span>
        {tx("Unassigned")}
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

function getAvailableActions(
  status: string,
  hasMissingFields: boolean,
  forBatch: boolean,
  canSendToUnderwriting: boolean,
  isAgent: boolean,
  // Where the initial premium stands for an individual application under review: "due" (not asked for yet), "requested" (waiting on
  // the customer) until it clears, then "paid".
  // "none" for everything the payment step does not apply to (family and group policies, or a batch).
  payment: "none" | "due" | "requested" | "paid" = "none",
): ProposalActionOption[] {
  const opts: ProposalActionOption[] = [];

  // An Agent's part of the journey is the lead and the proposal: Submit it, and answer an
  // Info Request. Once it is submitted (Submitted / Under Review) it belongs to
  // underwriting and the Agent can only watch it, so no actions are offered at all.
  if (isAgent && (status === "Proposed" || status === "UnderReview")) return [];

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
    // An Agent's part of the journey stops here: sending to underwriting is for
    // Underwriters and above, so the option isn't offered to an Agent at all.
    if (canSendToUnderwriting) {
      // The initial premium is collected after the review has started; underwriting opens only once it has cleared.
      // The initial premium is paid by the customer (a link, a receipt or "I have paid", then staff confirm) or recorded by staff:
      // see PaymentPanel. Underwriting opens only once it has cleared.
      if (payment === "due") opts.push({ value: "payment_request", label: "Payment Required from Customer", tier: "submission" });
      else if (payment === "paid" || payment === "none") opts.push({ value: "underwriting", label: "Send to Underwriting", tier: "submission" });
    }
    opts.push({ value: "status:InformationRequested", label: "Request Info", tier: "submission" });
    // Undo an accidental Start Review — back to Submitted, no harm done.
    opts.push({ value: "status:Proposed", label: "Step Back to Submitted", tier: "submission" });
  } else if (status === "InformationRequested") {
    if (!forBatch && hasMissingFields) {
      opts.push({ value: "save_info", label: "Save Information", tier: "submission" });
    }
    opts.push({ value: "status:Proposed", label: "Re-Submit Application", tier: "submission" });
    opts.push({ value: "status:UnderReview", label: "Return to Under Review", tier: "submission" });
  } else {
    // Approved / AcceptedWithLoadings / Declined / Issued: no actions here —
    // these are outcomes reached only via the underwriting Case's decision.
    return [];
  }

  // "On hold" is offered at every one of those steps: it changes nothing and leaves the proposal exactly where it is.
  opts.push({ value: "hold", label: "On hold", tier: "submission" });

  // Reject is legal directly from any of the four statuses above
  // A Draft is still a proposal; once submitted it is an application.
  opts.push({ value: "status:Declined", label: status === "Quoted" ? "Reject Proposal" : "Reject Application", tier: "decision" });

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
  const { tx } = useI18n();
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");

  // Every proposal is shown until a stage chip is picked. Deliberately not remembered between visits:
  // the page always opens on "All proposals".
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
      { value: "", label: tx("All Underwriters") },
      ...underwriters.map((u) => ({ value: u.id, label: u.full_name, description: u.email, icon: <UnderwriterInitial name={u.full_name} /> })),
    ],
    [underwriters, tx]
  );

  const sourceFilterOptions: FancyDropdownOption[] = useMemo(
    () => [
      { value: "", label: tx("All Sources") },
      ...sources.map((s) => ({
        value: s.id,
        label: s.name,
        description: [tx(SOURCE_TYPE_LABELS[s.source_type] ?? s.source_type), s.partner_name].filter(Boolean).join(" · "),
      })),
    ],
    [sources, tx]
  );

  useEffect(() => {
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
  // Handing a proposal to underwriting is NOT an Agent action: an Agent prepares the
  // customer, plan and details and stops at Under Review. Anyone else who can act
  // on proposals (Underwriter and above) sends it on.
  const isAgent = userRole === "Agent";
  const canSendToUnderwriting = canActOnProposals && !isAgent;



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

  const [expandedOrgIds, setExpandedOrgIds] = useState<Set<string>>(new Set());
  const [expandedFamilyIds, setExpandedFamilyIds] = useState<Set<string>>(new Set());
  
  const toggleOrg = (orgId: string) => setExpandedOrgIds((prev) => {
    const next = new Set(prev);
    if (next.has(orgId)) next.delete(orgId);
    else next.add(orgId);
    return next;
  });
  
  const toggleFamily = (famId: string) => setExpandedFamilyIds((prev) => {
    const next = new Set(prev);
    if (next.has(famId)) next.delete(famId);
    else next.add(famId);
    return next;
  });



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
      setBulkProceedError(tx("Cannot proceed with an unquoted Draft. Please generate a Quotation in the Leads Hub first."));
      return;
    }

    setIsBulkProceeding(true);
    setBulkProceedError(null);
    setBulkProceedSuccess(null);
    try {
      const tenantId = localStorage.getItem("tenant_id");
      if (!tenantId) throw new Error(tx("Tenant ID not found"));

      // Individual applications cannot open underwriting until their initial premium has cleared.
      const unpaid: string[] = [];
      for (const q of selectedQuotes) {
        if (q.master_policy_id || q.family_policy_id) continue;
        const paid = await getPolicyIPP(q.policy_id).then((r) => r.status === "Realized", () => false);
        if (!paid) unpaid.push(q.plan_label || q.customer_name);
      }
      if (unpaid.length > 0) {
        setBulkProceedError(tx("Collect the initial premium first (open each application): {list}", { list: unpaid.join(", ") }));
        setIsBulkProceeding(false);
        return;
      }

      if (selectedQuotes.length === 1) {
        const q = selectedQuotes[0];
        const caseRes = await api.post(`/tenants/${tenantId}/cases`, {
          customer_id: q.customer_id,
          policy_id: q.policy_id,
          caseType: "Underwriting",
          sourceChannel: "Online",
        });
        router.push(appHref(`/case/${caseRes.data.caseld}?autoRun=true`));
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
      router.push(appHref(`/case/${group[0].caseId}?autoRun=true`));

      setSelectedProposalIds(new Set());
    } catch (err: any) {
      setBulkProceedError(err.message ?? tx("Failed to initialize bulk processing."));
    } finally {
      setIsBulkProceeding(false);
    }
  };

  const handleBulkStatusUpdate = async (customerQuotes: QuoteListItem[], targetStatus: string) => {
    const selectedQuotes = customerQuotes.filter((q) => selectedQuoteIds.has(q.quote_id));
    if (selectedQuotes.length === 0) return;
    
    if (selectedQuotes.some((q) => q.quote_id.startsWith("draft-"))) {
      setBulkProceedError(tx("Cannot change status of an unquoted Draft. Please generate a Quotation in the Leads Hub first."));
      return;
    }

    setIsBulkProceeding(true);
    setBulkProceedError(null);
    setBulkProceedSuccess(null);
    try {
      await Promise.all(
        selectedQuotes.map((q) => updateQuote(q.quote_id, { status: targetStatus }))
      );
      setBulkProceedSuccess(tx("Successfully updated statuses."));
      fetchQuotes();
      setSelectedProposalIds(new Set());
      // With a stage chip on, follow the moved proposals to their new stage instead of letting them vanish.
      if (activeTab !== "ALL") setActiveTab(targetStatus as StatusFilter);
    } catch (err: any) {
      setBulkProceedError(err.message ?? tx("Failed to update statuses."));
    } finally {
      setIsBulkProceeding(false);
    }
  };

  // Same option list the per-lead modal uses (getAvailableActions), just with
  // forBatch=true so it doesn't try to reason about any one customer's
  // missing fields — both Submit and Send-to-Info-Requested are offered
  // together and the underwriter picks whichever fits the selected batch.
  // With every proposal on one list there is no status tab to take the batch actions from, so they come from the
  // proposals ticked in the folder: when they all share a status its moves are offered, otherwise none.
  const batchOptionsFor = (folderQuotes: QuoteListItem[]) => {
    const statuses = Array.from(new Set(folderQuotes.filter((q) => selectedQuoteIds.has(q.quote_id)).map((q) => q.status)));
    return statuses.length === 1 ? getAvailableActions(statuses[0], false, true, canSendToUnderwriting, isAgent) : [];
  };

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
    option.tier === "decision" ? tx("Reject {count} selected? This cannot be undone.", { count: selectedCount }) : undefined;

  const openQuote = useCallback(async (quoteId: string) => {
    if (quoteId.startsWith("draft-")) {
      alert(tx("This is an unquoted draft lead. Please go to the Leads Hub and generate a Quotation for this customer before proceeding here."));
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
      setDetailError(err.message ?? tx("Failed to load quotation details."));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // Re-read the open proposal in place (no spinner, nothing closes), after one of its moves.
  const reloadDetail = useCallback(async () => {
    if (!selectedQuoteId) return;
    try { setDetail(await getQuote(selectedQuoteId)); } catch { /* keep what is on screen */ }
  }, [selectedQuoteId]);

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

      // Fetch customers an agent has explicitly sent here with "Send Draft" on the
      // Leads board (profile_status DRAFT) that don't have a real quote yet, so they
      // show up in the Draft tab. Leads and In Progress customers stay on the Leads
      // board until sent. `customers` has no server-side status filter, so the
      // split happens client-side here.
      const tenantId = localStorage.getItem("tenant_id");
      if (tenantId) {
        try {
          const draftRes = await api.get(`/tenants/${tenantId}/customers`);
          if (draftRes.data && Array.isArray(draftRes.data)) {
            const pipelineCustomers = draftRes.data.filter(
              (c: any) => c.profile_status === "DRAFT"
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
      setError(err.message ?? tx("Failed to load quotations."));
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

  const countEntities = (qs: QuoteListItem[]) => {
    const indQuotes = qs.filter((q) => quoteSegment(q) === "individual");
    const orgQuotes = qs.filter((q) => quoteSegment(q) === "organization");
    const famQuotes = qs.filter((q) => quoteSegment(q) === "family");
    
    const numInd = dedupeQuotesByCustomer(indQuotes).length;
    const numOrg = new Set(orgQuotes.map((q) => q.organization_id).filter(Boolean)).size;
    const numFam = new Set(famQuotes.map((q) => q.family_group_id).filter(Boolean)).size;
    
    return numInd + numOrg + numFam;
  };

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<StatusFilter, number>> = { ALL: countEntities(quotes) };
    for (const tab of STATUS_TABS) {
      if (tab.id === "ALL") continue;
      counts[tab.id as StatusFilter] = countEntities(quotes.filter((q) => q.status === tab.id));
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
    const counts: Partial<Record<SegmentFilter, number>> = {};
    
    // Individual: count unique customers
    const indQuotes = statusFilteredQuotes.filter((q) => quoteSegment(q) === "individual");
    counts["individual"] = dedupeQuotesByCustomer(indQuotes).length;

    // Organization: count unique organizations
    const orgQuotes = statusFilteredQuotes.filter((q) => quoteSegment(q) === "organization");
    const uniqueOrgs = new Set(orgQuotes.map((q) => q.organization_id).filter(Boolean));
    counts["organization"] = uniqueOrgs.size;

    // Family: count unique families
    const famQuotes = statusFilteredQuotes.filter((q) => quoteSegment(q) === "family");
    const uniqueFams = new Set(famQuotes.map((q) => q.family_group_id).filter(Boolean));
    counts["family"] = uniqueFams.size;

    // All: sum of unique entities
    counts["all"] = (counts["individual"] || 0) + (counts["organization"] || 0) + (counts["family"] || 0);

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
      { title: activeTab === "Quoted" ? tx("Proposals") : activeTab === "ALL" ? tx("Proposals & Applications") : tx("Applications"), value: fullyFilteredQuotes.length, subtitle: tx("plans generated"), accent: "blue" as const, icon: <KpiIcon name="document" /> },
      { title: tx("Total Coverage"), value: fullyFilteredQuotes.length > 0 ? fmtCoverage(totalCoverage) : "—", subtitle: tx("sum assured"), accent: "blue" as const, icon: <KpiIcon name="shield" /> },
      { title: tx("Total Premium"), value: fullyFilteredQuotes.length > 0 ? fmtCoverage(totalPremium) : "—", subtitle: tx("annualized"), accent: "blue" as const, icon: <KpiIcon name="coin" /> },
    ];
  }, [segmentQuotes, search, tx]);

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

  // Individual customers' proposals are the long list here, so they are paged; the
  // corporate / family folders are already grouped and open on demand.
  const individualQuotes = useMemo(() => individualGroups.flatMap((g) => g.quotes), [individualGroups]);
  const { pageItems: pagedIndividualQuotes, pagination: individualPagination } = usePagination(individualQuotes);
  const activeTabLabel = tx(STATUS_TABS.find((t) => t.id === activeTab)?.label ?? activeTab);
  // A draft is a proposal; from Submitted onward it is an application.
  const entryNoun = activeTab === "Quoted" ? "proposals" : activeTab === "ALL" ? "proposals & applications" : "applications";
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
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Proposals & Applications")}</h1>
            <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">
              {tx("A draft is a proposal. Once it is submitted it becomes an application and moves through review and underwriting. Corporate entries nest by organization and master policy; family entries by family and floater/life-bundle policy.")}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold tracking-wide font-mono shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          {tx("GET /quotes")}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k) => <MetricCard key={k.title} {...k} />)}
      </div>

      <div className="flex flex-col gap-3">
        {/* Stage filter: one tap to see only the proposals at that stage, with how many; "All proposals" until one is picked */}
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={tx("Stage")}>
          {STATUS_TABS.map((t) => {
            const on = activeTab === t.id;
            const dot: Record<string, string> = {
              ALL: "bg-slate-400", Quoted: "bg-slate-400", Proposed: "bg-blue-500", UnderReview: "bg-amber-500",
              InformationRequested: "bg-amber-300", Approved: "bg-emerald-500", Declined: "bg-rose-500", Issued: "bg-emerald-500",
            };
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setActiveTab(t.id as StatusFilter)}
                className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  on ? "border-blue-600 bg-blue-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                {t.id !== "ALL" && <span className={`h-2 w-2 rounded-full ${on ? "bg-white" : dot[t.id] ?? "bg-slate-400"}`} />}
                {tx(t.label)}
                <span className={`tabular-nums ${on ? "text-blue-100" : "text-slate-400"}`}>{statusCounts[t.id as StatusFilter] ?? 0}</span>
              </button>
            );
          })}
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
            {filtersOpen ? tx("Hide Filters") : tx("Advanced Filters")}
            {activeFilterCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white">{activeFilterCount}</span>
            )}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs font-semibold text-slate-400 hover:text-slate-600 transition-colors">
              {tx("Clear filters")}
            </button>
          )}
        </div>
        {filtersOpen && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{tx("Created From")}</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{tx("Created To")}</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{tx("Underwriter")}</label>
              <FancyDropdown
                value={agentFilter}
                onChange={setAgentFilter}
                options={underwriterFilterOptions}
                placeholder={tx("All Underwriters")}
                searchable={underwriters.length > 6}
                size="sm"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{tx("Source")}</label>
              <FancyDropdown
                value={sourceFilter}
                onChange={setSourceFilter}
                options={sourceFilterOptions}
                placeholder={tx("All Sources")}
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder={tx("Search by customer, CNIC, organization, or plan…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full ps-9 pe-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
            />
          </div>
          <SegmentDropdown value={segment} onChange={setSegment} counts={segmentCounts} />
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner border border-slate-200/60 shrink-0">
            <button
              onClick={() => setViewMode("list")}
              title={tx("List View")}
              className={`p-2 rounded-lg transition-all ${viewMode === "list" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
            </button>
            <button
              onClick={() => setViewMode("grid")}
              title={tx("Grid View")}
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
            {tx("Refresh")}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">{tx("Error")}</p>
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
                ? tx("No proposals or applications yet")
                : segmentQuotes.length === 0
                  ? activeTab === "ALL" ? tx("No proposals or applications") : activeTab === "Quoted" ? tx("No proposals in “{stage}”", { stage: activeTabLabel }) : tx("No applications in “{stage}”", { stage: activeTabLabel })
                  : tx("No {0} match your search", { 0: tx(entryNoun) })}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
              {quotes.length === 0
                ? tx("Send a lead to Draft from the Leads page and its proposal will appear here.")
                : segmentQuotes.length === 0
                  ? tx("Try a different stage or switch the segment filter to All Cases.")
                  : tx("Try a different customer name, CNIC, organization, or plan.")}
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {organizationGroups.length > 0 && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-600 px-1">
                  <OrgIcon className="w-3.5 h-3.5" />
                  {tx("Corporate / Group Life")}
                  <span className="text-slate-400 font-medium normal-case tracking-normal">
                    · {tx(organizationGroups.length === 1 ? "{count} organization" : "{count} organizations", { count: organizationGroups.length })} ·{" "}
                    {tx("{count} insured", { count: organizationGroups.reduce((n, o) => n + o.policies.reduce((m, p) => m + p.customers.length, 0), 0) })}
                  </span>
                </p>
                {organizationGroups.map((org) => {
                  const allOrgQuotes = org.policies.flatMap(p => p.customers.flatMap(c => c.quotes));
                  const selectedQuotes = allOrgQuotes.filter(q => selectedQuoteIds.has(q.quote_id));
                  const selectedOrgCount = selectedQuotes.length;
                  const allSelected = allOrgQuotes.length > 0 && selectedOrgCount === allOrgQuotes.length;
                  const isExpanded = expandedOrgIds.has(org.organization_id);

                  return (
                    <div key={org.organization_id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col mb-4">
                      <div 
                        className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition-colors border-b border-slate-100"
                        onClick={() => toggleOrg(org.organization_id)}
                      >
                        <div className="flex items-center gap-3">
                           <div className="flex items-center justify-center w-8 h-8 rounded-md bg-amber-50 text-amber-600 border border-amber-100/50 shadow-sm">
                             <OrgIcon className="w-4 h-4" />
                           </div>
                           <div>
                             <h4 className="text-sm font-bold text-slate-900">{org.organization_name}</h4>
                             <p className="text-[11px] font-medium text-slate-500 mt-0.5">{tx("{count} insured", { count: allOrgQuotes.length })}</p>
                           </div>
                        </div>
                        <div>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                             <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                        </div>
                      </div>
                      
                      {isExpanded && (
                        <div className="flex flex-col bg-slate-50/50">
                          <BatchActionBar
                            selectedCount={selectedOrgCount}
                            totalCount={allOrgQuotes.length}
                            allSelected={allSelected}
                            onToggleAll={() => toggleAllInFolder(allOrgQuotes.map(q => q.quote_id))}
                            options={batchOptionsFor(allOrgQuotes)}
                            onApply={(value) => handleBatchApply(value, allOrgQuotes)}
                            getConfirmMessage={(o) => getBatchConfirmMessage(o, selectedOrgCount)}
                            disabled={isBulkProceeding || selectedOrgCount === 0}
                            canAct={canActOnProposals}
                            canDecide={canDecideProposals}
                          />
                          {viewMode === 'grid' ? (
                            <div className="p-4">
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
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {familyGroups.length > 0 && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-blue-600 px-1">
                  <FamilyIcon className="w-3.5 h-3.5" />
                  {tx("Family Insurance")}
                  <span className="text-slate-400 font-medium normal-case tracking-normal">
                    · {tx(familyGroups.length === 1 ? "{count} family" : "{count} families", { count: familyGroups.length })} ·{" "}
                    {tx("{count} insured", { count: familyGroups.reduce((n, f) => n + f.policies.reduce((m, p) => m + p.customers.length, 0), 0) })}
                  </span>
                </p>
                {familyGroups.map((family) => {
                  const allFamQuotes = family.policies.flatMap(p => p.customers.flatMap(c => c.quotes));
                  const selectedQuotes = allFamQuotes.filter(q => selectedQuoteIds.has(q.quote_id));
                  const selectedFamCount = selectedQuotes.length;
                  const allSelected = allFamQuotes.length > 0 && selectedFamCount === allFamQuotes.length;
                  const isExpanded = expandedFamilyIds.has(family.family_group_id);

                  return (
                    <div key={family.family_group_id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col mb-4">
                      <div 
                        className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition-colors border-b border-slate-100"
                        onClick={() => toggleFamily(family.family_group_id)}
                      >
                        <div className="flex items-center gap-3">
                           <div className="flex items-center justify-center w-8 h-8 rounded-md bg-violet-50 text-violet-600 border border-violet-100/50 shadow-sm">
                             <FamilyIcon className="w-4 h-4" />
                           </div>
                           <div>
                             <h4 className="text-sm font-bold text-slate-900">{family.family_group_name}</h4>
                             <p className="text-[11px] font-medium text-slate-500 mt-0.5">{tx("{count} insured", { count: allFamQuotes.length })}</p>
                           </div>
                        </div>
                        <div>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                             <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                        </div>
                      </div>
                      
                      {isExpanded && (
                        <div className="flex flex-col bg-slate-50/50">
                          <BatchActionBar
                            selectedCount={selectedFamCount}
                            totalCount={allFamQuotes.length}
                            allSelected={allSelected}
                            onToggleAll={() => toggleAllInFolder(allFamQuotes.map(q => q.quote_id))}
                            options={batchOptionsFor(allFamQuotes)}
                            onApply={(value) => handleBatchApply(value, allFamQuotes)}
                            getConfirmMessage={(o) => getBatchConfirmMessage(o, selectedFamCount)}
                            disabled={isBulkProceeding || selectedFamCount === 0}
                            canAct={canActOnProposals}
                            canDecide={canDecideProposals}
                          />
                          {viewMode === 'grid' ? (
                            <div className="p-4">
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
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {individualGroups.length > 0 && (
              <div className="space-y-3">
                {(organizationGroups.length > 0 || familyGroups.length > 0) && (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-blue-600 px-1 pt-1">
                    {tx("Individual")}
                    <span className="text-slate-400 font-medium normal-case tracking-normal">
                      {" "}· {tx(individualGroups.length === 1 ? "{count} customer" : "{count} customers", { count: individualGroups.length })}
                    </span>
                  </p>
                )}
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                  {(() => {
                    const allIndividualQuotes = individualQuotes;
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
                          options={batchOptionsFor(allIndividualQuotes)}
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
                          <div className="mx-4 mt-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p className="text-xs text-blue-700 font-semibold">{tx("Success")}</p>
                            <p className="text-xs text-blue-600">{bulkProceedSuccess}</p>
                          </div>
                        )}
                        {viewMode === 'grid' ? (
                          <div className="p-4 bg-slate-50/30">
                            <ProposalsGrid
                              quotes={pagedIndividualQuotes}
                              selectedQuoteIds={selectedQuoteIds}
                              toggleSelection={toggleSelection}
                              toggleAllInFolder={toggleAllInFolder}
                              openQuote={openQuote}
                            />
                          </div>
                        ) : (
                          <ProposalsTable
                            quotes={pagedIndividualQuotes}
                            selectedQuoteIds={selectedQuoteIds}
                            toggleSelection={toggleSelection}
                            toggleAllInFolder={toggleAllInFolder}
                            openQuote={openQuote}
                          />
                        )}
                        <Pagination pagination={individualPagination} noun={tx(entryNoun)} inline />
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
          onReloadDetail={reloadDetail}
          onStatusChange={(newStatus) => { if (activeTab !== "ALL") setActiveTab(newStatus as StatusFilter); }}
          canAct={canActOnProposals}
          canDecide={canDecideProposals}
          canSendToUnderwriting={canSendToUnderwriting}
          isAgent={isAgent}
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
            router.push(appHref(`/case/${caseId}?autoRun=true`));
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
  if (value === "hold") {
    return (
      <svg {...ACTION_ICON_PROPS}><line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" /></svg>
    );
  }
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
  if (value === "payment_request") {
    return (
      <svg {...ACTION_ICON_PROPS}><path d="M4 4h16v12H5.2L4 17.2V4z" /><polyline points="4 6 12 12 20 6" /></svg>
    );
  }
  if (value === "payment") {
    return (
      <svg {...ACTION_ICON_PROPS}><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
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
  const { tx } = useI18n();
  const visible = options.filter((o) => (o.tier === "decision" ? canDecide : canAct));
  const [selected, setSelected] = useState(visible[0]?.value ?? "");
  const [applying, setApplying] = useState(false);
  const [held, setHeld] = useState(false);

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
    label: tx(o.label),
    icon: (
      <span className={o.tier === "decision" ? "text-rose-500" : "text-blue-500"}>
        <ActionIcon value={o.value} />
      </span>
    ),
  }));

  const handleApply = async () => {
    if (!selectedOption) return;
    if (selectedOption.value === "hold") {
      // Deliberately does nothing: no status change, no request. The note only confirms it.
      setHeld(true);
      window.setTimeout(() => setHeld(false), 4000);
      return;
    }
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
    <div className="flex flex-wrap items-center gap-2">
      <FancyDropdown
        value={selected}
        onChange={(v) => { setSelected(v); setHeld(false); }}
        options={dropdownOptions}
        disabled={disabled || applying}
        size="sm"
        className="min-w-[190px]"
      />
      <button
        onClick={handleApply}
        disabled={disabled || applying || optionDisabled}
        className={`inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
          selectedOption?.tier === "decision"
            ? "bg-rose-600 text-white hover:bg-rose-700 shadow-rose-600/20 focus-visible:ring-rose-500"
            : "bg-blue-600 text-white hover:bg-blue-700 shadow-blue-600/25 focus-visible:ring-blue-500"
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
        {applying ? tx("Applying…") : tx("Apply")}
      </button>
      {held && (
        <span role="status" className="text-xs font-semibold text-blue-700">{tx("On hold — nothing was changed.")}</span>
      )}
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
  const { tx } = useI18n();
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
          {selectedCount > 0 ? tx("of {count} plan(s) selected", { count: totalCount }) : tx("{count} plan(s) in this folder", { count: totalCount })}
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
  const { tx } = useI18n();
  if (quotes.length === 0) return null;
  const allSelected = quotes.length > 0 && quotes.every(q => selectedQuoteIds.has(q.quote_id));

  return (
    <div className="overflow-x-auto bg-white w-full border-t border-slate-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <th className="px-5 py-3 text-start w-12">
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  checked={allSelected}
                  onChange={() => toggleAllInFolder(quotes.map(q => q.quote_id))}
                />
              </div>
            </th>
            <th className="px-5 py-3 text-start">{tx("Customer")}</th>
            <th className="px-2 py-3 text-start">{tx("Plan")}</th>
            <th className="px-5 py-3 text-start">{tx("Status")}</th>
            <th className="px-5 py-3 text-end">{tx("Coverage")}</th>
            <th className="px-5 py-3 text-center">{tx("Term")}</th>
            <th className="px-5 py-3 text-end">{tx("Premium")}</th>
            <th className="px-5 py-3 text-end">{tx("Risk")}</th>
            <th className="px-5 py-3 text-end">{tx("Total")}</th>
            <th className="px-5 py-3 text-start">{tx("Underwriter")}</th>
            <th className="px-5 py-3 text-start">{tx("Generated")}</th>
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
                  {tx("Lead ID:")} {formatLeadDisplayId(row.customer_id, row.created_at, quoteSegment(row))}
                </p>
                {row.acquisition_source_name && (
                  // Labelled with what the source is (Agent, Broker, Bancassurance…), so a name never stands alone.
                  <p
                    className="text-[11px] font-medium text-slate-500 mt-0.5 truncate max-w-[180px]"
                    title={`${tx(SOURCE_TYPE_LABELS[row.acquisition_source_type ?? ""] ?? "Source")}: ${row.acquisition_source_name}`}
                  >
                    {tx(SOURCE_TYPE_LABELS[row.acquisition_source_type ?? ""] ?? "Source")}:{" "}
                    <span className="text-slate-700">{row.acquisition_source_name}</span>
                  </p>
                )}
              </td>
              <td className="px-2 py-3.5">
                <p className="text-slate-700 font-medium">{row.plan_label}</p>
                <span className="inline-flex mt-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                  {tx(INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type)}
                </span>
              </td>
              <td className="px-5 py-3.5">
                <StatusBadge status={row.status} />
              </td>
              <td className="px-5 py-3.5 text-end font-medium text-slate-700">{formatPKR(row.coverage_amount)}</td>
              <td className="px-5 py-3.5 text-center text-slate-600">{tx("{years}y", { years: row.term_years })}</td>
              <td className="px-5 py-3.5 text-end text-slate-600">{formatPKR(row.base_premium)}</td>
              <td className="px-5 py-3.5 text-end text-slate-600">{formatPKR(row.loading_applied)}</td>
              <td className="px-5 py-3.5 text-end font-bold text-slate-900">{formatPKR(row.total_premium)}</td>
              <td className="px-5 py-3.5">
                <UnderwriterAvatar name={row.assigned_underwriter_name} />
                <div className="mt-1">
                  <SlaHint status={row.sla_status} daysRemaining={row.sla_days_remaining} />
                </div>
              </td>
              <td className="px-5 py-3.5 text-slate-500 text-xs whitespace-nowrap">
                {displayDate(row.created_at)}
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
  const { tx } = useI18n();
  if (quotes.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
      {quotes.map((row) => (
        <div
          key={row.quote_id}
          onClick={() => openQuote(row.quote_id)}
          className={`relative border rounded-xl p-4 flex flex-col gap-3 cursor-pointer transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg bg-white ${selectedQuoteIds.has(row.quote_id) ? "border-blue-300 ring-1 ring-blue-400/20 shadow-md" : "border-slate-200 shadow-sm"}`}
        >
          <div className="absolute top-3 end-3 z-10" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              checked={selectedQuoteIds.has(row.quote_id)}
              onChange={() => toggleSelection(row.quote_id)}
            />
          </div>

          <div className="pe-6">
            <h4 className="font-bold text-slate-900 truncate">{row.customer_name}</h4>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{row.customer_cnic}</p>
            <p className="text-[11px] font-medium text-slate-500 mt-1">
              {tx("Lead ID:")} {formatLeadDisplayId(row.customer_id, row.created_at, quoteSegment(row))}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2">
            <StatusBadge status={row.status} />
            <SlaHint status={row.sla_status} daysRemaining={row.sla_days_remaining} />
          </div>

          <div className="bg-slate-50 rounded-lg p-2.5 border border-slate-100 flex items-center justify-between">
            <div className="min-w-0 pe-2">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{tx("Plan")}</p>
              <p className="text-xs font-semibold text-slate-700 truncate">{row.plan_label}</p>
            </div>
            <span className="flex-shrink-0 inline-flex px-1.5 py-0.5 rounded-[4px] text-[9px] font-bold bg-blue-100 text-blue-700 border border-blue-200">
              {tx(INSURANCE_TYPE_LABELS[row.insurance_type] ?? row.insurance_type)}
            </span>
          </div>

          <UnderwriterAvatar name={row.assigned_underwriter_name} />

          <div className="grid grid-cols-2 gap-3 mt-auto pt-2 border-t border-slate-100">
            <div>
              <p className="text-[10px] font-medium text-slate-500">{tx("Coverage")}</p>
              <p className="text-sm font-semibold text-slate-800">{formatPKR(row.coverage_amount)}</p>
            </div>
            <div className="text-end">
              <p className="text-[10px] font-medium text-slate-500">{tx("Premium")}</p>
              <p className="text-sm font-bold text-blue-600">{formatPKR(row.total_premium)}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}


// ── Detail modal ─────────────────────────────────────────────────────────────

// The three moves a proposal makes on its way to underwriting. `current` is the one waiting to be done:
// Draft waits on Submit, Submitted on Start Review, Under Review on Send to Underwriting. Past that, all done.
// Individual applications pay the initial premium between the review and underwriting, so they have a fourth step.
const STEP_SUBMIT = { label: "Submit proposal" };
const STEP_REVIEW = { label: "Start review" };
const STEP_PAYMENT = { label: "Initial payment" };
const STEP_UNDERWRITING = { label: "Send to underwriting" };

function proposalSteps(withPayment: boolean) {
  return (withPayment ? [STEP_SUBMIT, STEP_REVIEW, STEP_PAYMENT, STEP_UNDERWRITING] : [STEP_SUBMIT, STEP_REVIEW, STEP_UNDERWRITING])
    .map((st, i) => ({ n: i + 1, label: st.label }));
}

function proposalProgress(status: string, withPayment: boolean, paid: boolean): { current: number; note?: string; tone?: "amber" | "red" } {
  const last = withPayment ? 4 : 3;
  switch (status) {
    case "Quoted": return { current: 1 };
    case "InformationRequested": return { current: 1, note: "Info requested: add the details and re-submit", tone: "amber" };
    case "Proposed": return { current: 2 };
    case "UnderReview": return { current: withPayment && paid ? last : withPayment ? 3 : last };
    case "Declined": return { current: last + 1, note: "Rejected", tone: "red" };
    default: return { current: last + 1 };          // approved, issued...: the whole path is behind it
  }
}

function ProposalProgress({ status, withPayment = false, paid = false }: { status: string; withPayment?: boolean; paid?: boolean }) {
  const { tx } = useI18n();
  const { current, note, tone } = proposalProgress(status, withPayment, paid);
  const PROPOSAL_STEPS_UI = proposalSteps(withPayment);
  return (
    <div>
      <ol className="flex items-start" aria-label={tx("Progress")}>
        {PROPOSAL_STEPS_UI.map((st, i) => {
          const done = st.n < current;
          const now = st.n === current;
          return (
            <li key={st.n} className="flex flex-1 items-start last:flex-none">
              <div className="flex w-28 flex-col items-center gap-1.5 text-center">
                <span
                  className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-500 ${
                    done ? "bg-blue-600 text-white" : now ? (tone === "amber" ? "bg-amber-500 text-white" : "bg-blue-600 text-white") : "bg-blue-50 text-blue-300"
                  }`}
                  aria-current={now ? "step" : undefined}
                >
                  {now && <span className="absolute -inset-1.5 -z-10 rounded-full bg-blue-100/80" aria-hidden="true" />}
                  {done ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : now ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 animate-spin" style={{ animationDuration: "3s" }}>
                      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />
                    </svg>
                  ) : (
                    <span className="text-xs font-bold">{st.n}</span>
                  )}
                </span>
                <span className={`text-[11px] font-semibold leading-tight ${done || now ? "text-slate-700" : "text-slate-400"}`}>
                  {st.n}. {tx(st.label)}
                </span>
              </div>
              {i < PROPOSAL_STEPS_UI.length - 1 && (
                <span className="mt-[1.125rem] h-0.5 flex-1 bg-blue-100" aria-hidden="true">
                  <span className={`block h-full bg-blue-600 transition-all duration-500 ${done ? "w-full" : "w-0"}`} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {note && (
        <p className={`mt-3 text-center text-xs font-semibold ${tone === "red" ? "text-rose-600" : "text-amber-600"}`}>{tx(note)}</p>
      )}
    </div>
  );
}

function QuoteDetailModal({
  detail, loading, error, onClose, onStartUnderwriting, onRefresh, onReloadDetail, onStatusChange, canAct, canDecide, canSendToUnderwriting, isAgent
}: {
  detail: QuoteDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onStartUnderwriting: () => Promise<void>;
  onRefresh: () => void;
  /** Re-read this proposal so its status (and the progress steps) update while the window stays open. */
  onReloadDetail: () => Promise<void>;
  onStatusChange: (newStatus: string) => void;
  canAct: boolean;
  canDecide: boolean;
  canSendToUnderwriting: boolean;
  isAgent: boolean;
}) {
  const { locale, tx } = useI18n();

  const [startError, setStartError] = useState<string | null>(null);
  // The initial premium (individual applications only): collected after the review starts, and it must clear before
  // the underwriting case can open.
  const hasPaymentStep = !!detail && !detail.master_policy_id && !detail.family_policy_id && !String(detail.policy_id ?? "").startsWith("draft-");
  const [ipp, setIpp] = useState<IPP | null>(null);
  const loadIpp = useCallback(async () => {
    if (!detail || !hasPaymentStep || detail.status !== "UnderReview") { setIpp(null); return; }
    try { setIpp(await getPolicyIPP(detail.policy_id)); } catch { setIpp(null); }
  }, [detail?.policy_id, detail?.status, hasPaymentStep]);
  useEffect(() => { loadIpp(); }, [loadIpp]);
  // While the customer is paying from their side, pick up their screenshot without anyone reloading the page.
  useEffect(() => {
    if (!hasPaymentStep || detail?.status !== "UnderReview" || !ipp?.requested_at || ipp.status === "Realized") return;
    const id = setInterval(() => { if (document.visibilityState === "visible") loadIpp(); }, 15000);
    return () => clearInterval(id);
  }, [hasPaymentStep, detail?.status, ipp?.requested_at, ipp?.status, loadIpp]);
  const payment: "none" | "due" | "requested" | "paid" = !hasPaymentStep ? "none" : ipp?.status === "Realized" ? "paid" : ipp?.requested_at ? "requested" : "due";
  // A Draft is a proposal; from Submitted onward it is an application.
  const isApp = !!detail && detail.status !== "Quoted";

  // Edit / delete the proposal itself. Only while it is still a Draft (or the team has asked for more
  // information); once it is with the admin team or decided, it is changed on its underwriting case.
  const canEditProposal = !!detail && canAct && ["Quoted", "InformationRequested"].includes(detail.status);
  const canDeleteProposal = !!detail && canAct && detail.status === "Quoted";
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [form, setForm] = useState({ planId: "", coverage: "", term: "", nomineeName: "", nomineeRelationship: "", dependentName: "", dependentDob: "" });
  const editPlan = plans.find((p) => p.id === form.planId);
  const editShowsDependent = (editPlan?.insurance_type ?? detail?.insurance_type) === "CHILD_EDUCATION_MARRIAGE";

  const errorText = (err: any, fallback: string) => {
    const d = err?.response?.data?.detail;
    return typeof d === "string" ? d : err?.message ?? fallback;
  };

  const ensurePlans = async (): Promise<InsurancePlan[]> => {
    if (plans.length > 0) return plans;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return [];
    try {
      const list = (await listInsurancePlans(tenantId)).filter((p) => p.status === "Active");
      setPlans(list);
      return list;
    } catch {
      return []; // the plan stays as it is if the list can't load
    }
  };

  const startEdit = async () => {
    if (!detail) return;
    setEditError(null);
    const list = await ensurePlans();
    const current = list.find((p) => p.label === detail.plan_label) ?? list.find((p) => p.insurance_type === detail.insurance_type);
    setForm({
      planId: current?.id ?? "",
      coverage: String(detail.coverage_amount),
      term: String(detail.term_years),
      nomineeName: detail.nominee_name ?? "",
      nomineeRelationship: detail.nominee_relationship ?? "",
      dependentName: detail.dependent_name ?? "",
      dependentDob: detail.dependent_dob ? detail.dependent_dob.slice(0, 10) : "",
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!detail) return;
    if (editPlan) {
      const err = getPlanValidationError(
        editPlan, form.coverage, form.term, detail.customer_declared_income, detail.customer_dob,
        form.dependentName, form.dependentDob
      );
      if (err) { setEditError(tx(err)); return; }
    } else if (!(Number(form.coverage) > 0) || !Number.isInteger(Number(form.term)) || Number(form.term) <= 0) {
      setEditError(tx("Enter a valid coverage amount and term."));
      return;
    }
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setSaving(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {
        coverage_amount: Number(form.coverage),
        term_years: Number(form.term),
        nominee_name: form.nomineeName.trim() || null,
        nominee_relationship: form.nomineeRelationship.trim() || null,
      };
      if (editPlan) {
        body.product_name = editPlan.label;
        body.insurance_type = editPlan.insurance_type;
      }
      if (editShowsDependent) {
        body.dependent_name = form.dependentName.trim() || null;
        body.dependent_dob = form.dependentDob || null;
      }
      // The premium is recalculated server-side from the new plan, cover and term.
      await api.put(`/tenants/${tenantId}/customers/${detail.customer_id}/policies/${detail.policy_id}`, body);
      setEditing(false);
      onRefresh();
      await onReloadDetail();
    } catch (err: any) {
      setEditError(errorText(err, tx("Failed to save changes.")));
    } finally {
      setSaving(false);
    }
  };

  const deleteProposal = async () => {
    if (!detail) return;
    if (!confirm(tx("Delete this proposal for \"{0}\"? The customer stays on the Leads board. This cannot be undone.", { 0: detail.customer_name }))) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setDeleting(true);
    setEditError(null);
    try {
      await api.delete(`/tenants/${tenantId}/customers/${detail.customer_id}/policies/${detail.policy_id}`);
      // Back to the Leads board — a customer left as DRAFT would reappear here as an "Unassigned Plan" row.
      const complete = detail.customer_cnic && detail.customer_dob && detail.customer_occupation && detail.customer_declared_income;
      await updateCustomer(tenantId, detail.customer_id, { profile_status: complete ? "UNDERWRITING_READY" : "PROSPECT" });
      onRefresh();
      onClose();
    } catch (err: any) {
      setEditError(errorText(err, tx("Failed to delete the proposal.")));
    } finally {
      setDeleting(false);
    }
  };

  // Edit the customer's own details from here. Same window of time as the proposal (Draft / Information Requested).
  // The CNIC is the identity key behind compliance and verification, so it is shown but not editable here.
  const canEditCustomer = canEditProposal;
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [custSaving, setCustSaving] = useState(false);
  const [custError, setCustError] = useState<string | null>(null);
  const [custForm, setCustForm] = useState({
    firstName: "", lastName: "", dob: "", gender: "", occupation: "", income: "", isSmoker: false, height: "", weight: "",
  });

  const startEditCustomer = () => {
    if (!detail) return;
    const [first, ...rest] = (detail.customer_name ?? "").split(" ");
    setCustForm({
      firstName: first ?? "",
      lastName: rest.join(" "),
      dob: detail.customer_dob ? detail.customer_dob.slice(0, 10) : "",
      gender: detail.customer_gender ?? "",
      occupation: detail.customer_occupation ?? "",
      income: detail.customer_declared_income ? String(detail.customer_declared_income) : "",
      isSmoker: !!detail.customer_is_smoker,
      height: detail.customer_height_cm ? String(detail.customer_height_cm) : "",
      weight: detail.customer_weight_kg ? String(detail.customer_weight_kg) : "",
    });
    setCustError(null);
    setEditingCustomer(true);
  };

  const saveCustomer = async () => {
    if (!detail) return;
    const income = Number(custForm.income);
    const height = Number(custForm.height);
    const weight = Number(custForm.weight);
    if (!custForm.firstName.trim()) { setCustError(tx("First name is required.")); return; }
    if (custForm.dob && new Date(custForm.dob) > new Date()) { setCustError(tx("Date of birth cannot be in the future.")); return; }
    if (!(income > 0)) { setCustError(tx("Enter an annual income greater than 0.")); return; }
    if (!(height > 0) || !(weight > 0)) { setCustError(tx("Enter a valid height and weight.")); return; }
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;

    // The new details must still fit the proposal's plan (entry age, income multiple, ...).
    const list = await ensurePlans();
    const plan = list.find((p) => p.label === detail.plan_label) ?? list.find((p) => p.insurance_type === detail.insurance_type);
    if (plan) {
      const planErr = getPlanValidationError(
        plan, detail.coverage_amount, detail.term_years, income, custForm.dob || detail.customer_dob,
        detail.dependent_name, detail.dependent_dob
      );
      if (planErr) { setCustError(tx(planErr)); return; }
    }

    setCustSaving(true);
    setCustError(null);
    try {
      await updateCustomer(tenantId, detail.customer_id, {
        first_name: custForm.firstName.trim(),
        last_name: custForm.lastName.trim(),
        date_of_birth: custForm.dob || undefined,
        gender: custForm.gender || undefined,
        occupation: custForm.occupation.trim() || undefined,
        declared_income: income,
        is_smoker: custForm.isSmoker,
        height_cm: height,
        weight_kg: weight,
      });
      // Age, smoking status and BMI feed the premium, so re-price the proposal from the new details.
      await api.put(`/tenants/${tenantId}/customers/${detail.customer_id}/policies/${detail.policy_id}`, {});
      setEditingCustomer(false);
      onRefresh();
      await onReloadDetail();
    } catch (err: any) {
      setCustError(errorText(err, tx("Failed to save customer details.")));
    } finally {
      setCustSaving(false);
    }
  };

  // The lead's acquisition source (agent, broker, bank desk…) — the same sources the admin forms offer. Moving a lead
  // between sources changes who can see it, so it is staff-only (the server enforces the same).
  const canEditSource = canEditCustomer && !isAgent;
  const [editingSource, setEditingSource] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const sources = useAcquisitionSources(editingSource);
  const chosenSource = sources.find((s) => s.id === sourceId) ?? null;

  const startEditSource = () => {
    if (!detail) return;
    setSourceId(detail.acquisition_source_id ?? "");
    setSourceError(null);
    setEditingSource(true);
  };

  const saveSource = async () => {
    if (!detail) return;
    if (sourceId === (detail.acquisition_source_id ?? "")) {
      setEditingSource(false);
      return;
    }
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setSourceSaving(true);
    setSourceError(null);
    try {
      await updateCustomer(
        tenantId,
        detail.customer_id,
        sourceId
          ? {
              acquisition_source_id: sourceId,
              // An Agent source is a login of its own: choosing one hands the lead to that agent.
              ...(chosenSource?.source_type === "AGENT" && chosenSource.user_id ? { assigned_agent_id: chosenSource.user_id } : {}),
            }
          : { clear_acquisition_source: true },
      );
      setEditingSource(false);
      onRefresh();
      await onReloadDetail();
    } catch (err: any) {
      setSourceError(errorText(err, tx("Failed to update the lead source.")));
    } finally {
      setSourceSaving(false);
    }
  };

  // The documents this proposal's plan requires, and the link the customer uploads them through. Created when the
  // plan is attached; read here so staff can copy the link and see what has arrived.
  type DocRequest = {
    requirements: { document_type: string; state: "received" | "missing" | "reupload"; files: { file_name: string }[] }[];
    received: number;
    total: number;
    expires_at: string;
    expired: boolean;
    link_path: string;
  };
  const [docReq, setDocReq] = useState<DocRequest | null>(null);
  const [docReqError, setDocReqError] = useState<string | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [confirmRenew, setConfirmRenew] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const docPath = detail
    ? `/tenants/${typeof window !== "undefined" ? localStorage.getItem("tenant_id") : ""}/customers/${detail.customer_id}/policies/${detail.policy_id}/document-request`
    : "";

  useEffect(() => {
    if (!detail?.policy_id || !docPath) return;
    let alive = true;
    api.get(docPath)
      .then((r) => { if (alive) { setDocReq(r.data); setDocReqError(null); } })
      .catch((err) => { if (alive) setDocReqError(errorText(err, tx("Could not load the document list."))); });
    return () => { alive = false; };
    // plan_label: editing the plan can change which documents are required
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.policy_id, detail?.customer_id, detail?.plan_label]);

  const copyDocLink = async () => {
    if (!docReq) return;
    const url = portalUrl(docReq.link_path);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const box = document.createElement("textarea");
      box.value = url;
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      box.remove();
    }
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 2000);
  };

  const renewDocLink = async () => {
    setDocBusy(true);
    try {
      const r = await api.post(`${docPath}/renew`);
      setDocReq(r.data);
      setConfirmRenew(false);
    } catch (err: any) {
      setDocReqError(errorText(err, tx("Could not renew the link.")));
    } finally {
      setDocBusy(false);
    }
  };

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
    return getAvailableActions(detail.status, missingFields.length > 0, false, canSendToUnderwriting, isAgent, payment);
  }, [detail?.status, missingFields.length, canSendToUnderwriting, isAgent, payment]);

  const handleApplyAction = async (value: string) => {
    if (!detail) return;
    setStartError(null);
    try {
      if (value === "payment_request") {
        // Opens the payment request: the secure link and the email to the customer (see PaymentPanel for everything after that).
        const res = await requestPolicyPayment(detail.policy_id);
        setIpp(res.ipp);
        return;
      }
      if (value === "underwriting") {
        // The last step: opens the underwriting case and takes the user there. Only now does the window close.
        await onStartUnderwriting();
        onClose();
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
      // Stay on the proposal: the list behind it refreshes, and this window re-reads the proposal so the
      // progress steps and the next action update in place.
      onRefresh();
      await onReloadDetail();
    } catch (err: any) {
      setStartError(err.message ?? tx("Failed to update."));
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
            <p className="text-sm font-semibold text-slate-700">{tx(isApp ? "Application Details" : "Proposal Details")}</p>
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

        {detail && !loading && (
          <div className="space-y-4 border-b border-slate-100 bg-slate-50/70 px-5 py-4">
            <ProposalProgress status={detail.status} withPayment={hasPaymentStep} paid={payment === "paid"} />
            {hasPaymentStep && detail.status === "UnderReview" && ipp !== null && (
              <PaymentPanel policyId={detail.policy_id} ipp={ipp} canAct={canAct && !isAgent} onChange={setIpp}
                onCleared={async () => { await loadIpp(); onRefresh(); await onReloadDetail(); }} />
            )}
            {hasPaymentStep && detail.status === "UnderReview" && (
              <p className={`text-center text-xs font-semibold ${payment === "paid" ? "text-emerald-600" : "text-amber-600"}`}>
                {payment === "paid"
                  ? tx("Initial premium received. This application can now go to underwriting.")
                  : tx("Waiting for the initial premium. Underwriting opens once the payment has cleared.")}
              </p>
            )}
            {isAgent && modalOptions.length === 0 && ["Proposed", "UnderReview", "Approved", "AcceptedWithLoadings", "Declined", "Issued"].includes(detail.status) && (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500" title={tx("Currently, you have no access to do this, ask your manager")}>
                {tx("This application has been sent to the admin team for further review, so it can no longer be changed from here. You can follow its progress on this page.")}
              </div>
            )}
            {/* The next move: only what is legal from here */}
            {modalOptions.length > 0 && (
              <div className="space-y-2">
                {startError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{startError}</p>
                )}
                <ActionDropdown
                  options={modalOptions}
                  onApply={handleApplyAction}
                  isOptionDisabled={(value) => value === "save_info" && Object.keys(missingFormData).length === 0}
                  getConfirmMessage={(o) => (o.tier === "decision" ? tx(isApp ? "Reject this application? This cannot be undone." : "Reject this proposal? This cannot be undone.") : undefined)}
                  canAct={canAct}
                  canDecide={canDecide}
                />
              </div>
            )}
          </div>
        )}

        {loading && (
          <div className="py-16 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">{tx("Loading details…")}</span>
          </div>
        )}

        {error && (
          <div className="p-5">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">{tx("Error")}</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          </div>
        )}

        {detail && !loading && (
          <div className="p-5 space-y-5">
            {/* Proposal Statement */}
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-5 py-4 space-y-1.5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500">{tx(isApp ? "Application Statement" : "Proposal Statement")}</p>
                <span className="text-[10px] font-mono text-slate-400">{tx("Ref:")} {detail.quote_id.slice(0, 8).toUpperCase()}</span>
              </div>
              {detail.organization_name && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-600 font-semibold">
                  <OrgIcon className="w-3 h-3" />
                  {tx("Corporate")} — {detail.organization_name}
                  {detail.master_policy_label ? ` · ${detail.master_policy_label}` : ""}
                </p>
              )}
              {detail.family_group_name && (
                <p className="flex items-center gap-1.5 text-[11px] text-blue-600 font-semibold">
                  <FamilyIcon className="w-3 h-3" />
                  {tx("Family")} — {detail.family_group_name}
                  {detail.family_policy_label ? ` · ${detail.family_policy_label}` : ""}
                </p>
              )}
              {locale === "ur" ? (
                <>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    ہمیں{" "}<span className="font-semibold text-slate-900">{detail.customer_name}</span>{" "}کے لیے درج ذیل انشورنس
                    {isApp ? "درخواست موصول ہوئی ہے۔" : "پروپوزل پیش کرتے ہوئے خوشی ہے۔"} فراہم کردہ معلومات کی بنیاد پر ہم{" "}
                    <span className="font-semibold text-slate-900">{detail.plan_label}</span>{" "}پلان کے تحت{" "}
                    <span className="font-semibold text-slate-900">{tx(INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type)}</span>{" "}
                    پالیسی تجویز کرتے ہیں، جو{" "}
                    <span className="font-semibold text-slate-900">{detail.term_years} سال</span>{" "}کی مدت کے لیے{" "}
                    <span className="font-semibold text-slate-900">{formatPKR(detail.coverage_amount)}</span>{" "}کی بیمہ شدہ رقم فراہم کرتی ہے۔
                  </p>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    اس کوریج کا کل سالانہ پریمیم{" "}
                    <span className="font-bold text-slate-900">{formatPKR(detail.total_premium)}</span>{" "}ہے
                    (متوقع پریمیم {formatPKR(detail.base_premium)} اور رسک {formatPKR(detail.loading_applied)})۔ یہ{" "}{isApp ? "درخواست" : "پروپوزل"}
                    تسلی بخش انڈر رائٹنگ جائزے سے مشروط ہے اور{" "}
                    <span className="font-medium text-slate-800">{formatDate(detail.created_at)}</span>{" "}کو تیار کیا گیا۔
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {tx(isApp ? "We have received the following insurance application for" : "We are pleased to present the following insurance proposal for")}{" "}
                    <span className="font-semibold text-slate-900">{detail.customer_name}</span>{tx(". Based on the information provided, we propose a")}{" "}
                    <span className="font-semibold text-slate-900">
                      {tx(INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type)}
                    </span>{" "}
                    {tx("policy under the")}{" "}
                    <span className="font-semibold text-slate-900">{detail.plan_label}</span>{" "}
                    {tx("plan, providing a sum assured of")}{" "}
                    <span className="font-semibold text-slate-900">{formatPKR(detail.coverage_amount)}</span>{" "}
                    {tx("over a term of")}{" "}
                    <span className="font-semibold text-slate-900">{detail.term_years}{" "}{tx("years")}</span>.
                  </p>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {tx("The total annual premium for this coverage is")}{" "}
                    <span className="font-bold text-slate-900">{formatPKR(detail.total_premium)}</span>{" "}
                    {tx("(expected premium of")}{" "}{formatPKR(detail.base_premium)}{" "}{tx("plus a risk of")}{" "}
                    {formatPKR(detail.loading_applied)}{tx(isApp ? "). This application is subject to satisfactory underwriting assessment and is generated as of" : "). This proposal is valid subject to satisfactory underwriting assessment and is generated as of")}{" "}
                    <span className="font-medium text-slate-800">{formatDate(detail.created_at)}</span>.
                  </p>
                </>
              )}
            </div>

            <p className="text-[11px] text-slate-500 mt-1 mb-2 text-center italic">
              {tx(isApp ? "Opens an Underwriting case for this customer on this exact application — documents, AI risk scoring, and the final decision all happen there." : "Opens an Underwriting case for this customer on this exact proposal — documents, AI risk scoring, and the final decision all happen there.")}
            </p>

            {/* Headline */}
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">{detail.customer_name}</h2>
                  {canEditCustomer && !editingCustomer && (
                    <button
                      onClick={startEditCustomer}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
                    >
                      {tx("Edit")}
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-400">{detail.customer_cnic}</p>
              </div>
              <p className="text-[11px] text-slate-400 text-end mt-1.5">
                {tx("Rate version {version} · Generated {date}", { version: detail.rate_version, date: displayDateTime(detail.created_at) })}
              </p>
            </div>

            {/* Customer */}
            <section>
              <SectionLabel>{tx("Customer")}</SectionLabel>
              {editingCustomer ? (
                <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([
                      ["firstName", "First Name", "text"],
                      ["lastName", "Last Name", "text"],
                      ["dob", "Date of Birth", "date"],
                      ["occupation", "Occupation", "text"],
                      ["income", "Annual Income (PKR)", "number"],
                      ["height", "Height (cm)", "number"],
                      ["weight", "Weight (kg)", "number"],
                    ] as const).map(([key, label, type]) => (
                      <div key={key}>
                        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx(label)}</label>
                        <input
                          type={type} value={custForm[key]} disabled={custSaving}
                          onChange={(e) => setCustForm({ ...custForm, [key]: e.target.value })}
                          className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                        />
                      </div>
                    ))}
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Gender")}</label>
                      <FancyDropdown
                        className="w-full"
                        value={custForm.gender}
                        onChange={(v) => setCustForm({ ...custForm, gender: v })}
                        options={[{ value: "Male", label: tx("Male") }, { value: "Female", label: tx("Female") }]}
                        placeholder={tx("Select gender")}
                        disabled={custSaving}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
                      <input
                        type="checkbox" checked={custForm.isSmoker} disabled={custSaving}
                        onChange={(e) => setCustForm({ ...custForm, isSmoker: e.target.checked })}
                      />
                      {tx("Smoker")}
                    </label>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {tx("The premium is recalculated from these details when you save. The CNIC cannot be changed here.")}
                  </p>
                  {custError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{custError}</p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => { setEditingCustomer(false); setCustError(null); }}
                      disabled={custSaving}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      {tx("Cancel")}
                    </button>
                    <button
                      onClick={saveCustomer}
                      disabled={custSaving}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {custSaving ? tx("Saving…") : tx("Save Changes")}
                    </button>
                  </div>
                </div>
              ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label={tx("Date of Birth")} value={`${formatDate(detail.customer_dob)} (${tx("{age} yrs", { age: detail.customer_age })})`} />
                <DetailField label={tx("Gender")} value={detail.customer_gender} />
                <DetailField label={tx("Occupation")} value={detail.customer_occupation} />
                <DetailField label={tx("Annual Income")} value={formatPKR(detail.customer_declared_income)} />
                <DetailField label={tx("Smoker")} value={detail.customer_is_smoker ? tx("Yes") : tx("No")} />
                <DetailField
                  label={tx("Height / Weight")}
                  value={`${detail.customer_height_cm} cm / ${detail.customer_weight_kg} kg${detail.customer_bmi ? ` (BMI ${detail.customer_bmi})` : ""}`}
                />
                {(detail.acquisition_source_name || canEditSource) && (
                  <div className="col-span-2 sm:col-span-3">
                    {editingSource ? (
                      <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{tx("Lead Generated By")}</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <SourcePicker
                            sources={sources}
                            sourceId={sourceId}
                            onChange={(src) => setSourceId(src?.id ?? "")}
                            fieldClass="space-y-1"
                            labelClass="text-xs font-semibold text-slate-600"
                            selectClass="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                          />
                        </div>
                        <p className="text-[11px] text-slate-500">
                          {tx("Choose “Direct / Unassigned” to remove the source. Need a new one?")}{" "}
                          <a href="/admin/acquisition-sources" className="font-semibold text-blue-700 hover:underline">
                            {tx("Manage acquisition sources →")}
                          </a>
                        </p>
                        {sourceError && (
                          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{sourceError}</p>
                        )}
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => { setEditingSource(false); setSourceError(null); }}
                            disabled={sourceSaving}
                            className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
                          >
                            {tx("Cancel")}
                          </button>
                          <button
                            onClick={saveSource}
                            disabled={sourceSaving}
                            className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
                          >
                            {sourceSaving ? tx("Saving…") : tx("Save Changes")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <DetailField
                          label={tx("Lead Generated By")}
                          value={
                            detail.acquisition_source_name
                              ? `${detail.acquisition_source_name} (${tx(SOURCE_TYPE_LABELS[detail.acquisition_source_type ?? ""] ?? detail.acquisition_source_type ?? "")})${detail.acquisition_source_partner ? ` — ${detail.acquisition_source_partner}` : ""}`
                              : tx("Direct / Unassigned")
                          }
                        />
                        {canEditSource && (
                          <button
                            onClick={startEditSource}
                            className="shrink-0 px-2.5 py-1 text-[11px] font-semibold rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
                          >
                            {tx("Edit")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              )}
            </section>

            {/* Policy */}
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{tx("Policy")}</p>
                {!editing && (canEditProposal || canDeleteProposal) && (
                  <div className="flex items-center gap-1.5">
                    {canEditProposal && (
                      <button
                        onClick={startEdit}
                        disabled={deleting}
                        className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors disabled:opacity-50"
                      >
                        {tx("Edit")}
                      </button>
                    )}
                    {canDeleteProposal && (
                      <button
                        onClick={deleteProposal}
                        disabled={deleting}
                        className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-red-600 bg-white border border-red-100 hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        {deleting ? tx("Deleting…") : tx("Delete")}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {editError && !editing && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{editError}</p>
              )}
              {editing ? (
                <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
                  {plans.length > 0 && (
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Plan")}</label>
                      <FancyDropdown
                        className="w-full"
                        value={form.planId}
                        onChange={(v) => setForm({ ...form, planId: v })}
                        options={plans.map((p) => ({ value: p.id, label: p.label }))}
                        placeholder={tx("Select plan")}
                        searchable={plans.length > 6}
                        disabled={saving}
                      />
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Coverage (PKR)")}</label>
                      <input
                        type="number" min={0} value={form.coverage} disabled={saving}
                        onChange={(e) => setForm({ ...form, coverage: e.target.value })}
                        className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Term (years)")}</label>
                      <input
                        type="number" min={1} value={form.term} disabled={saving}
                        onChange={(e) => setForm({ ...form, term: e.target.value })}
                        className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Nominee")}</label>
                      <input
                        type="text" value={form.nomineeName} disabled={saving}
                        onChange={(e) => setForm({ ...form, nomineeName: e.target.value })}
                        className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Nominee Relationship")}</label>
                      <input
                        type="text" value={form.nomineeRelationship} disabled={saving}
                        onChange={(e) => setForm({ ...form, nomineeRelationship: e.target.value })}
                        className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                      />
                    </div>
                    {editShowsDependent && (
                      <>
                        <div>
                          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Dependent")}</label>
                          <input
                            type="text" value={form.dependentName} disabled={saving}
                            onChange={(e) => setForm({ ...form, dependentName: e.target.value })}
                            className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">{tx("Dependent Date of Birth")}</label>
                          <input
                            type="date" value={form.dependentDob} disabled={saving}
                            onChange={(e) => setForm({ ...form, dependentDob: e.target.value })}
                            className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                          />
                        </div>
                      </>
                    )}
                  </div>
                  {editError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{editError}</p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => { setEditing(false); setEditError(null); }}
                      disabled={saving}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      {tx("Cancel")}
                    </button>
                    <button
                      onClick={saveEdit}
                      disabled={saving}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {saving ? tx("Saving…") : tx("Save Changes")}
                    </button>
                  </div>
                </div>
              ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <DetailField label={tx("Plan")} value={detail.plan_label} />
                <DetailField label={tx("Type")} value={tx(INSURANCE_TYPE_LABELS[detail.insurance_type] ?? detail.insurance_type)} />
                <DetailField label={tx("Coverage")} value={formatPKR(detail.coverage_amount)} />
                <DetailField label={tx("Term")} value={tx("{years} years", { years: detail.term_years })} />
                {detail.organization_name && <DetailField label={tx("Organization")} value={detail.organization_name} />}
                {detail.master_policy_label && <DetailField label={tx("Master Policy")} value={detail.master_policy_label} />}
                {detail.family_group_name && <DetailField label={tx("Family")} value={detail.family_group_name} />}
                {detail.family_policy_label && <DetailField label={tx("Family Policy")} value={detail.family_policy_label} />}
                {detail.nominee_name && <DetailField label={tx("Nominee")} value={`${detail.nominee_name}${detail.nominee_relationship ? ` (${detail.nominee_relationship})` : ""}`} />}
                {detail.dependent_name && <DetailField label={tx("Dependent")} value={`${detail.dependent_name}${detail.dependent_dob ? ` — b. ${formatDate(detail.dependent_dob)}` : ""}`} />}
              </div>
              )}
            </section>

            {/* Documents the plan requires, and the link the customer uploads them through */}
            <section>
              <div className="mb-2.5 flex items-center justify-between">
                <SectionLabel>{tx("Documents")}</SectionLabel>
                {docReq && docReq.total > 0 && (
                  <span className="mb-2.5 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700">
                    {tx("{0} of {1} received", { 0: docReq.received, 1: docReq.total })}
                  </span>
                )}
              </div>
              {docReqError && (
                <p className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">{docReqError}</p>
              )}
              {!docReq && !docReqError && <p className="text-xs text-slate-400">{tx("Loading…")}</p>}
              {docReq && docReq.total === 0 && (
                <p className="text-sm text-slate-500">{tx("This plan needs no documents.")}</p>
              )}
              {docReq && docReq.total > 0 && (
                <div className="space-y-3">
                  <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                    {docReq.requirements.map((r) => (
                      <li key={r.document_type} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <span className="min-w-0">
                          <span className="font-medium text-slate-800">{r.document_type}</span>
                          {r.files.length > 0 && (
                            <span className="ml-2 truncate text-xs text-slate-400">{r.files[r.files.length - 1].file_name}</span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                            r.state === "received"
                              ? "border-blue-600 bg-blue-600 text-white"
                              : r.state === "reupload"
                                ? "border-slate-700 bg-slate-700 text-white"
                                : "border-slate-300 bg-white text-slate-600"
                          }`}
                        >
                          {r.state === "received" ? tx("Received") : r.state === "reupload" ? tx("Needs re-upload") : tx("Waiting")}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className="space-y-2.5 rounded-xl border border-blue-100 bg-blue-50/50 p-3.5">
                    <p className="text-xs font-semibold text-slate-700">{tx("Customer upload link")}</p>
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={portalUrl(docReq.link_path)}
                        onFocus={(e) => e.currentTarget.select()}
                        aria-label={tx("Customer upload link")}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-700"
                      />
                      <button
                        type="button"
                        onClick={copyDocLink}
                        className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
                      >
                        {linkCopied ? tx("Copied") : tx("Copy link")}
                      </button>
                      <a
                        href={portalUrl(docReq.link_path)}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        {tx("Open")}
                      </a>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <span>{docReq.expired ? tx("This link has expired.") : tx("Expires {0}", { 0: formatDate(docReq.expires_at) })}</span>
                      {confirmRenew ? (
                        <span className="flex items-center gap-2">
                          {tx("The old link will stop working.")}
                          <button type="button" disabled={docBusy} onClick={renewDocLink} className="font-semibold text-blue-700 hover:underline disabled:opacity-50">
                            {docBusy ? tx("Renewing…") : tx("Renew")}
                          </button>
                          <button type="button" disabled={docBusy} onClick={() => setConfirmRenew(false)} className="font-semibold text-slate-600 hover:underline">
                            {tx("Cancel")}
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirmRenew(true)} className="font-semibold text-blue-700 hover:underline">
                          {tx("Renew link")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Premium breakdown */}
            <section>
              <SectionLabel>{tx("Premium Breakdown")}</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label={tx("Premium")} value={formatPKR(detail.base_premium)} />
                {/* <StatTile label="Risk" value={formatPKR(detail.loading_applied)} /> */}
                <StatTile
                  label={tx("Total Payable")}
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
                <p className="text-xs font-bold text-amber-700 uppercase tracking-widest mb-1">{tx("Missing Information")}</p>
                <p className="text-sm text-amber-600 mb-2">{tx("The following information is missing and must be completed:")}</p>
                <ul className="list-disc list-inside text-sm text-amber-700">
                  {missingFields.map(f => <li key={f.key}>{tx(f.label)}</li>)}
                </ul>
              </div>
            )}

            {missingFields.length > 0 && detail.status === "InformationRequested" && (
              <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl">
                <p className="text-xs font-bold text-blue-700 uppercase tracking-widest mb-3">{tx("Provide Missing Information")}</p>
                <div className="space-y-3">
                  {missingFields.map(f => (
                    <div key={f.key}>
                      <label className="text-xs font-semibold text-slate-700 block mb-1">{tx(f.label)}</label>
                      {f.type === 'select' ? (
                        <FancyDropdown
                          className="w-full"
                          value={missingFormData[f.key] || ''}
                          onChange={(v) => setMissingFormData({...missingFormData, [f.key]: v})}
                          placeholder={tx("Select {field}", { field: tx(f.label) })}
                          options={f.key === 'gender' ? [
                            { value: "Male", label: tx("Male") },
                            { value: "Female", label: tx("Female") },
                          ] : []}
                        />
                      ) : (
                        <input
                          type={f.type}
                          className="w-full text-sm border border-slate-300 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                          value={missingFormData[f.key] || ''}
                          onChange={e => setMissingFormData({...missingFormData, [f.key]: e.target.value})}
                          placeholder={tx("Enter {field}", { field: tx(f.label) })}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(detail.status === "Approved" || detail.status === "AcceptedWithLoadings" || detail.status === "Declined") && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500">
                {tx("This application's outcome was decided on its underwriting case, not here — open the case to review the decision.")}
              </div>
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
  const { tx } = useI18n();
  return (
    <div>
      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">{tx(label)}</p>
      <p className="text-sm text-slate-700 font-medium">{value}</p>
    </div>
  );
}

function StatTile({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  const { tx } = useI18n();
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-slate-900" : "bg-slate-50"}`}>
      <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${highlight ? "text-slate-300" : "text-slate-400"}`}>
        {tx(label)}
      </p>
      <p className={`text-sm font-bold ${highlight ? "text-white" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}
