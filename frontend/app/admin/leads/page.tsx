"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import api from "@/app/services/api";
import UnifiedDetailsModal from "@/components/UnifiedDetailsModal";
import AddEntryChooser, { EntryEntityType } from "@/components/entities/AddEntryChooser";
import CustomerFormModal from "@/components/entities/CustomerFormModal";
import CustomerQuickLeadModal from "@/components/entities/CustomerQuickLeadModal";
import FamilyFormModal from "@/components/entities/FamilyFormModal";
import OrganizationFormModal from "@/components/entities/OrganizationFormModal";

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
}

type FilterType = "ALL" | "INDIVIDUAL" | "FAMILY" | "CORPORATE";

export default function LeadsHubPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cnicQuery = searchParams.get("cnic");
  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("ALL");
  const [selectedEntity, setSelectedEntity] = useState<{ id: string, type: EntityType } | null>(null);

  // Inline "Add" flows — replaces navigation to separate customer/family/organization pages.
  const [chooserType, setChooserType] = useState<EntryEntityType | null>(null);
  const [activeAdd, setActiveAdd] = useState<{ type: EntryEntityType; mode: "quick" | "full" } | null>(null);
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
    fetchLeads();
  }, []);

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

  const fetchLeads = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    
    if (!tenantId) {
      setError("No active tenant found.");
      setLoading(false);
      return;
    }

    try {
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
        api.get(`/tenants/${tenantId}/customers?category=full_details`),
        api.get(`/tenants/${tenantId}/customers?category=quick_lead`),
        api.get(`/tenants/${tenantId}/customers?category=not_interested`),
        api.get(`/tenants/${tenantId}/families?category=in_progress`),
        api.get(`/tenants/${tenantId}/families?category=new`),
        api.get(`/tenants/${tenantId}/organizations?category=in_progress`),
        api.get(`/tenants/${tenantId}/organizations?category=new`)
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
          });
        }
      });

      // Sort by newest first
      unified.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setLeads(unified);
    } catch (err: any) {
      setError(err.message || "Failed to load leads");
    } finally {
      setLoading(false);
    }
  };

  const getFilteredLeads = () => {
    return leads.filter(l => filterType === "ALL" || l.type === filterType);
  };

  const leadsByColumn = {
    lead: getFilteredLeads().filter(l => l.status === "LEAD"),
    in_progress: getFilteredLeads().filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY"),
    dead_leads: getFilteredLeads().filter(l => l.status === "NOT_INTERESTED"),
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
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Leads Hub</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Manage and track your prospects across all segments.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start">
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
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm hover:shadow active:scale-95"
            >
              + Add Individual
            </button>
            <button
              onClick={() => setChooserType("FAMILY")}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-all shadow-sm hover:shadow active:scale-95"
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
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Leads</p>
              <div className="text-2xl font-bold text-slate-900">{leads.length}</div>
            </div>
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-slate-100 text-slate-700">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Individuals</p>
              <div className="text-2xl font-bold text-blue-700">{leads.filter(l => l.type === "INDIVIDUAL").length}</div>
            </div>
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-100 text-blue-700">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Families</p>
              <div className="text-2xl font-bold text-purple-700">{leads.filter(l => l.type === "FAMILY").length}</div>
            </div>
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-purple-100 text-purple-700">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 3l9 7-9 7-9-7 9-7z"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/><path d="M8 15v-2a4 4 0 018 0v2"/></svg>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Corporates</p>
              <div className="text-2xl font-bold text-emerald-700">{leads.filter(l => l.type === "CORPORATE").length}</div>
            </div>
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-emerald-100 text-emerald-700">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18z"/><path d="M6 12H4a2 2 0 00-2 2v8h4"/><path d="M18 9h2a2 2 0 012 2v11h-4"/></svg>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center">
        <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner backdrop-blur-md border border-slate-200/60">
          {["ALL", "INDIVIDUAL", "FAMILY", "CORPORATE"].map((ft) => (
              <button
                key={ft}
                onClick={() => setFilterType(ft as FilterType)}
                className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${
                  filterType === ft
                    ? "bg-white text-indigo-600 shadow-md ring-1 ring-black/5 scale-[1.02]"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
                }`}
              >
                {ft === "ALL" ? "All" : ft === "INDIVIDUAL" ? "Individuals" : ft === "FAMILY" ? "Families" : "Corporates"}
              </button>
            ))}
          </div>
        </div>

        {notice && (
          <div className="p-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl text-sm font-medium flex justify-between items-center">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} className="text-emerald-400 hover:text-emerald-700 font-bold ml-3">✕</button>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-xl text-sm font-medium">
            {error}
          </div>
        )}

        {/* Kanban Board */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* LEAD COLUMN */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-amber-300">
              <h3 className="font-bold text-slate-700 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                Leads
              </h3>
              <span className="bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full">{leadsByColumn.lead.length}</span>
            </div>
            {leadsByColumn.lead.map(lead => (
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
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-indigo-400">
              <h3 className="font-bold text-slate-700 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
                In Progress
              </h3>
              <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full">{leadsByColumn.in_progress.length}</span>
            </div>
            {leadsByColumn.in_progress.map(lead => (
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
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-slate-300">
              <h3 className="font-bold text-slate-700 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
                Dead Leads
              </h3>
              <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">{leadsByColumn.dead_leads.length}</span>
            </div>
            {leadsByColumn.dead_leads.map(lead => (
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
      

      {selectedEntity && (
        <UnifiedDetailsModal
          isOpen={true}
          onClose={() => setSelectedEntity(null)}
          entityId={selectedEntity.id}
          entityType={selectedEntity.type}
          onSaved={fetchLeads}
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
      <FamilyFormModal
        open={activeAdd?.type === "FAMILY"}
        mode={activeAdd?.type === "FAMILY" ? activeAdd.mode : "quick"}
        onClose={() => setActiveAdd(null)}
        onSaved={handleAddSaved}
      />
      <OrganizationFormModal
        open={activeAdd?.type === "CORPORATE"}
        mode={activeAdd?.type === "CORPORATE" ? activeAdd.mode : "quick"}
        onClose={() => setActiveAdd(null)}
        onSaved={handleAddSaved}
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
    FAMILY: "bg-purple-50 text-purple-700 border-purple-200",
    CORPORATE: "bg-emerald-50 text-emerald-700 border-emerald-200"
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
      className="group relative bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-indigo-300 hover:-translate-y-1 transition-all duration-300 cursor-pointer overflow-hidden"
    >
      <div className="absolute top-0 left-0 w-1 h-full bg-slate-200 group-hover:bg-indigo-500 transition-colors"></div>

      <div className="flex justify-between items-start mb-2">
        <h4 className="font-bold text-slate-800 text-sm truncate pr-2">{lead.name}</h4>
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

      {lead.primaryIdentifier && (
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          ID: {lead.primaryIdentifier}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400">
        <span>Added {new Date(lead.created_at).toLocaleDateString()}</span>
        <span className="text-indigo-600 font-semibold group-hover:underline">View Details →</span>
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
              <button disabled={busy} onClick={act(onMoveInProgress)} className={`${btnBase} text-indigo-700 bg-indigo-50 hover:bg-indigo-100`}>
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
