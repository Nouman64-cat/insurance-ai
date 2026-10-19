"use client";

import { displayDate } from '../../../lib/dateDisplay';
import { useState, useEffect, useRef, useMemo } from "react";
import { listBranches, Branch } from "@/app/services/branches";
import { listAcquisitionSources, AcquisitionSource } from "@/app/services/acquisitionSources";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import api from "@/app/services/api";
import { listQuotes } from "@/app/services/quotes";
import { listCases } from "@/app/services/cases";
import UnifiedDetailsModal from "@/components/UnifiedDetailsModal";
import FiltersPanel from "@/components/FiltersPanel";
import AddEntryChooser, { EntryEntityType } from "@/components/entities/AddEntryChooser";
import { useNewArrivals, recentIds, NewArrivalsBanner, NEW_ARRIVAL_CLASS, scrollToFirstNew } from "@/lib/useNewArrivals";
import NewLeadAlert, { NewLeadInfo } from "@/components/NewLeadAlert";
import { getUserDirectory } from "@/app/services/agents";
import { useNotify } from "@/components/NotificationContext";
import CustomerFormModal from "@/components/entities/CustomerFormModal";
import CustomerQuickLeadModal from "@/components/entities/CustomerQuickLeadModal";
import { notifyParentPortal } from "@/lib/agent/portalMessage";
import { sendLeadToDraft, isEmbedded } from "@/lib/sendToDraft";
import FamilyFormModal from "@/components/entities/FamilyFormModal";
import { leadAnnouncementsPaused } from "@/lib/leadAnnouncements";
import OrganizationFormModal from "@/components/entities/OrganizationFormModal";
import { announceTourLead } from "@/lib/tour/events";
import LeadProgress, { leadStage } from "@/components/LeadProgress";
import RowActionsMenu, { ActionIcon, type RowAction as LeadAction } from "@/components/RowActionsMenu";
import { tx } from "@/lib/i18n/tx";

type EntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";
type ProfileStatus = "LEAD" | "PROSPECT" | "DRAFT" | "UNDERWRITING_READY" | "NOT_INTERESTED" | "POLICYHOLDER";

interface UnifiedLead {
  id: string;
  type: EntityType;
  name: string;
  contact_info: string;
  created_at: string;
  status: ProfileStatus;
  primaryIdentifier?: string; // CNIC or Registration No
  displayId?: string;
  /** The list endpoints return only the id — the name comes from the directory. */
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
  /** Who brought the lead in (individual customers): the source's name and its type. */
  sourceName?: string | null;
  sourceType?: string | null;
  /** Status of this customer's latest proposal (quote), when they have one. Individuals only. */
  proposalStatus?: string | null;
  /** Status of this lead's underwriting case, when one has been opened. */
  caseStatus?: string | null;
  /** The quotation (estimated annual premium) of this customer's most advanced proposal. Individuals only. */
  quotation?: { amount: number; plan: string; coverage: number; extra: number } | null;
  /** A plan chosen on the entry form that has no quotation yet (it becomes a proposal on Create Proposal). */
  pendingPlan?: string | null;
  /** Underwriting hold on this lead's case: the process is paused until the hold is removed. */
  onHold?: boolean;
  holdReason?: string | null;
  holdCaseId?: string | null;
  /** Set when this lead came in through the customer portal's walk-in sign-up: its routing / acknowledgement state. */
  walkIn?: WalkInInfo | null;
}

interface WalkInInfo {
  id: string;
  applicantType: "Self" | "Family";
  reference: string;
  planLabel: string | null;
  routingStatus: string;
  awaiting: boolean;
  overdue: boolean;
  escalated: boolean;
  unassigned: boolean;
  reason: string | null;
}

/** "Create Proposal" (sends the lead to Proposals as a draft) only makes sense for a lead that has no proposal yet. Once it has been sent (a proposal exists, or it has moved on to
 *  review, underwriting or a policy) the lead's own status says so, and the button is not offered. */
const canSendDraft = (lead: UnifiedLead) => lead.status !== "DRAFT" && leadStage(lead).step < 2;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Walk-in",
  DIGITAL: "Digital",
};

/**
 * The Agent column: the name, with its type as a caption beneath — an acquisition source
 * shows as "Nouman Ejaz / Broker"; a lead with only an assigned agent shows "<name> /
 * Agent". When both exist, the assigned agent is noted underneath. Compact is the
 * card-view size.
 */
function AgentCell({ lead, compact = false }: { lead: UnifiedLead; compact?: boolean }) {
  const primary = lead.sourceName || lead.assignedAgentName;
  if (!primary) return <span className={compact ? "text-slate-400 italic" : "text-xs text-slate-400 italic"}>{tx("Unassigned")}</span>;
  const typeLabel = lead.sourceName
    ? SOURCE_TYPE_LABELS[lead.sourceType ?? ""] ?? lead.sourceType ?? null
    : "Agent";
  const alsoAssigned = lead.sourceName && lead.assignedAgentName && lead.assignedAgentName !== lead.sourceName
    ? lead.assignedAgentName
    : null;
  return (
    <div className="flex flex-col items-start gap-0.5 min-w-0">
      <span className={`truncate max-w-full ${compact ? "text-slate-600" : "text-[13px] font-medium text-slate-700"}`}>{primary}</span>
      {typeLabel && <span className="text-[11px] text-slate-400">{tx(typeLabel)}</span>}
      {alsoAssigned && <span className="text-[10px] text-slate-400 truncate max-w-full">{tx("Assigned to")}{" "}{alsoAssigned}</span>}
    </div>
  );
}

