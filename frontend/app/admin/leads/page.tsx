"use client";

import { useState, useEffect, useRef } from "react";
import { listBranches, Branch } from "@/app/services/branches";
import { listAcquisitionSources, AcquisitionSource } from "@/app/services/acquisitionSources";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import api from "@/app/services/api";
import { resetFunnel } from "@/app/services/demo";
import UnifiedDetailsModal from "@/components/UnifiedDetailsModal";
import FiltersPanel from "@/components/FiltersPanel";
import AddEntryChooser, { EntryEntityType } from "@/components/entities/AddEntryChooser";
import NewLeadAlert, { NewLeadInfo } from "@/components/NewLeadAlert";
import { getUserDirectory } from "@/app/services/agents";
import { useNotify } from "@/components/NotificationContext";
import CustomerFormModal from "@/components/entities/CustomerFormModal";
import CustomerQuickLeadModal from "@/components/entities/CustomerQuickLeadModal";
import FamilyFormModal from "@/components/entities/FamilyFormModal";
import OrganizationFormModal from "@/components/entities/OrganizationFormModal";
import { MetricCard } from "@/components/MetricCard";

type EntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";
type ProfileStatus = "LEAD" | "PROSPECT" | "UNDERWRITING_READY" | "NOT_INTERESTED" | "POLICYHOLDER";

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
}

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
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  /** Leads that appeared since the board was opened, awaiting acknowledgement. */
  const [incomingLeads, setIncomingLeads] = useState<NewLeadInfo[]>([]);
  /**
   * Ids from the previous snapshot, for detecting genuinely new leads.
   * `null` means no baseline yet — the next fetch establishes one silently.
   */
  const knownLeadIds = useRef<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
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
  const [editEntityData, setEditEntityData] = useState<{ type: EntityType; data: any } | null>(null);
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
    if (cnicQuery && leads.length > 0) {
      const match = leads.find(l => l.primaryIdentifier === cnicQuery);
      if (match) setSelectedEntity({ id: match.id, type: match.type });
    }
  }, [cnicQuery, leads]);

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

  // Surface the post-reset confirmation once the page has reloaded fresh.
  useEffect(() => {
    try {
      const msg = sessionStorage.getItem("funnelResetMsg");
      if (msg) {
        setResetMsg(msg);
        sessionStorage.removeItem("funnelResetMsg");
      }
    } catch { /* sessionStorage unavailable — non-fatal */ }
  }, []);

  const handleResetFunnel = async () => {
    if (!window.confirm(
      "Reset demo data?\n\nThis wipes ALL customers, policies, cases and funnel data for this tenant, "
      + "then restores the 5 leads (3 individual + 1 family + 1 corporate) + 3 draft proposals. Every other screen (underwriting, "
      + "applications, issuance, policyholders) goes back to 0 records."
    )) return;
    setResetting(true);
    setResetMsg(null);
    try {
      const r = await resetFunnel();
      // Every customer id from before the reset is now stale — a lingering
      // selection or open edit/delete would 404 ("Customer not found"). A full
      // reload rebuilds all page state from the freshly-seeded data.
      try {
        sessionStorage.setItem(
          "funnelResetMsg",
          `Reset complete — ${r.seeded_leads} leads restored (${r.purged_customers} records cleared).`,
        );
      } catch { /* sessionStorage unavailable — non-fatal */ }
      window.location.reload();
    } catch (e: any) {
      setResetMsg(e?.message ?? "Reset failed.");
      setResetting(false);
    }
  };

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
      setError("No active tenant found.");
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
            contact_info: c.details?.phone || "No phone",
            created_at: c.created_at,
            status: c.profile_status || "LEAD",
            primaryIdentifier: c.cnic,
            assignedAgentId: c.assigned_agent_id ?? null,
            assignedAgentName: agentNameFor(c.assigned_agent_id),
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

      // 2. Sort by newest first
      unified.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      announceNewLeads(unified);
      setLeads(unified);
    } catch (err: any) {
      setError(err.message || "Failed to load leads");
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
        ? `New lead: ${fresh[0].name}${fresh[0].assignedAgentName ? ` — added by ${fresh[0].assignedAgentName}` : ""}`
        : `${fresh.length} new leads added`,
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

  const getFilteredLeads = () => {
    const q = search.trim().toLowerCase();
    return leads.filter(l => {
      if (filterType !== "ALL" && l.type !== filterType) return false;
      if (statusFilter !== "ALL") {
        if (statusFilter === "IN_PROGRESS" && (l.status !== "PROSPECT" && l.status !== "UNDERWRITING_READY")) return false;
        if (statusFilter === "DRAFT" && l.status !== "DRAFT") return false;
        if (statusFilter === "LEAD" && l.status !== "LEAD") return false;
        if (statusFilter === "DEAD" && l.status !== "NOT_INTERESTED") return false;
        if (statusFilter === "POLICYHOLDER" && l.status !== "POLICYHOLDER") return false;
      }
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
      if (statusFilter !== "ALL") {
        if (statusFilter === "IN_PROGRESS" && (l.status !== "PROSPECT" && l.status !== "UNDERWRITING_READY")) return false;
        if (statusFilter === "DRAFT" && l.status !== "DRAFT") return false;
        if (statusFilter === "LEAD" && l.status !== "LEAD") return false;
        if (statusFilter === "DEAD" && l.status !== "NOT_INTERESTED") return false;
        if (statusFilter === "POLICYHOLDER" && l.status !== "POLICYHOLDER") return false;
      }
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

  const handleCardClick = (lead: UnifiedLead) => {
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
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update status.");
    } finally {
      setActionBusyId(null);
    }
  };

  const handleMoveInProgress = (lead: UnifiedLead) =>
    changeLeadStatus(lead, "PROSPECT", `"${lead.name}" moved to In Progress.`);

  const handleMarkNotInterested = (lead: UnifiedLead) =>
    changeLeadStatus(lead, "NOT_INTERESTED", `"${lead.name}" moved to Dead Leads.`);

  const handleReactivate = (lead: UnifiedLead) =>
    changeLeadStatus(lead, "LEAD", `"${lead.name}" reactivated.`);

  const handleDeleteLead = async (lead: UnifiedLead) => {
    if (!confirm(`Delete this ${lead.type.toLowerCase()} "${lead.name}"? This action cannot be undone.`)) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setActionBusyId(lead.id);
    setError("");
    try {
      await api.delete(`/tenants/${tenantId}/${entityBase(lead.type)}/${lead.id}`);
      setNotice(`"${lead.name}" deleted.`);
      await fetchLeads();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete.");
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
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Leads</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage & track your prospects across all segments.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={handleResetFunnel}
            disabled={resetting}
            title="Wipe all data and restore the 5 leads (3 individual + 1 family + 1 corporate)"
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-all shadow-sm disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 ${resetting ? "animate-spin" : ""}`}>
              <path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            {resetting ? "Resetting…" : "Reset Demo Data"}
          </button>
          <button
            onClick={() => router.push("/plans")}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-all shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="13" y2="17" />
            </svg>
            Insurance Plans
          </button>
          <button
            onClick={() => setChooserType("INDIVIDUAL")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow active:scale-95"
          >
            + Add Individual
          </button>
          <button
            onClick={() => setChooserType("FAMILY")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow active:scale-95"
          >
            + Add Family
          </button>
          <button
            onClick={() => setChooserType("CORPORATE")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow active:scale-95"
          >
            + Add Corporate
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Leads"
          value={statsLeads.length}
          accent="blue"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>}
        />
        <MetricCard
          title="Individual"
          value={statsLeads.filter(l => l.type === "INDIVIDUAL").length}
          accent="blue"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>}
        />
        <MetricCard
          title="Family"
          value={statsLeads.filter(l => l.type === "FAMILY").length}
          accent="blue"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 3l9 7-9 7-9-7 9-7z" /><circle cx="8" cy="17" r="2" /><circle cx="16" cy="17" r="2" /><path d="M8 15v-2a4 4 0 018 0v2" /></svg>}
        />
        <MetricCard
          title="Corporate"
          value={statsLeads.filter(l => l.type === "CORPORATE").length}
          accent="blue"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18z" /><path d="M6 12H4a2 2 0 00-2 2v8h4" /><path d="M18 9h2a2 2 0 012 2v11h-4" /></svg>}
        />
      </div>

      {/* Filters, search */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 w-full">
          <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner backdrop-blur-md border border-slate-200/60 shrink-0">
            {["ALL", "INDIVIDUAL", "FAMILY", "CORPORATE"].map((ft) => (
              <button
                key={ft}
                onClick={() => setFilterType(ft as FilterType)}
                className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${filterType === ft
                  ? "bg-white text-blue-600 shadow-md ring-1 ring-black/5 scale-[1.02]"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
                  }`}
              >
                {ft === "ALL" ? "All" : ft === "INDIVIDUAL" ? "Individual" : ft === "FAMILY" ? "Family" : "Corporate"}
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
              placeholder="Search by name, contact, identifier..."
              className="w-full pl-9 pr-8 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-shadow"
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

          <div className="shrink-0">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={`appearance-none px-4 py-2 pr-10 h-[38px] text-sm font-semibold text-slate-700 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 shadow-sm bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22none%22%20stroke%3D%22%2364748b%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%224%206%208%2010%2012%206%22%2F%3E%3C%2Fsvg%3E')] bg-[length:16px_16px] bg-[right_16px_center] bg-no-repeat ${statusFilter === 'ALL' ? 'bg-slate-100' : 'bg-white'}`}
            >
              <option value="ALL">All</option>
              <option value="LEAD">Leads</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="DRAFT">Draft</option>
              <option value="DEAD">Dead</option>
            </select>
          </div>

          {/* View Mode Toggle */}
          <div className="ml-auto shrink-0 inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner border border-slate-200/60">
            <button
              type="button"
              onClick={() => setViewMode("kanban")}
              title="Kanban Board"
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
              title="Tabular View"
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

        {activeFilterChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-blue-50 border border-blue-100 text-blue-700 text-xs font-medium"
              >
                {chip.label}
                <button
                  onClick={chip.onRemove}
                  className="w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-blue-100 text-blue-400 hover:text-blue-700"
                >
                  ✕
                </button>
              </span>
            ))}
            <button onClick={clearFilters} className="text-xs font-semibold text-slate-400 hover:text-blue-600 hover:underline ml-1">
              Clear all
            </button>
          </div>
        )}
      </div>

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

      {resetMsg && (
        <div className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 text-blue-700 rounded-xl text-sm font-medium">
          <span>{resetMsg}</span>
          <button onClick={() => setResetMsg(null)} className="text-blue-500 hover:text-blue-700 text-lg leading-none">×</button>
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
                        Leads
                      </h3>
                      <span className="bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full" title={`Showing ${paginated.filter(l => l.status === "LEAD").length} of ${filtered.filter(l => l.status === "LEAD").length}`}>
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
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={() => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>

                  {/* IN PROGRESS COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-blue-400">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                        In Progress
                      </h3>
                      <span className="bg-blue-100 text-blue-700 text-xs font-bold px-2 py-0.5 rounded-full" title={`Showing ${paginated.filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY").length} of ${filtered.filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY").length}`}>
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
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={() => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>


                  {/* DRAFT COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-fuchsia-400">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-fuchsia-500"></span>
                        Draft
                      </h3>
                      <span className="bg-fuchsia-100 text-fuchsia-700 text-xs font-bold px-2 py-0.5 rounded-full" title={`Showing ${paginated.filter(l => l.status === "DRAFT").length} of ${filtered.filter(l => l.status === "DRAFT").length}`}>
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
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={() => handleDeleteLead(lead)}
                      />
                    ))}
                  </div>

                  {/* DEAD LEADS COLUMN */}
                  <div className="flex flex-col gap-3 flex-1 min-w-[280px] w-full">
                    <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-slate-300">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
                        Dead Leads
                      </h3>
                      <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full" title={`Showing ${paginated.filter(l => l.status === "NOT_INTERESTED").length} of ${filtered.filter(l => l.status === "NOT_INTERESTED").length}`}>
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
                        onMarkNotInterested={() => handleMarkNotInterested(lead)}
                        onReactivate={() => handleReactivate(lead)}
                        onDelete={() => handleDeleteLead(lead)}
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
                      <p>No leads or customers found.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto w-full">
                      <table className="w-full min-w-[1000px] text-left text-sm whitespace-nowrap">
                        <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-100">
                          <tr>
                            <th className="px-6 py-4">Lead ID</th>
                            <th className="px-6 py-4">
                              {filterType === "INDIVIDUAL" ? "Lead/Individual Name" :
                                filterType === "FAMILY" ? "Lead/Family Member Name" :
                                  filterType === "CORPORATE" ? "Lead/Corporate Name" :
                                    "All Leads"}
                            </th>
                            <th className="px-6 py-4">Type</th>
                            <th className="px-6 py-4">Agent</th>
                            <th className="px-6 py-4">Contact</th>
                            <th className="px-6 py-4">CNIC</th>
                            <th className="px-6 py-4">Date Added</th>
                            <th className="px-6 py-4">Status</th>
                            <th className="px-4 py-4 w-10"></th>
                            <th className="px-6 py-4 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {paginated.map(lead => {
                            const busy = actionBusyId === lead.id;
                            const isDead = lead.status === "NOT_INTERESTED";
                            const isLead = lead.status === "LEAD";
                            const typeStyles = {
                              INDIVIDUAL: "bg-blue-50 text-blue-700 border-blue-200",
                              FAMILY: "bg-blue-50 text-blue-700 border-blue-200",
                              CORPORATE: "bg-blue-50 text-blue-700 border-blue-200"
                            };
                            const statusStyles = {
                              LEAD: "bg-amber-50 text-amber-700 border-amber-200",
                              PROSPECT: "bg-blue-50 text-blue-700 border-blue-200",
                              UNDERWRITING_READY: "bg-blue-50 text-blue-700 border-blue-200",
                              NOT_INTERESTED: "bg-slate-100 text-slate-600 border-slate-200",
                              POLICYHOLDER: "bg-blue-50 text-blue-700 border-blue-200"
                            };
                            return (
                              <tr
                                key={lead.id}
                                onClick={() => handleCardClick(lead)}
                                className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                              >
                                <td className="px-6 py-4 font-mono text-slate-500 font-medium text-[11px] whitespace-nowrap bg-slate-50 border-r border-slate-100">
                                  {lead.displayId || "-"}
                                </td>
                                <td className="px-6 py-4 font-semibold text-slate-900">{lead.name}</td>
                                <td className="px-6 py-4">
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${typeStyles[lead.type]}`}>
                                    {lead.type}
                                  </span>
                                </td>
                                <td className="px-6 py-4">
                                  {lead.assignedAgentName ? (
                                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-[9px] font-bold text-blue-700 border border-blue-200">
                                        {lead.assignedAgentName.charAt(0).toUpperCase()}
                                      </span>
                                      <span className="font-medium">{lead.assignedAgentName}</span>
                                    </span>
                                  ) : (
                                    <span className="text-xs text-slate-400 italic">Unassigned</span>
                                  )}
                                </td>
                                <td className="px-6 py-4 text-slate-600 text-xs">{lead.contact_info}</td>
                                <td className="px-6 py-4 text-slate-500 font-mono text-xs">{lead.primaryIdentifier || "-"}</td>
                                <td className="px-6 py-4 text-slate-500 text-xs">{new Date(lead.created_at).toLocaleDateString()}</td>
                                <td className="px-6 py-4">
                                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${statusStyles[lead.status]}`}>
                                    {lead.status === "LEAD" ? "Lead" : (lead.status === "NOT_INTERESTED" ? "Dead Lead" : "In Progress")}
                                  </span>
                                </td>
                                <td className="px-4 py-4 text-center">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleOpenEditForm(lead); }}
                                    className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                                    title="View Applicant Form"
                                  >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /><circle cx="5" cy="12" r="1.5" /></svg>
                                  </button>
                                </td>
                                <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center justify-end gap-1.5">
                                    {isDead ? (
                                      <button
                                        disabled={busy}
                                        onClick={() => handleReactivate(lead)}
                                        className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                                      >
                                        Reactivate
                                      </button>
                                    ) : (
                                      <>
                                        {isLead && (
                                          <button
                                            disabled={busy}
                                            onClick={() => handleMoveInProgress(lead)}
                                            className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                                          >
                                            In Progress
                                          </button>
                                        )}
                                        <button
                                          disabled={busy}
                                          onClick={() => handleMarkNotInterested(lead)}
                                          className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors"
                                        >
                                          Not Interested
                                        </button>
                                      </>
                                    )}
                                    <button
                                      disabled={busy}
                                      onClick={() => handleDeleteLead(lead)}
                                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-white border border-red-100 text-red-600 hover:bg-red-50 transition-colors"
                                    >
                                      Delete
                                    </button>
                                  </div>
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
                    Showing <span className="font-semibold text-slate-700">{Math.min(totalItems, (currentPage - 1) * itemsPerPage + 1)}-{Math.min(totalItems, currentPage * itemsPerPage)}</span> of <span className="font-semibold text-slate-700">{totalItems}</span> leads
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      Previous
                    </button>
                    <div className="text-xs font-semibold text-slate-700 px-2">
                      Page {currentPage} of {totalPages}
                    </div>
                    <button
                      onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      Next
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
          onClose={() => setSelectedEntity(null)}
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
          if (chooserType) setActiveAdd({ type: chooserType, mode });
          setChooserType(null);
        }}
      />

      {/* Step 2: the matching entry form — all inline, no navigation */}
      <CustomerQuickLeadModal
        open={activeAdd?.type === "INDIVIDUAL" && activeAdd.mode === "quick"}
        onClose={() => setActiveAdd(null)}
        onSaved={handleAddSaved}
      />
      <CustomerFormModal
        open={activeAdd?.type === "INDIVIDUAL" && activeAdd.mode === "full"}
        mode="create"
        onClose={() => setActiveAdd(null)}
        onSaved={handleAddSaved}
      />
      {editEntityData?.type === "INDIVIDUAL" && (
        <CustomerFormModal
          open={true}
          mode="edit"
          customer={editEntityData.data}
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
  onMarkNotInterested,
  onReactivate,
  onDelete,
}: {
  lead: UnifiedLead;
  onClick: () => void;
  busy: boolean;
  onMoveInProgress: () => void;
  onMarkNotInterested: () => void;
  onReactivate: () => void;
  onDelete: () => void;
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

      <div className="text-xs font-medium flex items-center gap-1.5 mb-2">
        {lead.assignedAgentName ? (
          <>
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-[8px] font-bold text-blue-700 border border-blue-200">
              {lead.assignedAgentName.charAt(0).toUpperCase()}
            </span>
            <span className="text-slate-600 truncate">{lead.assignedAgentName}</span>
          </>
        ) : (
          <span className="text-slate-400 italic">Unassigned</span>
        )}
      </div>

      {lead.primaryIdentifier && (
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          CNIC: {lead.primaryIdentifier}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400">
        <span>Added {new Date(lead.created_at).toLocaleDateString()}</span>
        <span className="text-blue-600 font-semibold group-hover:underline">View Details →</span>
      </div>

      {/* Contextual actions — depend on the lead's current pipeline stage */}
      <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {isDead ? (
          <button disabled={busy} onClick={act(onReactivate)} className={`${btnBase} text-blue-700 bg-blue-50 hover:bg-blue-100`}>
            Reactivate
          </button>
        ) : (
          <>
            {isLead && (
              <button disabled={busy} onClick={act(onMoveInProgress)} className={`${btnBase} text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                In Progress
              </button>
            )}
            <button disabled={busy} onClick={act(onMarkNotInterested)} className={`${btnBase} text-rose-600 bg-rose-50 hover:bg-rose-100`}>
              Not Interested
            </button>
          </>
        )}
        <button disabled={busy} onClick={act(onDelete)} className={`${btnBase} text-red-600 bg-white border border-red-100 hover:bg-red-50 ml-auto`}>
          Delete
        </button>
      </div>
    </div>
  );
}
