"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { MetricCard } from "@/components/MetricCard";
import FiltersPanel from "@/components/FiltersPanel";

// ── Types ─────────────────────────────────────────────────────────────────────

type SourceType = "AGENT" | "BROKER" | "BANCASSURANCE" | "CORPORATE_AGENT" | "DIRECT" | "DIGITAL";

interface AcquisitionSource {
  id: string;
  tenant_id: string;
  source_type: SourceType;
  name: string;
  code: string;
  partner_name?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  city?: string | null;
  cnic?: string | null;
  location?: string | null;
  is_active: boolean;
  created_at: string;
  customer_count: number;
}

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Direct",
  DIGITAL: "Digital",
};

const SOURCE_TYPE_STYLE: Record<SourceType, string> = {
  AGENT: "bg-blue-50 text-blue-700 border-blue-100",
  BROKER: "bg-violet-50 text-violet-700 border-violet-100",
  BANCASSURANCE: "bg-emerald-50 text-emerald-700 border-emerald-100",
  CORPORATE_AGENT: "bg-amber-50 text-amber-700 border-amber-100",
  DIRECT: "bg-slate-100 text-slate-600 border-slate-200",
  DIGITAL: "bg-rose-50 text-rose-700 border-rose-100",
};

const SOURCE_TYPES: SourceType[] = ["AGENT", "BROKER", "BANCASSURANCE", "CORPORATE_AGENT", "DIRECT", "DIGITAL"];

