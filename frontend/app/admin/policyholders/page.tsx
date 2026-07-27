"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";

import { listBranches, Branch } from "@/app/services/branches";
import { listAcquisitionSources, AcquisitionSource } from "@/app/services/acquisitionSources";
import FiltersPanel from "@/components/FiltersPanel";
import UnifiedDetailsModal from "@/components/UnifiedDetailsModal";

type EntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";

interface UnifiedPolicyholder {
  id: string;
  type: EntityType;
  name: string;
  contact_info: string;
  created_at: string;
  primaryIdentifier?: string; // CNIC or Registration No
  policy_number?: string;
}

type FilterType = "ALL" | "INDIVIDUAL" | "FAMILY" | "CORPORATE";

export default function PolicyholdersPage() {
  const router = useRouter();
  const [policyholders, setPolicyholders] = useState<UnifiedPolicyholder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("ALL");
  const [selectedEntity, setSelectedEntity] = useState<{ id: string, type: EntityType } | null>(null);


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

  useEffect(() => {
    fetchPolicyholders();
  }, [dateFrom, dateTo, cityFilter, provinceFilter, branchFilter, sourceFilter]);

  const fetchPolicyholders = async () => {
    setLoading(true);
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
      const [customersRes, familiesRes, orgsRes] = await Promise.all([
        api.get(`/tenants/${tenantId}/customers`, { params: { category: "active", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/families`, { params: { category: "active", ...structuredParams } }),
        api.get(`/tenants/${tenantId}/organizations`, { params: { category: "active", ...structuredParams } })
      ]);

      const unified: UnifiedPolicyholder[] = [];

      // Process Individual Customers
      const customers = customersRes.data || [];
      customers.forEach((c: any) => {
        unified.push({
          id: c.id,
          type: "INDIVIDUAL",
          name: c.name,
          contact_info: c.details?.phone || "No phone",
          created_at: c.created_at,
          primaryIdentifier: c.cnic,
          policy_number: c.active_policy_number,
        });
      });

      // Process Family Groups
      const families = familiesRes.data || [];
      families.forEach((f: any) => {
        unified.push({
          id: f.id,
          type: "FAMILY",
          name: f.name,
          contact_info: f.contact_phone || f.contact_email || "No contact",
          created_at: f.created_at,
        });
      });

      // Process Organizations
      const orgs = orgsRes.data || [];
      orgs.forEach((o: any) => {
        unified.push({
          id: o.id,
          type: "CORPORATE",
          name: o.name,
          contact_info: o.contact_phone || o.contact_email || "No contact",
          created_at: o.created_at,
          primaryIdentifier: o.registration_number,
        });
      });

      unified.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setPolicyholders(unified);
    } catch (err: any) {
      setError(err.message || "Failed to load policy holders");
    } finally {
      setLoading(false);
    }
  };

  const getFilteredData = () => {
    const q = search.trim().toLowerCase();
    return policyholders.filter(p => {
      if (filterType !== "ALL" && p.type !== filterType) return false;
      if (q) {
        const haystack = `${p.name} ${p.contact_info} ${p.primaryIdentifier ?? ""} ${p.policy_number ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  };

  const getStatsData = () => {
    const q = search.trim().toLowerCase();
    return policyholders.filter(p => {
      if (q) {
        const haystack = `${p.name} ${p.contact_info} ${p.primaryIdentifier ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  };

  const handleRowClick = (item: UnifiedPolicyholder) => {
    setSelectedEntity({ id: item.id, type: item.type });
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  const statsData = getStatsData();
  const filteredPolicyholders = getFilteredData();

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Policy Holders</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Directory of all formal customers with active coverage.
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
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Active</p>
            <div className="text-2xl font-bold text-slate-900">{statsData.length}</div>
          </div>
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-emerald-100 text-emerald-700">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Individuals</p>
            <div className="text-2xl font-bold text-blue-700">{statsData.filter(p => p.type === "INDIVIDUAL").length}</div>
          </div>
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-100 text-blue-700">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Families</p>
            <div className="text-2xl font-bold text-purple-700">{statsData.filter(p => p.type === "FAMILY").length}</div>
          </div>
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-purple-100 text-purple-700">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M12 3l9 7-9 7-9-7 9-7z"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/><path d="M8 15v-2a4 4 0 018 0v2"/></svg>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Corporates</p>
            <div className="text-2xl font-bold text-emerald-700">{statsData.filter(p => p.type === "CORPORATE").length}</div>
          </div>
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-emerald-100 text-emerald-700">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18z"/><path d="M6 12H4a2 2 0 00-2 2v8h4"/><path d="M18 9h2a2 2 0 012 2v11h-4"/></svg>
          </div>
        </div>
      </div>


      {/* Filters, search */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 w-full">
          <div className="inline-flex bg-slate-100/80 p-1 rounded-xl shadow-inner backdrop-blur-md border border-slate-200/60 shrink-0">
            {["ALL", "INDIVIDUAL", "FAMILY", "CORPORATE"].map((ft) => (
                <button
                  key={ft}
                  onClick={() => setFilterType(ft as FilterType)}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${
                    filterType === ft
                      ? "bg-white text-emerald-600 shadow-md ring-1 ring-black/5 scale-[1.02]"
                      : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
                  }`}
                >
                  {ft === "ALL" ? "All" : ft === "INDIVIDUAL" ? "Individuals" : ft === "FAMILY" ? "Families" : "Corporates"}
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
              className="w-full pl-9 pr-8 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-shadow"
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
        </div>

        {activeFilterChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-700 text-xs font-medium"
              >
                {chip.label}
                <button
                  onClick={chip.onRemove}
                  className="w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-emerald-100 text-emerald-400 hover:text-emerald-700"
                >
                  ✕
                </button>
              </span>
            ))}
            <button onClick={clearFilters} className="text-xs font-semibold text-slate-400 hover:text-emerald-600 hover:underline ml-1">
              Clear all
            </button>
          </div>
        )}
      </div>


        {error && (
          <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-xl text-sm font-medium">
            {error}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          {getFilteredData().length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <p>No policy holders found for the selected filter.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500 font-medium">
                  <tr>
                    <th className="px-6 py-4">Name</th>
                    <th className="px-6 py-4">Type</th>
                    <th className="px-6 py-4">Contact</th>
                    <th className="px-6 py-4">CNIC</th>
                    <th className="px-6 py-4">Policy No.</th>
                    <th className="px-6 py-4">Enrolled Date</th>
                    <th className="px-6 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {getFilteredData().map(p => (
                    <tr 
                      key={p.id} 
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                      onClick={() => handleRowClick(p)}
                    >
                      <td className="px-6 py-4 font-semibold text-slate-900">{p.name}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border ${
                          p.type === 'INDIVIDUAL' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                          p.type === 'FAMILY' ? 'bg-purple-50 text-purple-700 border-purple-200' :
                          'bg-emerald-50 text-emerald-700 border-emerald-200'
                        }`}>
                          {p.type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-600">{p.contact_info}</td>
                      <td className="px-6 py-4 text-slate-500 font-mono text-xs">{p.primaryIdentifier || "-"}</td>
                      <td className="px-6 py-4 text-emerald-700 font-mono font-semibold text-xs">{p.policy_number || "-"}</td>
                      <td className="px-6 py-4 text-slate-500">{new Date(p.created_at).toLocaleDateString()}</td>
                      <td className="px-6 py-4 text-right">
                        <button className="text-emerald-600 hover:text-emerald-800 font-semibold text-xs">
                          View Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        
      {selectedEntity && (
        <UnifiedDetailsModal 
          isOpen={true} 
          onClose={() => setSelectedEntity(null)} 
          entityId={selectedEntity.id} 
          entityType={selectedEntity.type} 
          onSaved={fetchPolicyholders}
        />
      )}
    </div>
  );
}