const TYPE_BADGES: Record<UnifiedLead["type"], { label: string; className: string }> = {
  INDIVIDUAL: { label: "Individual", className: "bg-blue-50 text-blue-700 ring-blue-600/15" },
  FAMILY: { label: "Family", className: "bg-blue-50 text-blue-700 ring-blue-600/15" },
  CORPORATE: { label: "Corporate", className: "bg-amber-50 text-amber-800 ring-amber-600/20" },
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "?";

type FilterType = "ALL" | "INDIVIDUAL" | "FAMILY" | "CORPORATE";

/**
 * How often to re-read the shared database while this board is open. Agents
 * create leads from the mobile app against the same tables, so without this the
 * board silently goes stale until someone reloads the page.
 */
const LIVE_REFRESH_MS = 15_000;

export default function LeadsHubPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { notify } = useNotify();
  const cnicQuery = searchParams.get("cnic");
  const customerIdQuery = searchParams.get("customer_id");
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const tourSeenIds = useRef<Set<string> | null>(null);
  // An Agent works the same board as an admin, minus the destructive tools: no demo reset and no delete.
  const [userRole, setUserRole] = useState<string | null>(null);
  useEffect(() => { setUserRole(localStorage.getItem("user_role")); }, []);
  // Brokers work leads the same way Agents do — add and progress them, but not delete.
  const isAgent = userRole === "Agent" || userRole === "Broker";
  /** Leads that appeared since the board was opened, awaiting acknowledgement. */
  const [incomingLeads, setIncomingLeads] = useState<NewLeadInfo[]>([]);
  /**
   * Ids from the previous snapshot, for detecting genuinely new leads.
   * `null` means no baseline yet — the next fetch establishes one silently.
   */
  const knownLeadIds = useRef<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [declineMessage, setDeclineMessage] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<FilterType>("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [selectedEntity, setSelectedEntity] = useState<{ id: string, type: EntityType } | null>(null);
  const [viewMode, setViewMode] = useState<"kanban" | "table">("table");
  const [currentPage, setCurrentPage] = useState(1);

  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [cityInput, setCityInput] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [provinceFilter, setProvinceFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [sourceOptions, setSourceOptions] = useState<AcquisitionSource[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setCityFilter(cityInput.trim()), 400);
    return () => clearTimeout(t);
  }, [cityInput]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, filterType, statusFilter, dateFrom, dateTo, cityFilter, provinceFilter, branchFilter, sourceFilter]);

  useEffect(() => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    listBranches(tenantId).then(setBranchOptions).catch(() => setBranchOptions([]));
    listAcquisitionSources(tenantId).then(setSourceOptions).catch(() => setSourceOptions([]));
  }, []);

  const clearFilters = () => {
    setSearch("");
    setFilterType("ALL");
    setDateFrom("");
    setDateTo("");
    setCityInput("");
    setCityFilter("");
    setProvinceFilter("");
    setBranchFilter("");
    setSourceFilter("");
  };

  const structuredFilterCount = [dateFrom || dateTo, cityFilter, provinceFilter, branchFilter, sourceFilter].filter(Boolean).length;

  const activeFilterChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (search) activeFilterChips.push({ key: "search", label: `"${search}"`, onRemove: () => setSearch("") });
  if (filterType !== "ALL") {
    const typeLabel = filterType === "INDIVIDUAL" ? "Individuals" : filterType === "FAMILY" ? "Families" : "Corporates";
    activeFilterChips.push({ key: "type", label: typeLabel, onRemove: () => setFilterType("ALL") });
  }
  if (dateFrom || dateTo) {
    const label = dateFrom && dateTo
      ? (dateFrom === dateTo ? `On ${dateFrom}` : `${dateFrom} → ${dateTo}`)
      : dateFrom
        ? `From ${dateFrom}`
        : `Until ${dateTo}`;
    activeFilterChips.push({ key: "date", label, onRemove: () => { setDateFrom(""); setDateTo(""); } });
  }
  if (cityFilter) activeFilterChips.push({ key: "city", label: `City: ${cityFilter}`, onRemove: () => { setCityInput(""); setCityFilter(""); } });
  if (provinceFilter) activeFilterChips.push({ key: "province", label: `Province: ${provinceFilter}`, onRemove: () => setProvinceFilter("") });
  if (branchFilter) {
    const label = branchOptions.find(b => b.id === branchFilter)?.name ?? "Branch";
    activeFilterChips.push({ key: "branch", label, onRemove: () => setBranchFilter("") });
  }
  if (sourceFilter) {
    const label = sourceOptions.find(a => a.id === sourceFilter)?.name ?? "Source";
    activeFilterChips.push({ key: "source", label, onRemove: () => setSourceFilter("") });
  }

  // Inline "Add" flows — replaces navigation to separate customer/family/organization pages.
  const [chooserType, setChooserType] = useState<EntryEntityType | null>(null);
  const [activeAdd, setActiveAdd] = useState<{ type: EntryEntityType; mode: "quick" | "full" } | null>(null);
  const [editEntityData, setEditEntityData] = useState<{ type: EntityType; data: any; tab?: string } | null>(null);
  const [notice, setNotice] = useState("");

  const handleAddSaved = (message: string, entity?: { id: string; isNew: boolean }) => {
    const current = activeAdd;
    setActiveAdd(null);

    // Families & corporates need further setup (members / census / master policy)
    // which lives on their dedicated Manage page — hand off there after creating.
    if (entity?.isNew && entity.id && current) {
      if (current.type === "FAMILY") {
        router.push(`/admin/families/${entity.id}`);
        return;
      }
      if (current.type === "CORPORATE") {
        router.push(`/admin/organizations/${entity.id}`);
        return;
      }
    }

    // Individuals: stay on the Leads board.
    setNotice(message);
    fetchLeads();
  };

  useEffect(() => {
    // Narrowing a filter removes leads from the result set; without dropping the
    // baseline, widening it again would announce every one of them as "new".
    knownLeadIds.current = null;
    fetchLeads();
  }, [dateFrom, dateTo, cityFilter, provinceFilter, branchFilter, sourceFilter]);

  /**
   * Keeps the board live against the shared database, so leads created in the
   * mobile app appear here without a manual reload. Polling pauses while the
   * tab is hidden — nobody is reading it, and it would burn quota all day.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") fetchLeads({ silent: true });
    };
    const timer = setInterval(tick, LIVE_REFRESH_MS);

    // Returning to the tab is the moment the user most expects current data.
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchLeads({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // The filter values are read inside fetchLeads at call time, so this effect
    // deliberately sets the interval up once rather than tearing it down on
    // every keystroke in the filter panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, cityFilter, provinceFilter, branchFilter, sourceFilter]);

  useEffect(() => {
    if ((customerIdQuery || cnicQuery) && leads.length > 0) {
      const match = customerIdQuery ? leads.find(l => l.id === customerIdQuery && l.type === 'INDIVIDUAL')
        : leads.find(l => l.primaryIdentifier === cnicQuery);
      if (match) setSelectedEntity({ id: match.id, type: match.type });
    }
  }, [customerIdQuery, cnicQuery, leads]);

  useEffect(() => {
    const addType = searchParams.get("add");
    if (addType === "individual") {
      setChooserType("INDIVIDUAL");
    } else if (addType === "family") {
      setChooserType("FAMILY");
    } else if (addType === "corporate") {
      setChooserType("CORPORATE");
    }
  }, [searchParams]);

  /**
   * `silent` skips the loading spinner, for the background poll — flashing the
   * skeleton every 15 seconds while the user reads the board would be worse
   * than not refreshing at all.
   */
  const fetchLeads = async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");

    if (!tenantId) {
      setError(tx("No active tenant found."));
      setLoading(false);
      return;
    }

    try {
      const structuredParams: Record<string, string> = {};
      if (branchFilter) structuredParams.branch_id = branchFilter;
      if (sourceFilter) structuredParams.acquisition_source_id = sourceFilter;
      if (cityFilter) structuredParams.city = cityFilter;
      if (provinceFilter) structuredParams.province = provinceFilter;
      if (dateFrom) structuredParams.created_from = dateFrom;
      if (dateTo) structuredParams.created_to = dateTo;

      // Resolves `assigned_agent_id` into a name for the Agent column. Cached
      // per tenant, so the background poll does not refetch it each cycle.
      const directory = await getUserDirectory(tenantId);
      const agentNameFor = (id?: string | null) =>
        id ? directory.get(String(id)) ?? null : null;

      // Parallel fetch to gather all entity types, excluding active policyholders using category queries
      const [
        custFullRes,
        custQuickRes,
        custNotIntRes,
        famInProgressRes,
        famNewRes,
        orgInProgressRes,
        orgNewRes
      ] = await Promise.all([
        api.get(`/tenants/${tenantId}/customers`, { params: { category: "full_details", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/customers`, { params: { category: "quick_lead", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/customers`, { params: { category: "not_interested", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/families`, { params: { category: "in_progress", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/families`, { params: { category: "new", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/organizations`, { params: { category: "in_progress", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/organizations`, { params: { category: "new", ...structuredParams } })
      ]);

      const unified: UnifiedLead[] = [];

      // Process Individual Customers
      const customers = [
        ...(custFullRes.data || []),
        ...(custQuickRes.data || []),
        ...(custNotIntRes.data || [])
      ];
      customers.forEach((c: any) => {
        if (c.profile_status !== "POLICYHOLDER") {
          unified.push({
            id: c.id,
            type: "INDIVIDUAL",
            name: c.name,
            contact_info: c.details?.phone || c.details?.contact_phone || "No phone",
            created_at: c.created_at,
            status: c.profile_status || "LEAD",
            primaryIdentifier: c.cnic,
            assignedAgentId: c.assigned_agent_id ?? null,
            assignedAgentName: agentNameFor(c.assigned_agent_id),
            sourceName: c.acquisition_source?.name ?? null,
            sourceType: c.acquisition_source?.source_type ?? null,
            pendingPlan: c.details?.pending_plan?.product_name ?? c.details?.walk_in?.plan_label ?? null,
          });
        }
      });

      // Process Family Groups
      const families = [
        ...(famInProgressRes.data || []),
        ...(famNewRes.data || [])
      ];
      families.forEach((f: any) => {
        if (f.profile_status !== "POLICYHOLDER") {
          unified.push({
            id: f.id,
            type: "FAMILY",
            name: f.name,
            contact_info: f.contact_phone || f.contact_email || "No contact",
            created_at: f.created_at,
            status: f.profile_status || "LEAD",
            assignedAgentId: f.assigned_agent_id ?? null,
            assignedAgentName: agentNameFor(f.assigned_agent_id),
          });
        }
      });

      // Process Organizations
      const orgs = [
        ...(orgInProgressRes.data || []),
        ...(orgNewRes.data || [])
      ];
      orgs.forEach((o: any) => {
        if (o.profile_status !== "POLICYHOLDER") {
          unified.push({
            id: o.id,
            type: "CORPORATE",
            name: o.name,
            contact_info: o.contact_phone || o.contact_email || "No contact",
            created_at: o.created_at,
            status: o.profile_status || "LEAD",
            primaryIdentifier: o.registration_number,
            assignedAgentId: o.assigned_agent_id ?? null,
            assignedAgentName: agentNameFor(o.assigned_agent_id),
          });
        }
      });

      // 1. Sort by OLD to NEW first so we can assign sequence numbers chronologically
      unified.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      let indCount = 0;
      let famCount = 0;
      let corpCount = 0;

      unified.forEach((lead) => {
        let seq = 0;
        let prefix = "";
        if (lead.type === "INDIVIDUAL") {
          indCount++;
          seq = indCount;
          prefix = "IND";
        } else if (lead.type === "FAMILY") {
          famCount++;
          seq = famCount;
          prefix = "FAM";
        } else if (lead.type === "CORPORATE") {
          corpCount++;
          seq = corpCount;
          prefix = "CORP";
        }
        const dt = new Date(lead.created_at);
        const yymm = `${dt.getFullYear().toString().slice(-2)}${(dt.getMonth() + 1).toString().padStart(2, "0")}`;
        lead.displayId = `${prefix}-${yymm}-${seq.toString().padStart(3, "0")}`;
      });

      // 1b. Work out how far each lead has really got. profile_status alone can't say: every registered customer
      // sits at "ready for underwriting" whatever their proposal is doing, and a customer has one quote per plan.
      // So take the MOST ADVANCED proposal (quote) and underwriting case each lead has. Best effort: without
      // them the board falls back to the lead's own status.
      try {
        const QUOTE_RANK: Record<string, number> = {
          Declined: 0, Quoted: 1, Proposed: 2, InformationRequested: 2, UnderReview: 3,
          Approved: 4, AcceptedWithLoadings: 4, PendingPayment: 5, Issued: 5, Active: 5,
        };
        const bestQuote = new Map<string, string>();
        const bestItem = new Map<string, { total_premium: number; plan_label: string; coverage_amount: number }>();
        const quoteCount = new Map<string, number>();
        for (const q of (await listQuotes()) ?? []) {
          quoteCount.set(q.customer_id, (quoteCount.get(q.customer_id) ?? 0) + 1);
          const have = bestQuote.get(q.customer_id);
          if ((QUOTE_RANK[q.status] ?? 1) > (have === undefined ? -1 : QUOTE_RANK[have] ?? 1)) {
            bestQuote.set(q.customer_id, q.status);
            bestItem.set(q.customer_id, q);
          }
        }
        unified.forEach((l) => {
          if (l.type !== "INDIVIDUAL") return;
          l.proposalStatus = bestQuote.get(l.id) ?? null;
          const q = bestItem.get(l.id);
          l.quotation = q
            ? { amount: q.total_premium, plan: q.plan_label, coverage: q.coverage_amount, extra: (quoteCount.get(l.id) ?? 1) - 1 }
            : null;
        });
      } catch { /* proposal statuses unavailable */ }
      try {
        // An open case beats a closed one; Approved beats the rest.
        const CASE_RANK: Record<string, number> = { Closed: 0, Rejected: 1, New: 2, InProgress: 3, "Pending Documents": 3, "Under Review": 4, Approved: 5 };
        const bestCase = new Map<string, string>();
        const heldCase = new Map<string, { caseId: string; reason: string | null }>();
        const note = (key: string | undefined | null, status: string) => {
          if (!key) return;
          const have = bestCase.get(key);
          if ((CASE_RANK[status] ?? 2) > (have === undefined ? -1 : CASE_RANK[have] ?? 2)) bestCase.set(key, status);
        };
        for (const c of (await listCases(tenantId)) ?? []) {
          if (c.on_hold) for (const k of [c.customer_id, c.family_group_id, c.organization_id]) if (k) heldCase.set(k, { caseId: c.caseld, reason: c.hold_reason ?? null });
          note(c.customer_id, c.caseStatus);
          note(c.family_group_id, c.caseStatus);
          note(c.organization_id, c.caseStatus);
        }
        unified.forEach((l) => {
          l.caseStatus = bestCase.get(l.id) ?? null;
          const h = heldCase.get(l.id);
          l.onHold = !!h;
          l.holdReason = h?.reason ?? null;
          l.holdCaseId = h?.caseId ?? null;
        });
      } catch { /* cases unavailable */ }

      // Leads from the customer portal's walk-in sign-up: who has them and whether anyone has picked them up yet.
      try {
        const rows: any[] = (await api.get(`/tenants/${tenantId}/walk-in-leads`)).data ?? [];
        const byCustomer = new Map(rows.map((r) => [r.family_group_id ?? r.customer_id, r]));       // a family request is about its family group
        unified.forEach((l) => {
          const r = byCustomer.get(l.id);
          if (!r) return;
          l.walkIn = {
            id: r.id, applicantType: r.applicant_type === "Family" ? "Family" : "Self", reference: r.reference, planLabel: r.plan_label, routingStatus: r.routing_status, awaiting: !!r.awaiting_acknowledgement,
            overdue: !!r.overdue, escalated: !!r.escalated, unassigned: r.routing_status === "Unassigned" || r.routing_status === "Pending", reason: r.escalation_reason ?? r.routing_reason ?? null,
          };
        });
      } catch { /* walk-in queue unavailable: leads still list normally */ }

      // 2. Sort by newest first
      unified.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      announceNewLeads(unified);
      // Tell the welcome tour about a lead that just appeared (the newest one), so it can follow it.
      const seen = tourSeenIds.current;
      tourSeenIds.current = new Set(unified.map((l) => l.id));
      if (seen) {
        const fresh = unified.find((l) => !seen.has(l.id));
        if (fresh) announceTourLead({ id: fresh.id, name: fresh.name, type: fresh.type });
      }
      setLeads(unified);
    } catch (err: any) {
      setError(err.message || tx("Failed to load leads"));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Compares an incoming snapshot against the previous one and raises a toast —
   * plus an interrupting dialog — for leads that were not there before. This is
   * what surfaces a lead an agent just created in the mobile app.
   */
  const announceNewLeads = (incoming: UnifiedLead[]) => {
    // A form that is still saving a lead (and may yet roll it back) has paused this — the baseline is left
    // alone, so whatever it created is announced after it finishes only if it is still there.
    if (leadAnnouncementsPaused()) return;
    const known = knownLeadIds.current;

    // The first load establishes the baseline. Announcing it would fire a
    // notification for every lead already on the board.
    if (known === null) {
      knownLeadIds.current = new Set(incoming.map((l) => l.id));
      return;
    }

    const fresh = incoming.filter((l) => !known.has(l.id));
    knownLeadIds.current = new Set(incoming.map((l) => l.id));
    if (fresh.length === 0) return;

    notify(
      fresh.length === 1
        ? tx("New lead: {0}{1}", { 0: fresh[0].name, 1: fresh[0].assignedAgentName ? ` — added by ${fresh[0].assignedAgentName}` : "" })
        : tx("{0} new leads added", { 0: fresh.length }),
      true,
    );

    setIncomingLeads((prev) => [
      ...prev,
      ...fresh.map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        contact_info: l.contact_info,
        agentName: l.assignedAgentName,
        createdAt: l.created_at,
      })),
    ]);
  };

  // The Status dropdown. The first group filters on the lead's own stage; the second on where
  // its proposal has got to, which is what an agent follows after submitting.
  const matchesStatus = (l: UnifiedLead, filter: string = statusFilter) => {
    // The same stage the Progress column shows, so a filter and the lead it finds always agree.
    const st = leadStage(l);
    switch (filter) {
      case "ALL": return true;
      case "ACTIVE": return l.status !== "NOT_INTERESTED" && l.status !== "POLICYHOLDER" && st.tone !== "red";
      case "LEAD": return st.step === 1;
      case "IN_PROGRESS": return st.label === "In proposal" || st.label === "Proposal draft";
      case "SUBMITTED": return st.label === "Application submitted";
      case "UNDER_REVIEW": return st.label === "Application under review";
      case "INFO_REQUESTED": return st.label === "Info requested";
      case "UNDERWRITING": return st.label === "In underwriting";
      case "ON_HOLD": return !!l.onHold;
      case "WALK_IN": return !!l.walkIn && (l.walkIn.awaiting || l.walkIn.escalated || l.walkIn.unassigned);
      case "APPROVED": return st.label === "Approved" || st.step === 5;
      case "REJECTED": return st.tone === "red";
      case "DEAD": return l.status === "NOT_INTERESTED";
      case "POLICYHOLDER": return l.status === "POLICYHOLDER";
      default: return true;
    }
  };

  const getFilteredLeads = () => {
    const q = search.trim().toLowerCase();
    return leads.filter(l => {
      if (filterType !== "ALL" && l.type !== filterType) return false;
      if (!matchesStatus(l)) return false;
      if (q) {
        const haystack = `${l.name} ${l.contact_info} ${l.primaryIdentifier ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  };

  const getStatsLeads = () => {
    const q = search.trim().toLowerCase();
    return leads.filter(l => {
      if (!matchesStatus(l)) return false;
      if (q) {
        const haystack = `${l.name} ${l.contact_info} ${l.primaryIdentifier ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  };

  const leadsByColumn = {
    lead: getFilteredLeads().filter(l => l.status === "LEAD"),
    in_progress: getFilteredLeads().filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY"),
    dead_leads: getFilteredLeads().filter(l => l.status === "NOT_INTERESTED"),
  };

  const handleOpenEditForm = async (lead: UnifiedLead) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      if (lead.type === "INDIVIDUAL") {
        const res = await api.get(`/tenants/${tenantId}/customers/${lead.id}`);
        setEditEntityData({ type: "INDIVIDUAL", data: res.data });
      } else if (lead.type === "FAMILY") {
        const res = await api.get(`/tenants/${tenantId}/families/${lead.id}`);
        setEditEntityData({ type: "FAMILY", data: res.data });
      } else if (lead.type === "CORPORATE") {
        const res = await api.get(`/tenants/${tenantId}/organizations/${lead.id}`);
        setEditEntityData({ type: "CORPORATE", data: res.data });
      }
    } catch (err) {
      console.error("Failed to load entity details for editing", err);
    }
  };

  const arrivalIds = useMemo(() => leads.map((l) => l.id), [leads]);
  const arrivals = useNewArrivals("leads", arrivalIds, !loading, recentIds(leads, (l) => l.id, (l) => l.created_at));
  const handleCardClick = (lead: UnifiedLead) => {
    arrivals.markSeen(lead.id);
    setSelectedEntity({ id: lead.id, type: lead.type });
  };

  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const entityBase = (type: EntityType) =>
    type === "INDIVIDUAL" ? "customers" : type === "FAMILY" ? "families" : "organizations";

  // Customers update status via PUT; families & organizations via PATCH.
  const changeLeadStatus = async (lead: UnifiedLead, next: ProfileStatus, successMsg: string) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setActionBusyId(lead.id);
    setError("");
    try {
      const path = `/tenants/${tenantId}/${entityBase(lead.type)}/${lead.id}`;
      if (lead.type === "INDIVIDUAL") {
        await api.put(path, { profile_status: next });
      } else {
        await api.patch(path, { profile_status: next });
      }
      setNotice(successMsg);
      await fetchLeads();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to update status."));
    } finally {
      setActionBusyId(null);
    }
  };

  // Take the lead's underwriting case off hold: it continues from the step where it was paused.
  const handleRemoveHold = async (lead: UnifiedLead) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || !lead.holdCaseId) return;
    setActionBusyId(lead.id);
    setError("");
    try {
      await api.post(`/tenants/${tenantId}/cases/${lead.holdCaseId}/release`, {});
      setNotice(tx("Hold removed for \"{0}\". Underwriting continues from where it stopped.", { 0: lead.name }));
      await fetchLeads();
    } catch (err: any) {
      setError(err.message ?? tx("Could not remove the hold."));
    } finally {
      setActionBusyId(null);
    }
  };

  // What a walk-in family submitted: the head's details and the household, to enrol the members from.
  const [walkInDetail, setWalkInDetail] = useState<any | null>(null);
  const openWalkInDetail = async (lead: UnifiedLead) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || !lead.walkIn) return;
    try { setWalkInDetail((await api.get(`/tenants/${tenantId}/walk-in-leads/${lead.walkIn.id}`)).data); }
    catch (err: any) { setError(err?.response?.data?.detail || err?.message || tx("Could not load the walk-in details")); }
  };

  // The agent confirms they have the walk-in lead; this stops the escalation timer.
  const handleAcknowledgeWalkIn = async (lead: UnifiedLead) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || !lead.walkIn) return;
    setActionBusyId(lead.id);
    setError("");
    try {
      await api.post(`/tenants/${tenantId}/walk-in-leads/${lead.walkIn.id}/acknowledge`);
      setNotice(tx("\"{0}\" acknowledged.", { 0: lead.name }));
      await fetchLeads();
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || tx("Could not acknowledge the lead"));
    } finally {
      setActionBusyId(null);
    }
  };

  const handleMoveInProgress = (lead: UnifiedLead) =>
    changeLeadStatus(lead, "PROSPECT", `"${lead.name}" moved to In Progress.`);

  // "Create Proposal" is what moves a lead into Proposals, and takes you there.
  const handleSendDraft = async (lead: UnifiedLead) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setActionBusyId(lead.id);
    setError("");
    try {
      if (lead.type === "INDIVIDUAL") {
        // An individual's proposal is built from the plan chosen on the Insurance Plan tab. Without one,
        // open the lead on that tab instead of sending an empty draft.
        const { data: customer } = await api.get(`/tenants/${tenantId}/customers/${lead.id}`);
        if (!customer.details?.pending_plan && !customer.details?.plan_policy_id) {
          // Unknown (e.g. an agent can't list policies) is not "no plan" — let the draft through.
          const policies = await api.get(`/tenants/${tenantId}/customers/${lead.id}/policies`).then((r) => r.data, () => null);
          if (Array.isArray(policies) && policies.length === 0) {
            setNotice(tx("Choose an insurance plan for \"{0}\" before sending the draft.", { 0: lead.name }));
            setEditEntityData({ type: "INDIVIDUAL", data: customer, tab: "insurance_plan" });
            return;
          }
        }
      }
      // in_plan_selection belonged to the retired Plan Selection board.
      await sendLeadToDraft(lead.type, lead.id, lead.name, { clear: ["in_plan_selection"] });
      if (isEmbedded()) {
        setNotice(tx("\"{0}\" sent to Proposals as a draft.", { 0: lead.name }));
        await fetchLeads();
      } else {
        router.push("/proposal");
      }
    } catch (err: any) {
      const message: string = err.response?.data?.detail ?? err.message ?? tx("Failed to send draft.");
      // An early-knockout decline opens the lead's details popup, which explains it and offers "Move anyway".
      if (message.startsWith("Not eligible for cover")) {
        setDeclineMessage(message);
        setSelectedEntity({ id: lead.id, type: lead.type });
      } else setError(message);
    } finally {
      setActionBusyId(null);
    }
  };

  const handleMarkNotInterested = (lead: UnifiedLead) =>
    changeLeadStatus(lead, "NOT_INTERESTED", `"${lead.name}" moved to Dead Leads.`);

  const handleReactivate = (lead: UnifiedLead) =>
    changeLeadStatus(lead, "LEAD", `"${lead.name}" reactivated.`);

  const handleDeleteLead = async (lead: UnifiedLead) => {
    if (!confirm(tx("Delete this {0} \"{1}\"? This action cannot be undone.", { 0: lead.type.toLowerCase(), 1: lead.name }))) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setActionBusyId(lead.id);
    setError("");
    try {
      await api.delete(`/tenants/${tenantId}/${entityBase(lead.type)}/${lead.id}`);
      setNotice(tx("\"{0}\" deleted.", { 0: lead.name }));
      await fetchLeads();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to delete."));
    } finally {
      setActionBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const statsLeads = getStatsLeads();
  const filteredLeads = getFilteredLeads();

  return (
    <div className="px-6 py-5 space-y-4 max-w-screen-2xl mx-auto w-full font-sans">
      <NewArrivalsBanner count={arrivals.newIds.size} noun="lead" onShow={scrollToFirstNew} onDismiss={arrivals.markAllSeen} />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Lead/Customer Acquisition")}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isAgent ? tx("Add leads and take them as far as a submitted proposal.") : tx("Manage & track your prospects across all segments.")}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={() => setChooserType("INDIVIDUAL")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow active:scale-95"
          >
            {tx("+ Add Individual")}
          </button>
          <button
            onClick={() => setChooserType("FAMILY")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm active:scale-95"
          >
            {tx("+ Add Family")}
          </button>
          <button
            onClick={() => setChooserType("CORPORATE")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm active:scale-95"
          >
            {tx("+ Add Corporate")}
          </button>
        </div>
      </div>

      {/* Filters, search */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 w-full">
          <div className="inline-flex h-[42px] items-stretch bg-white p-1 rounded-xl shadow-sm border border-slate-200 shrink-0">
            {["ALL", "INDIVIDUAL", "FAMILY", "CORPORATE"].map((ft) => (
              <button
                key={ft}
                onClick={() => setFilterType(ft as FilterType)}
                className={`inline-flex items-center gap-2 px-3.5 rounded-lg text-sm font-semibold transition-colors ${filterType === ft
                  ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  }`}
              >
                {ft === "ALL" ? tx("All") : ft === "INDIVIDUAL" ? tx("Individual") : ft === "FAMILY" ? tx("Family") : tx("Corporate")}
                {/* Counts honour the search and status filters, not the type tab itself — what the stat cards showed. */}
                <span className={`min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${filterType === ft ? "bg-white text-blue-700 ring-1 ring-inset ring-blue-100" : "bg-slate-100 text-slate-500"}`}>
                  {ft === "ALL" ? statsLeads.length : statsLeads.filter(l => l.type === ft).length}
                </span>
              </button>
            ))}
          </div>

          <div className="relative w-full max-w-[320px] shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tx("Search by name, contact, identifier...")}
              className="w-full h-[42px] pl-9 pr-8 text-sm border border-slate-200 rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-shadow"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>

          <div className="shrink-0">
            <FiltersPanel
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateFromChange={setDateFrom}
              onDateToChange={setDateTo}
              cityInput={cityInput}
              onCityInputChange={setCityInput}
              provinceFilter={provinceFilter}
              onProvinceChange={setProvinceFilter}
              branchFilter={branchFilter}
              onBranchChange={setBranchFilter}
              branchOptions={branchOptions}
              sourceFilter={sourceFilter}
              onSourceChange={setSourceFilter}
              sourceOptions={sourceOptions}
              activeCount={structuredFilterCount}
              onClearAll={clearFilters}
            />
          </div>



          {/* View Mode Toggle */}
          <div className="ml-auto shrink-0 inline-flex h-[42px] items-stretch bg-white p-1 rounded-xl shadow-sm border border-slate-200">
            <button
              type="button"
              onClick={() => setViewMode("kanban")}
              title={tx("Kanban Board")}
              className={`p-2 rounded-lg transition-all ${viewMode === "kanban"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
                }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <rect x="3" y="3" width="7" height="9" />
                <rect x="14" y="3" width="7" height="5" />
                <rect x="14" y="12" width="7" height="9" />
                <rect x="3" y="16" width="7" height="5" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("table")}
              title={tx("Tabular View")}
              className={`p-2 rounded-lg transition-all ${viewMode === "table"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
                }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Where leads are in their journey: one tap to see only those, with how many */}
        {(() => {
          const q = search.trim().toLowerCase();
          const base = leads.filter((l) => {
            if (filterType !== "ALL" && l.type !== filterType) return false;
            if (!q) return true;
            return `${l.name} ${l.contact_info} ${l.primaryIdentifier ?? ""}`.toLowerCase().includes(q);
          });
          const stages: { id: string; label: string; dot: string }[] = [
            { id: "ALL", label: "All", dot: "bg-slate-400" },
            { id: "LEAD", label: "New lead", dot: "bg-amber-400" },
            { id: "IN_PROGRESS", label: "Proposal", dot: "bg-blue-500" },
            { id: "SUBMITTED", label: "Submitted", dot: "bg-blue-500" },
            { id: "UNDER_REVIEW", label: "Under review", dot: "bg-blue-500" },
            { id: "INFO_REQUESTED", label: "Info requested", dot: "bg-amber-400" },
            { id: "UNDERWRITING", label: "Underwriting", dot: "bg-blue-500" },
            { id: "ON_HOLD", label: "On hold", dot: "bg-amber-400" },
            { id: "WALK_IN", label: "Walk-in queue", dot: "bg-amber-400" },
            { id: "APPROVED", label: "Approved / policy", dot: "bg-emerald-500" },
            { id: "REJECTED", label: "Rejected", dot: "bg-rose-500" },
            { id: "DEAD", label: "Not interested", dot: "bg-slate-300" },
          ];
          return (
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={tx("Lead stage")}>
              {stages.map((st) => {
                const count = base.filter((l) => matchesStatus(l, st.id)).length;
                const on = statusFilter === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setStatusFilter(st.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      on ? "bg-slate-900 text-white" : count === 0 ? "text-slate-400 hover:bg-slate-100" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    {st.id !== "ALL" && <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-white" : count === 0 ? "bg-slate-300" : st.dot}`} />}
                    {tx(st.label)}
                    <span className={`tabular-nums ${on ? "text-slate-300" : "text-slate-400"}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          );
        })()}

        {activeFilterChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-blue-50 border border-blue-100 text-blue-700 text-xs font-medium"
              >
                {tx(chip.label)}
                <button
                  onClick={chip.onRemove}
                  className="w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-blue-100 text-blue-400 hover:text-blue-700"
                >
                  ✕
                </button>
              </span>
            ))}
            <button onClick={clearFilters} className="text-xs font-semibold text-slate-400 hover:text-blue-600 hover:underline ml-1">
              {tx("Clear all")}
            </button>
          </div>
        )}
      </div>

      {walkInDetail && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px] flex items-start justify-center overflow-y-auto py-10 px-4" onClick={() => setWalkInDetail(null)}>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">{tx("Walk-in family")} · <span className="font-mono">{walkInDetail.reference}</span></p>
              <button onClick={() => setWalkInDetail(null)} className="text-slate-400 hover:text-slate-600" aria-label={tx("Close")}>✕</button>
            </div>
            <div className="p-5 space-y-4 text-sm text-slate-700">
              {(() => {
                const hh = walkInDetail.household;
                const fam = hh?.family ?? {};
                const members: any[] = hh?.members ?? [];
                const head = members.find((m) => m.relationship === "Self") ?? {};
                return (
                  <>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{tx("Family")} · {fam.family_name ?? ""}</p>
                      <p className="text-xs text-slate-500">{[fam.contact_person, walkInDetail.contact_phone, walkInDetail.contact_email].filter(Boolean).join(" · ")}</p>
                      <p className="text-xs text-slate-500">{[[fam.city, fam.province].filter(Boolean).join(", "), fam.household_declared_income ? `${tx("household income")} PKR ${Number(fam.household_declared_income).toLocaleString()}` : null].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{tx("Policy wanted")}</p>
                      <p className="text-xs text-slate-600">
                        {fam.policy_type === "LifeBundle" ? tx("Life Bundle") : tx("Health Floater")} · {walkInDetail.plan_label}
                        {fam.total_sum_insured ? ` · ${tx("sum assured")} PKR ${Number(fam.total_sum_insured).toLocaleString()}` : ""}
                        {fam.discount_percentage ? ` · ${fam.discount_percentage}% ${tx("discount")}` : ""} · {fam.term_years} {tx("year(s)")}{fam.effective_date ? ` · ${tx("from")} ${fam.effective_date}` : ""}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{tx("Members")}</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-slate-400 text-left"><tr><th className="py-1 pr-2">{tx("Name")}</th><th className="pr-2">{tx("Relationship")}</th><th className="pr-2">{tx("Date of birth")}</th><th className="pr-2">{tx("Insured")}</th><th className="pr-2">{tx("Occupation / income")}</th><th className="text-right">{tx("Share")}</th></tr></thead>
                          <tbody className="divide-y divide-slate-100">
                            {members.map((m, i) => (
                              <tr key={i}>
                                <td className="py-1.5 pr-2 font-medium text-slate-800">{m.name}{m.cnic ? <span className="block font-mono font-normal text-slate-400">{m.cnic}</span> : null}</td>
                                <td className="pr-2">{m.relationship === "Self" ? tx("Head") : m.relationship}</td><td className="pr-2">{m.dob ?? "—"}</td><td className="pr-2">{m.is_insured ? tx("Yes") : tx("Nominee")}</td>
                                <td className="pr-2">{m.is_insured ? `${m.occupation ?? ""} · PKR ${Number(m.declared_income ?? 0).toLocaleString()}` : "—"}{m.coverage_amount ? ` · ${tx("cover")} PKR ${Number(m.coverage_amount).toLocaleString()}` : ""}</td>
                                <td className="text-right tabular-nums">{m.relationship === "Self" ? "—" : `${m.share_pct}%`}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {walkInDetail.message && <p className="text-xs text-slate-500">{tx("Their note")}: {walkInDetail.message}</p>}
                    <p className="text-[11px] text-slate-400">{tx("These are exactly the rows of the Add New Family form. Enrol the members from the Families page when you are ready; nothing has been set up for them yet.")}</p>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
      {notice && (
        <div className="p-4 bg-blue-50 border border-blue-200 text-blue-700 rounded-xl text-sm font-medium flex justify-between items-center">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} className="text-blue-400 hover:text-blue-700 font-bold ml-3">✕</button>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-xl text-sm font-medium">
          {error}
        </div>
      )}

      {/* Scrollable Container Wrapper to enforce viewport/split-pane boundaries */}
      <div className="w-full max-w-full overflow-hidden">
        {(() => {
          const filtered = getFilteredLeads();
          const itemsPerPage = 12;
          const totalItems = filtered.length;
          const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
          const paginated = filtered.slice(
            (currentPage - 1) * itemsPerPage,
            currentPage * itemsPerPage
          );

          return (
            <div className="flex flex-col gap-4 w-full">
              {viewMode === "kanban" ? (
                /* Kanban Board */
                <div className="flex flex-col md:flex-row gap-6 items-start overflow-x-auto pb-4 w-full">
                  {/* LEAD COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-amber-300">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                        {tx("Leads")}
                      </h3>
                      <span className="bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full" title={tx("Showing {0} of {1}", { 0: paginated.filter(l => l.status === "LEAD").length, 1: filtered.filter(l => l.status === "LEAD").length })}>
                        {filtered.filter(l => l.status === "LEAD").length}
                      </span>
                    </div>
                    {paginated.filter(l => l.status === "LEAD").map(lead => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        busy={actionBusyId === lead.id}
                        onClick={() => handleCardClick(lead)}
                        onMoveInProgress={() => handleMoveInProgress(lead)}
                        onSendDraft={() => handleSendDraft(lead)}
                        onRemoveHold={() => handleRemoveHold(lead)}
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={isAgent ? undefined : () => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>

                  {/* IN PROGRESS COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-blue-400">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                        {tx("In Progress")}
                      </h3>
                      <span className="bg-blue-100 text-blue-700 text-xs font-bold px-2 py-0.5 rounded-full" title={tx("Showing {0} of {1}", { 0: paginated.filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY").length, 1: filtered.filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY").length })}>
                        {filtered.filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY").length}
                      </span>
                    </div>
                    {paginated.filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY").map(lead => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        busy={actionBusyId === lead.id}
                        onClick={() => handleCardClick(lead)}
                        onMoveInProgress={() => handleMoveInProgress(lead)}
                        onSendDraft={() => handleSendDraft(lead)}
                        onRemoveHold={() => handleRemoveHold(lead)}
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={isAgent ? undefined : () => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>


                  {/* DRAFT COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-fuchsia-400">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-fuchsia-500"></span>
                        {tx("Draft")}
                      </h3>
                      <span className="bg-fuchsia-100 text-fuchsia-700 text-xs font-bold px-2 py-0.5 rounded-full" title={tx("Showing {0} of {1}", { 0: paginated.filter(l => l.status === "DRAFT").length, 1: filtered.filter(l => l.status === "DRAFT").length })}>
                        {filtered.filter(l => l.status === "DRAFT").length}
                      </span>
                    </div>
                    {paginated.filter(l => l.status === "DRAFT").map(lead => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        busy={actionBusyId === lead.id}
                        onClick={() => handleCardClick(lead)}
                        onMoveInProgress={() => handleMoveInProgress(lead)}
                        onSendDraft={() => handleSendDraft(lead)}
                        onRemoveHold={() => handleRemoveHold(lead)}
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={isAgent ? undefined : () => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>

                  {/* DEAD LEADS COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-slate-300">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
                        {tx("Dead Leads")}
                      </h3>
                      <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full" title={tx("Showing {0} of {1}", { 0: paginated.filter(l => l.status === "NOT_INTERESTED").length, 1: filtered.filter(l => l.status === "NOT_INTERESTED").length })}>
                        {filtered.filter(l => l.status === "NOT_INTERESTED").length}
                      </span>
                    </div>
                    {paginated.filter(l => l.status === "NOT_INTERESTED").map(lead => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        busy={actionBusyId === lead.id}
                        onClick={() => handleCardClick(lead)}
                        onMoveInProgress={() => handleMoveInProgress(lead)}
                        onSendDraft={() => handleSendDraft(lead)}
                        onRemoveHold={() => handleRemoveHold(lead)}
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={isAgent ? undefined : () => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                /* Tabular View */
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden w-full">
                  {totalItems === 0 ? (
                    <div className="p-12 text-center text-slate-500">
                      <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                      </svg>
                      <p>{tx("No leads or customers found.")}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto w-full">
                      <table className="w-full min-w-[1080px] text-left text-sm whitespace-nowrap">
                        <thead className="bg-white border-b border-slate-200">
                          <tr className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            <th className="pl-6 pr-4 py-3">{tx("Leads")}</th>
                            <th className="px-4 py-3">{tx("Type")}</th>
                            <th className="px-4 py-3">{tx("Agent")}</th>
                            <th className="px-4 py-3">{tx("Contact")}</th>
                            <th className="px-4 py-3">{tx("CNIC")}</th>
                            <th className="px-4 py-3">{tx("Date Added")}</th>
                            <th className="px-4 py-3 min-w-[260px]">{tx("Status")}</th>
                            <th className="pl-4 pr-6 py-3 text-right w-16"><span className="sr-only">{tx("Actions")}</span></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {paginated.map(lead => {
                            const busy = actionBusyId === lead.id;
                            const isDead = lead.status === "NOT_INTERESTED";
                            const isLead = lead.status === "LEAD";
                            const badge = TYPE_BADGES[lead.type];
                            const actions: LeadAction[] = [
                              { key: "form", label: tx("View Applicant Form"), icon: "form", onSelect: () => handleOpenEditForm(lead) },
                              ...(isDead
                                ? [{ key: "reactivate", label: tx("Reactivate"), icon: "reactivate", onSelect: () => handleReactivate(lead) } as LeadAction]
                                : [
                                    ...(canSendDraft(lead) ? [{ key: "proposal", label: tx("Create Proposal"), icon: "sparkles", tone: "magic", onSelect: () => handleSendDraft(lead) } as LeadAction] : []),
                                    ...(lead.walkIn && (lead.walkIn.awaiting || lead.walkIn.escalated) ? [{ key: "ack", label: tx("Acknowledge"), icon: "check", onSelect: () => handleAcknowledgeWalkIn(lead) } as LeadAction] : []),
                                    ...(isLead ? [{ key: "progress", label: tx("In Progress"), icon: "play", onSelect: () => handleMoveInProgress(lead) } as LeadAction] : []),
                                    ...(lead.onHold ? [{ key: "hold", label: tx("Remove Hold"), icon: "unlock", onSelect: () => handleRemoveHold(lead) } as LeadAction] : []),
                                    { key: "dead", label: tx("Not Interested"), icon: "notInterested", tone: "danger", onSelect: () => handleMarkNotInterested(lead) } as LeadAction,
                                  ]),
                              ...(!isAgent ? [{ key: "delete", label: tx("Delete"), icon: "trash", tone: "danger", onSelect: () => handleDeleteLead(lead) } as LeadAction] : []),
                            ];
                            return (
                              <tr
                                key={lead.id}
                                onClick={() => handleCardClick(lead)}
                                className={`group cursor-pointer transition-colors hover:bg-slate-50/70 ${isDead ? "opacity-60" : ""} ${arrivals.newIds.has(lead.id) ? NEW_ARRIVAL_CLASS : ""}`}
                              >
                                <td className="pl-6 pr-4 py-3.5">
                                  <div className="flex items-center gap-3">
                                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-100">
                                      {initials(lead.name)}
                                    </span>
                                    <div className="min-w-0">
                                      <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{lead.name}</div>
                                      <div className="mt-0.5 font-mono text-[11px] font-medium text-slate-500">{lead.displayId || "-"}</div>
                                      {lead.walkIn && (
                                        <div className="mt-1 flex flex-wrap items-center gap-1 font-normal">
                                          <span
                                            className={`text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-0.5 ${lead.walkIn.applicantType === "Family" ? "cursor-pointer hover:bg-blue-100" : ""}`}
                                            title={lead.walkIn.applicantType === "Family" ? tx("View the household they submitted") : lead.walkIn.reference}
                                            onClick={lead.walkIn.applicantType === "Family" ? (e) => { e.stopPropagation(); openWalkInDetail(lead); } : undefined}
                                          >{tx("Digital Walk-In")}{lead.walkIn.applicantType === "Family" ? ` · ${tx("Family")}` : ""}{lead.walkIn.planLabel ? ` · ${lead.walkIn.planLabel}` : ""}</span>
                                          {lead.walkIn.escalated && <span className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-1.5 py-0.5" title={lead.walkIn.reason ?? ""}>{tx("Escalated")}</span>}
                                          {!lead.walkIn.escalated && lead.walkIn.unassigned && <span className="text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5" title={lead.walkIn.reason ?? ""}>{tx("No agent yet")}</span>}
                                          {!lead.walkIn.escalated && lead.walkIn.awaiting && <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${lead.walkIn.overdue ? "text-rose-700 bg-rose-50 border-rose-200" : "text-amber-800 bg-amber-50 border-amber-200"}`}>{lead.walkIn.overdue ? tx("Overdue to acknowledge") : tx("Awaiting acknowledgement")}</span>}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td className="px-4 py-3.5">
                                  <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${badge.className}`}>
                                    {tx(badge.label)}
                                  </span>
                                </td>
                                <td className="px-4 py-3.5">
                                  <AgentCell lead={lead} />
                                </td>
                                <td className="px-4 py-3.5 text-xs text-slate-600">{lead.contact_info}</td>
                                <td className="px-4 py-3.5 font-mono text-xs text-slate-500">{lead.primaryIdentifier || "-"}</td>
                                <td className="px-4 py-3.5 text-xs text-slate-500">{displayDate(lead.created_at)}</td>
                                <td className="px-4 py-3.5">
                                  <LeadProgress lead={lead} />
                                </td>
                                <td className="pl-4 pr-6 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                                  <RowActionsMenu actions={actions} disabled={busy} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Shared Pagination Footer */}
              {totalItems > 0 && (
                <div className="bg-slate-50 px-6 py-4 border border-slate-200 rounded-xl shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4 w-full">
                  <div className="text-xs text-slate-500">
                    {tx("Showing")}{" "}<span className="font-semibold text-slate-700">{Math.min(totalItems, (currentPage - 1) * itemsPerPage + 1)}-{Math.min(totalItems, currentPage * itemsPerPage)}</span>{" "}{tx("of")}{" "}<span className="font-semibold text-slate-700">{totalItems}</span>{" "}{tx("leads")}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      {tx("Previous")}
                    </button>
                    <div className="text-xs font-semibold text-slate-700 px-2">
                      {tx("Page")}{" "}{currentPage}{" "}{tx("of")}{" "}{totalPages}
                    </div>
                    <button
                      onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      {tx("Next")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>


      {selectedEntity && (
        <UnifiedDetailsModal
          isOpen={true}
          onClose={() => { setSelectedEntity(null); setDeclineMessage(null); }}
          initialError={declineMessage ?? undefined}
          entityId={selectedEntity.id}
          entityType={selectedEntity.type}
          // Wrapped: the modal may pass its own arguments, which would land in
          // `fetchLeads`'s options parameter and silently suppress the spinner.
          onSaved={() => fetchLeads()}
        />
      )}

      {/* Step 1: choose Quick Lead vs Complete Detail */}
      <AddEntryChooser
        entityType={chooserType}
        onClose={() => setChooserType(null)}
        onSelect={(mode) => {
          if (chooserType === "INDIVIDUAL") setActiveAdd({ type: chooserType, mode });
          setChooserType(null);
        }}
      />

      {/* Step 2: the matching entry form — all inline, no navigation */}
      <CustomerQuickLeadModal
        open={activeAdd?.type === "INDIVIDUAL" && activeAdd.mode === "quick"}
        defaultAgentEmail={searchParams.get("agent_email")}
        defaultSourceId={searchParams.get("source_id")}
        defaultAgentId={searchParams.get("agent_id")}
        onClose={() => setActiveAdd(null)}
        onSaved={(message) => {
          handleAddSaved(message);
          // A quick lead is a one-shot capture with nothing further to do in
          // the form, so when this page is embedded in the Copilot panel, let
          // the chat close it and confirm. No-op outside the chat.
          notifyParentPortal("quick_lead_saved", { message });
        }}
      />
      <CustomerFormModal
        open={activeAdd?.type === "INDIVIDUAL" && activeAdd.mode === "full"}
        mode="create"
        defaultAcquisitionSourceId={searchParams.get("source_id")}
        onClose={() => setActiveAdd(null)}
        onSaved={(message, created) => {
          handleAddSaved(message, created);
          // Registered with full details — hand back to the Copilot (if this
          // page is embedded in it) so the conversation carries on with the
          // next step instead of stopping on the leads board. No-op otherwise.
          if (created) {
            notifyParentPortal("customer_saved", {
              id: created.id, name: created.name, cnic: created.cnic, hasProposal: created.hasProposal,
            });
          }
        }}
      />
      {editEntityData?.type === "INDIVIDUAL" && (
        <CustomerFormModal
          open={true}
          mode="edit"
          customer={editEntityData.data}
          initialTab={editEntityData.tab}
          onClose={() => setEditEntityData(null)}
          onSaved={(msg, ent) => {
            handleAddSaved(msg, ent);
            setEditEntityData(null);
          }}
        />
      )}
      <FamilyFormModal
        open={activeAdd?.type === "FAMILY"}
        mode={activeAdd?.type === "FAMILY" ? activeAdd.mode : "quick"}
        onClose={() => setActiveAdd(null)}
        onSaved={handleAddSaved}
      />
      {editEntityData?.type === "FAMILY" && (
        <FamilyFormModal
          open={true}
          mode="full"
          family={editEntityData.data}
          onClose={() => setEditEntityData(null)}
          onSaved={(msg, ent) => {
            handleAddSaved(msg, ent);
            setEditEntityData(null);
          }}
        />
      )}
      <OrganizationFormModal
        open={activeAdd?.type === "CORPORATE"}
        mode={activeAdd?.type === "CORPORATE" ? activeAdd.mode : "quick"}
        onClose={() => setActiveAdd(null)}
        onSaved={handleAddSaved}
      />
      {editEntityData?.type === "CORPORATE" && (
        <OrganizationFormModal
          open={true}
          mode="full"
          organization={editEntityData.data}
          onClose={() => setEditEntityData(null)}
          onSaved={(msg, ent) => {
            handleAddSaved(msg, ent);
            setEditEntityData(null);
          }}
        />
      )}

      {/* Raised when a lead lands while this board is open — typically created
          by an agent in the mobile app. */}
      <NewLeadAlert
        leads={incomingLeads}
        onDismiss={() => setIncomingLeads([])}
        onView={(lead) => {
          setIncomingLeads([]);
          setSelectedEntity({ id: lead.id, type: lead.type });
        }}
      />
    </div>
  );
}

function LeadCard({
  lead,
  onClick,
  busy,
  onMoveInProgress,
  onSendDraft,
  onRemoveHold,
  onMarkNotInterested,
  onReactivate,
  onDelete,
}: {
  lead: UnifiedLead;
  onClick: () => void;
  busy: boolean;
  onMoveInProgress: () => void;
  onSendDraft: () => void;
  onRemoveHold: () => void;
  onMarkNotInterested: () => void;
  onReactivate: () => void;
  onDelete?: () => void;
}) {
  const typeStyles = {
    INDIVIDUAL: "bg-blue-50 text-blue-700 border-blue-200",
    FAMILY: "bg-blue-50 text-blue-700 border-blue-200",
    CORPORATE: "bg-blue-50 text-blue-700 border-blue-200"
  };

  const isDead = lead.status === "NOT_INTERESTED";
  const isLead = lead.status === "LEAD";

  // Stop card-level navigation when interacting with an action button.
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  const btnBase = "px-2 py-1 text-[11px] font-semibold rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div
      onClick={onClick}
      className="group relative bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-blue-300 hover:-translate-y-1 transition-all duration-300 cursor-pointer overflow-hidden"
    >
      <div className="absolute top-0 left-0 w-1 h-full bg-slate-200 group-hover:bg-blue-500 transition-colors"></div>

      <div className="flex justify-between items-start mb-2">
        <div>
          <div className="text-[10px] font-mono font-medium text-slate-500 mb-0.5">{lead.displayId || "-"}</div>
          <h4 className="font-bold text-slate-800 text-sm truncate pr-2">{lead.name}</h4>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${typeStyles[lead.type]}`}>
          {lead.type}
        </span>
      </div>

      <div className="text-xs text-slate-500 font-medium flex items-center gap-2 mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
          <path fillRule="evenodd" d="M2 3.5A1.5 1.5 0 013.5 2h1.148a1.5 1.5 0 011.465 1.175l.716 3.223a1.5 1.5 0 01-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 006.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 011.767-1.052l3.223.716A1.5 1.5 0 0118 15.352V16.5a1.5 1.5 0 01-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 012.43 8.326 13.019 13.019 0 012 5V3.5z" clipRule="evenodd" />
        </svg>
        {lead.contact_info}
      </div>

      <div className="text-xs font-medium mb-2">
        <AgentCell lead={lead} compact />
      </div>

      {lead.primaryIdentifier && (
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          {tx("CNIC:")}{" "}{lead.primaryIdentifier}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400">
        <span>{tx("Added")}{" "}{displayDate(lead.created_at)}</span>
        <span className="text-blue-600 font-semibold group-hover:underline">{tx("View Details →")}</span>
      </div>

      {/* Contextual actions — depend on the lead's current pipeline stage */}
      <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {isDead ? (
          <button disabled={busy} onClick={act(onReactivate)} className={`${btnBase} text-blue-700 bg-blue-50 hover:bg-blue-100`}>
            {tx("Reactivate")}
          </button>
        ) : (
          <>
            {isLead && (
              <button disabled={busy} onClick={act(onMoveInProgress)} className={`${btnBase} text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                {tx("In Progress")}
              </button>
            )}
            {lead.onHold && (
              <button disabled={busy} onClick={act(onRemoveHold)} className={`${btnBase} text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                {tx("Remove Hold")}
              </button>
            )}
            {canSendDraft(lead) && (
              <button disabled={busy} onClick={act(onSendDraft)} className={`${btnBase} inline-flex items-center gap-1 text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                <ActionIcon name="sparkles" className="w-3.5 h-3.5" />
                {tx("Create Proposal")}
              </button>
            )}
            <button disabled={busy} onClick={act(onMarkNotInterested)} className={`${btnBase} text-rose-600 bg-rose-50 hover:bg-rose-100`}>
              {tx("Not Interested")}
            </button>
          </>
        )}
        {onDelete && (
          <button disabled={busy} onClick={act(onDelete)} className={`${btnBase} text-red-600 bg-white border border-red-100 hover:bg-red-50 ml-auto`}>
            {tx("Delete")}
          </button>
        )}
      </div>
    </div>
  );
}