const EMPTY_FORM = {
  source_type: "AGENT" as SourceType,
  name: "",
  code: "",
  partner_name: "",
  contact_person: "",
  contact_phone: "",
  contact_email: "",
  city: "",
  cnic: "",
  location: "",
  is_active: true,
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AcquisitionSourcesPage() {
  const [sources, setSources] = useState<AcquisitionSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  
  // Controls
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
  const [filterType, setFilterType] = useState<SourceType | "ALL">("ALL");
  const [filterStatus, setFilterStatus] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchSources();
  }, []);

  const fetchSources = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const resp = await api.get<AcquisitionSource[]>(`/tenants/${tenantId}/acquisition-sources`);
      setSources(resp.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to load acquisition sources.");
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setError("");
    setSuccess("");
    setShowModal(true);
  };

  const openEdit = (s: AcquisitionSource) => {
    setEditingId(s.id);
    setForm({
      source_type: s.source_type,
      name: s.name,
      code: s.code,
      partner_name: s.partner_name ?? "",
      contact_person: s.contact_person ?? "",
      contact_phone: s.contact_phone ?? "",
      contact_email: s.contact_email ?? "",
      city: s.city ?? "",
      cnic: s.cnic ?? "",
      location: s.location ?? "",
      is_active: s.is_active,
    });
    setError("");
    setSuccess("");
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.code.trim()) {
      setError("Name and Code are required.");
      return;
    }
    setSaving(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active tenant found.");
      setSaving(false);
      return;
    }
    // Send null for optional blanks rather than empty strings.
    const payload = {
      source_type: form.source_type,
      name: form.name.trim(),
      code: form.code.trim(),
      partner_name: form.partner_name.trim() || null,
      contact_person: form.contact_person.trim() || null,
      contact_email: form.contact_email.trim() || null,
      city: form.city.trim() || null,
      cnic: form.cnic.trim() || null,
      location: form.location.trim() || null,
      is_active: form.is_active,
    };
    try {
      if (editingId) {
        await api.put(`/tenants/${tenantId}/acquisition-sources/${editingId}`, payload);
        setSuccess("Acquisition source updated.");
      } else {
        await api.post(`/tenants/${tenantId}/acquisition-sources`, payload);
        setSuccess("Acquisition source created.");
      }
      setShowModal(false);
      fetchSources();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to save acquisition source.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: AcquisitionSource) => {
    if (!confirm(`Delete acquisition source "${s.name}"?`)) return;
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/acquisition-sources/${s.id}`);
      setSuccess(`"${s.name}" deleted.`);
      fetchSources();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete acquisition source.");
    }
  };

  const clearFilters = () => {
    setFilterType("ALL");
    setFilterStatus("ALL");
  };

  const structuredFilterCount = [filterType !== "ALL", filterStatus !== "ALL"].filter(Boolean).length;

  const activeFilterChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (filterType !== "ALL") {
    activeFilterChips.push({ key: "type", label: SOURCE_TYPE_LABELS[filterType as SourceType], onRemove: () => setFilterType("ALL") });
  }
  if (filterStatus !== "ALL") {
    activeFilterChips.push({ key: "status", label: filterStatus === "ACTIVE" ? "Active Only" : "Inactive Only", onRemove: () => setFilterStatus("ALL") });
  }

  const filtered = sources.filter((s) => {
    if (filterType !== "ALL" && s.source_type !== filterType) return false;
    if (filterStatus === "ACTIVE" && !s.is_active) return false;
    if (filterStatus === "INACTIVE" && s.is_active) return false;

    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      (s.partner_name ?? "").toLowerCase().includes(q) ||
      SOURCE_TYPE_LABELS[s.source_type].toLowerCase().includes(q)
    );
  });

  const activeSources = sources.filter(s => s.is_active);
  const totalCustomers = sources.reduce((sum, s) => sum + s.customer_count, 0);
  const topChannel = sources.length > 0 ? [...sources].sort((a, b) => b.customer_count - a.customer_count)[0] : null;

  if (!authorized) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] font-sans">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-8 text-center space-y-4">
          <div className="text-red-500 font-bold">Unauthorized Access</div>
          <p className="text-slate-400 text-sm">Administrative privileges required.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Acquisition Sources</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage agents, brokers, banks, and other origination channels.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl hover:from-emerald-700 hover:to-teal-700 transition-all shadow-sm active:scale-95 self-start"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Source
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Sources"
          value={loading ? "—" : sources.length}
          accent="slate"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>}
        />
        <MetricCard
          title="Active Channels"
          value={loading ? "—" : activeSources.length}
          accent="emerald"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
        />
        <MetricCard
          title="Total Customers Sourced"
          value={loading ? "—" : totalCustomers}
          accent="blue"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>}
        />
        <MetricCard
          title="Top Channel"
          value={loading ? "—" : (topChannel?.name ?? "None")}
          subtitle={loading ? "" : topChannel ? `${topChannel.customer_count} customers` : ""}
          accent="amber"
          icon={<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>}
        />
      </div>

      {/* Control Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="flex-1 w-full relative group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-emerald-500 transition-colors" ><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            placeholder="Search by name, code, partner, or type…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 bg-white shadow-sm transition-all"
          />
        </div>
        
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto pb-2 sm:pb-0">
          <FiltersPanel
            typeFilter={filterType}
            onTypeChange={setFilterType}
            typeOptions={[
              ...SOURCE_TYPES.map(t => ({ value: t, label: SOURCE_TYPE_LABELS[t] }))
            ]}
            statusFilter={filterStatus}
            onStatusChange={setFilterStatus}
            statusOptions={[
              { value: "ACTIVE", label: "Active Only" },
              { value: "INACTIVE", label: "Inactive Only" }
            ]}
            activeCount={structuredFilterCount}
            onClearAll={clearFilters}
          />

          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/80 ml-auto sm:ml-1 h-[42px] items-center shadow-sm">
            <button
              onClick={() => setViewMode("list")}
              className={`p-1.5 rounded text-slate-600 transition-all ${viewMode === "list" ? "bg-white shadow text-emerald-600" : "hover:text-slate-900"}`}
              title="List View"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
            <button
              onClick={() => setViewMode("kanban")}
              className={`p-1.5 rounded text-slate-600 transition-all ${viewMode === "kanban" ? "bg-white shadow text-blue-600" : "hover:text-slate-900"}`}
              title="Kanban Board"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="13" rx="1"/></svg>
            </button>
          </div>
        </div>
      </div>

      {activeFilterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-2">
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

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-2 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
          <span className="text-xs text-slate-400">Loading sources…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center text-slate-400 bg-white rounded-xl border border-slate-200 shadow-sm">
          <p className="text-sm">{sources.length === 0 ? "No acquisition sources yet." : "No sources match your search and filters."}</p>
        </div>
      ) : viewMode === "kanban" ? (
        <div className="flex gap-6 overflow-x-auto pb-6 pt-2 px-2 snap-x snap-mandatory min-h-[60vh] w-full hide-scrollbar">
          {SOURCE_TYPES.map(type => {
            const colSources = filtered.filter(s => s.source_type === type);
            if (colSources.length === 0) return null;
            
            return (
              <div key={type} className="flex-shrink-0 w-80 flex flex-col snap-start">
                <div className="flex items-center justify-between mb-4 px-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${SOURCE_TYPE_STYLE[type].split(' ')[0]}`} />
                    <h3 className="text-sm font-bold text-slate-800 tracking-wide uppercase">{SOURCE_TYPE_LABELS[type]}</h3>
                  </div>
                  <span className="px-2.5 py-0.5 bg-white border border-slate-200 text-slate-600 text-xs font-bold rounded-full shadow-sm">{colSources.length}</span>
                </div>
                
                <div className="flex flex-col gap-4">
                  {colSources.map(s => (
                    <div key={s.id} className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm hover:shadow-xl hover:-translate-y-1 hover:border-blue-200/50 transition-all duration-300 group relative cursor-pointer flex flex-col h-full" onClick={() => openEdit(s)}>
                      <div className="flex justify-between items-start mb-3">
                        <div className="pr-4">
                          <p className="font-bold text-slate-900 text-sm leading-tight group-hover:text-blue-700 transition-colors">{s.name}</p>
                          <p className="font-mono text-[10px] font-semibold text-slate-500 mt-1 bg-slate-50 inline-block px-1.5 py-0.5 rounded">{s.code}</p>
                        </div>
                        <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${s.is_active ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" : "bg-slate-300"}`} title={s.is_active ? "Active" : "Inactive"} />
                      </div>
                      
                      <div className="space-y-2 mb-4 text-xs mt-auto">
                        {s.partner_name && (
                          <div className="flex items-center gap-2 text-slate-600 bg-slate-50/50 p-1.5 rounded-lg border border-slate-100">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-blue-500"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                            <span className="truncate font-medium">{s.partner_name}</span>
                          </div>
                        )}
                        {(s.contact_person || s.contact_phone) && (
                          <div className="flex items-center gap-2 text-slate-600 px-1.5">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-slate-400"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                            <span className="truncate">{s.contact_person || s.contact_phone}</span>
                          </div>
                        )}
                        {s.city && (
                          <div className="flex items-center gap-2 text-slate-600 px-1.5">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-slate-400"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                            <span className="truncate">{s.city}</span>
                          </div>
                        )}
                      </div>
                      
                      <div className="pt-3 border-t border-slate-100/80 flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Customers</span>
                        <div className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-100/50 px-2.5 py-1 rounded-lg">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3 text-emerald-600"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                          <span className="font-bold text-emerald-700 text-xs">{s.customer_count}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* List View */
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden w-full relative">
          <div className="overflow-x-auto w-full">
            <table className="w-full text-sm min-w-[1000px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  <th className="px-5 py-4 text-left">Name</th>
                  <th className="px-5 py-4 text-left">Type</th>
                  <th className="px-5 py-4 text-left">Code</th>
                  <th className="px-5 py-4 text-left">Partner</th>
                  <th className="px-5 py-4 text-left">Contact</th>
                  <th className="px-5 py-4 text-left">City</th>
                  <th className="px-5 py-4 text-right">Customers</th>
                  <th className="px-5 py-4 text-center">Status</th>
                  <th className="px-5 py-4 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100/80">
                {filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-blue-50/30 transition-colors group">
                    <td className="px-5 py-4">
                      <p className="font-bold text-slate-800">{s.name}</p>
                    </td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold border ${SOURCE_TYPE_STYLE[s.source_type]}`}>
                        {SOURCE_TYPE_LABELS[s.source_type]}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="font-mono text-[11px] font-semibold text-slate-600 bg-slate-100/80 border border-slate-200/60 rounded px-2 py-1 inline-block">{s.code}</span>
                    </td>
                    <td className="px-5 py-4 text-slate-600 font-medium">
                      {s.partner_name ? (
                        <div className="flex items-center gap-1.5">
                          <div className="w-6 h-6 rounded bg-slate-100 border border-slate-200 flex items-center justify-center flex-shrink-0 text-slate-400">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                          </div>
                          <span className="truncate max-w-[120px]">{s.partner_name}</span>
                        </div>
                      ) : (
                        <span className="text-slate-300 font-normal">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-slate-600">
                      {s.contact_person || s.contact_phone || s.contact_email ? (
                        <div className="flex flex-col leading-tight gap-1">
                          {s.contact_person && <span className="text-xs font-semibold text-slate-700">{s.contact_person}</span>}
                          {s.contact_phone && <span className="text-[11px] text-slate-500 font-medium">{s.contact_phone}</span>}
                          {s.contact_email && <span className="text-[11px] text-slate-500 font-medium">{s.contact_email}</span>}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-slate-600 text-xs font-medium">
                      {s.city ? (
                         <div className="flex items-center gap-1">
                           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-slate-400"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                           {s.city}
                         </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right font-bold text-slate-800 text-sm">
                      {s.customer_count > 0 ? (
                        <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md inline-block">{s.customer_count}</span>
                      ) : (
                        <span className="text-slate-400">{s.customer_count}</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-center">
                      <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold ${s.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>
                        {s.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-center whitespace-nowrap">
                      <div className="inline-flex rounded-lg shadow-sm border border-slate-200 overflow-hidden divide-x divide-slate-200 opacity-30 group-hover:opacity-100 transition-opacity focus-within:opacity-100">
                        <button
                          onClick={() => openEdit(s)}
                          className="px-3 py-1.5 text-xs font-bold text-blue-600 bg-white hover:bg-blue-50 transition-colors flex items-center gap-1"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(s)}
                          className="px-3 py-1.5 text-xs font-bold text-red-600 bg-white hover:bg-red-50 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h3 className="text-base font-bold text-slate-900">{editingId ? "Edit Acquisition Source" : "Add Acquisition Source"}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 bg-white hover:bg-slate-100 rounded-full p-1.5 transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm font-semibold text-red-600">{error}</div>}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Type *</label>
                  <select
                    value={form.source_type}
                    onChange={(e) => setForm((f) => ({ ...f, source_type: e.target.value as SourceType }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  >
                    {SOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>{SOURCE_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Producer Code *</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                    placeholder="e.g. AGT-0417"
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Agent name or firm / bank name"
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Partner (bank / firm)</label>
                  <input
                    type="text"
                    value={form.partner_name}
                    onChange={(e) => setForm((f) => ({ ...f, partner_name: e.target.value }))}
                    placeholder="e.g. Habib Bank Limited"
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Contact Person</label>
                  <input
                    type="text"
                    value={form.contact_person}
                    onChange={(e) => setForm((f) => ({ ...f, contact_person: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">City</label>
                  <input
                    type="text"
                    value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Location</label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">CNIC</label>
                  <input
                    type="text"
                    value={form.cnic}
                    onChange={(e) => setForm((f) => ({ ...f, cnic: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Contact Phone</label>
                  <input
                    type="text"
                    value={form.contact_phone}
                    onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Contact Email</label>
                  <input
                    type="email"
                    value={form.contact_email}
                    onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="flex items-center gap-2 md:col-span-2 pt-2 bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                  <input
                    id="is_active"
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                  />
                  <label htmlFor="is_active" className="text-sm font-bold text-slate-800 cursor-pointer select-none">Channel is Active</label>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                disabled={saving}
                className="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200 shadow-sm hover:bg-slate-50 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl shadow-sm hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50 transition-all active:scale-95"
              >
                {saving && <span className="animate-spin h-4 w-4 rounded-full border-2 border-white/30 border-t-white" />}
                {saving ? "Saving…" : editingId ? "Save Changes" : "Create Source"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
