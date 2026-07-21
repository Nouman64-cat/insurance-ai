"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import api from "@/app/services/api";
import UnifiedDetailsModal from "@/components/UnifiedDetailsModal";

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

  useEffect(() => {
    fetchLeads();
  }, []);

  useEffect(() => {
    if (cnicQuery && leads.length > 0) {
      const match = leads.find(l => l.primaryIdentifier === cnicQuery);
      if (match) setSelectedEntity({ id: match.id, type: match.type });
    }
  }, [cnicQuery, leads]);

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
      // Parallel fetch to gather all entity types
      const [customersRes, familiesRes, orgsRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/customers`),
        api.get(`/tenants/${tenantId}/families`),
        api.get(`/tenants/${tenantId}/organizations`)
      ]);

      const unified: UnifiedLead[] = [];

      // Process Individual Customers
      const customers = customersRes.data || [];
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
      const families = familiesRes.data || [];
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
      const orgs = orgsRes.data || [];
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
    complete_info: getFilteredLeads().filter(l => l.status === "PROSPECT" || l.status === "UNDERWRITING_READY"),
    not_interested: getFilteredLeads().filter(l => l.status === "NOT_INTERESTED"),
  };

  const handleCardClick = (lead: UnifiedLead) => {
    setSelectedEntity({ id: lead.id, type: lead.type });
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
              onClick={() => router.push("/admin/customers")}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm hover:shadow active:scale-95"
            >
              + Add Individual
            </button>
            <button
              onClick={() => router.push("/admin/families")}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-all shadow-sm hover:shadow active:scale-95"
            >
              + Add Family
            </button>
            <button
              onClick={() => router.push("/admin/organizations")}
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
            {leadsByColumn.lead.map(lead => <LeadCard key={lead.id} lead={lead} onClick={() => handleCardClick(lead)} />)}
          </div>

          {/* COMPLETE INFO COLUMN */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-indigo-400">
              <h3 className="font-bold text-slate-700 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
                Complete Info
              </h3>
              <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full">{leadsByColumn.complete_info.length}</span>
            </div>
            {leadsByColumn.complete_info.map(lead => <LeadCard key={lead.id} lead={lead} onClick={() => handleCardClick(lead)} />)}
          </div>

          {/* NOT INTERESTED COLUMN */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-2 pb-1 border-b-2 border-slate-300">
              <h3 className="font-bold text-slate-700 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
                Not Interested
              </h3>
              <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">{leadsByColumn.not_interested.length}</span>
            </div>
            {leadsByColumn.not_interested.map(lead => <LeadCard key={lead.id} lead={lead} onClick={() => handleCardClick(lead)} />)}
          </div>
        </div>
      

      {selectedEntity && (
        <UnifiedDetailsModal 
          isOpen={true} 
          onClose={() => setSelectedEntity(null)} 
          entityId={selectedEntity.id} 
          entityType={selectedEntity.type} 
        />
      )}
    </div>
  );
}

function LeadCard({ lead, onClick }: { lead: UnifiedLead, onClick: () => void }) {
  const typeStyles = {
    INDIVIDUAL: "bg-blue-50 text-blue-700 border-blue-200",
    FAMILY: "bg-purple-50 text-purple-700 border-purple-200",
    CORPORATE: "bg-emerald-50 text-emerald-700 border-emerald-200"
  };

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
    </div>
  );
}
