"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { useCaseEvents } from "@/lib/agent/useCaseEvents";
import RowActionsMenu, { type RowAction } from "@/components/RowActionsMenu";
import { formatCnic } from "@/lib/cnic";
import { Pagination, usePagination } from "@/components/Pagination";
import DemoFillButton from "@/components/DemoFillButton";
import { demoAcquisitionSource } from "@/lib/demoData";
import { tx } from "@/lib/i18n/tx";

// ── Types ─────────────────────────────────────────────────────────────────────

type SourceType = "AGENT" | "BROKER" | "BANCASSURANCE" | "CORPORATE_AGENT" | "DIRECT" | "DIGITAL";

interface AcquisitionSource {
  id: string;
  tenant_id: string;
  source_type: SourceType;
  source_type_code?: number;
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
  // Login issued to this source's contact email: "invited" until they sign in
  // with the emailed credentials, then "active" (and listed in User Management).
  login_status?: "invited" | "active" | null;
  // The role that login holds — it follows the source type (Broker → "Broker").
  login_role?: string | null;
  // Only on the create / resend responses.
  credentials_email_sent?: boolean | null;
}

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Walk-in",
  DIGITAL: "Digital",
};

// One hue per type, so a mixed list reads at a glance (badge = ring style, as on Leads).
const SOURCE_TYPE_STYLE: Record<SourceType, string> = {
  AGENT: "bg-blue-50 text-blue-700 ring-blue-600/15",
  BROKER: "bg-violet-50 text-violet-700 ring-violet-600/15",
  BANCASSURANCE: "bg-teal-50 text-teal-700 ring-teal-600/15",
  CORPORATE_AGENT: "bg-amber-50 text-amber-800 ring-amber-600/20",
  DIRECT: "bg-slate-50 text-slate-600 ring-slate-500/15",
  DIGITAL: "bg-rose-50 text-rose-700 ring-rose-600/15",
};

const SOURCE_TYPE_DOT: Record<SourceType, string> = {
  AGENT: "bg-blue-500",
  BROKER: "bg-violet-500",
  BANCASSURANCE: "bg-teal-500",
  CORPORATE_AGENT: "bg-amber-500",
  DIRECT: "bg-slate-400",
  DIGITAL: "bg-rose-500",
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "?";

const SOURCE_TYPES: SourceType[] = ["AGENT", "BROKER", "BANCASSURANCE", "CORPORATE_AGENT", "DIRECT", "DIGITAL"];

// Numeric value of each type, 1 to 6. Mirrors AcquisitionSourceType.number on the backend
// (shared/models/core.py); the API also returns it as `source_type_code`.
const SOURCE_TYPE_NUMBER: Record<SourceType, number> = {
  AGENT: 1,
  BROKER: 2,
  BANCASSURANCE: 3,
  CORPORATE_AGENT: 4,
  DIRECT: 5,
  DIGITAL: 6,
};

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

  const fetchSources = async (silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError(tx("No active organization tenant found."));
      setLoading(false);
      return;
    }
    try {
      const resp = await api.get<AcquisitionSource[]>(`/tenants/${tenantId}/acquisition-sources`);
      setSources(resp.data);
    } catch (err: any) {
      if (!silent) setError(err.response?.data?.detail ?? err.message ?? tx("Failed to load acquisition sources."));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Live: a source signing in for the first time (invited -> active), or any change to the roster made
  // elsewhere, re-reads the list in place, without the spinner and without a page refresh. A reconnect
  // and the tab coming back into view re-read too, in case events were missed meanwhile.
  useCaseEvents(
    (evt) => {
      const resource = evt.event_type === "DataChanged" ? (evt.detail?.resource as string | undefined) : undefined;
      if (resource === "acquisition-sources" || resource === "users") fetchSources(true);
    },
    authorized,
    () => fetchSources(true),
  );

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
      setError(tx("Name and Code are required."));
      return;
    }
    setSaving(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError(tx("No active tenant found."));
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
      contact_phone: form.contact_phone.trim() || null,
      contact_email: form.contact_email.trim() || null,
      city: form.city.trim() || null,
      cnic: form.cnic.trim() || null,
      location: form.location.trim() || null,
      is_active: form.is_active,
    };
    try {
      if (editingId) {
        await api.put(`/tenants/${tenantId}/acquisition-sources/${editingId}`, payload);
        setSuccess(tx("Acquisition source updated."));
      } else {
        const res = await api.post<AcquisitionSource>(`/tenants/${tenantId}/acquisition-sources`, payload);
        if (!payload.contact_email) {
          setSuccess(tx("Acquisition source created."));
        } else if (res.data.credentials_email_sent) {
          setSuccess(
            tx("Acquisition source created. Login credentials were emailed to {0}{1} — they'll appear in User Management once they sign in.", { 0: payload.contact_email, 1: res.data.login_role ? ` (role: ${res.data.login_role})` : "" })
          );
        } else {
          // The account exists but the email didn't go out (mail not configured or
          // rejected) — the password was never shown, so say how to get it sent.
          setSuccess(
            tx("Acquisition source created, but the credentials email to {0} could not be sent. Use \"Resend login\" on the row to try again.", { 0: payload.contact_email })
          );
        }
      }
      setShowModal(false);
      fetchSources();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to save acquisition source."));
    } finally {
      setSaving(false);
    }
  };

  const [resendingId, setResendingId] = useState<string | null>(null);
  const handleResend = async (s: AcquisitionSource) => {
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setResendingId(s.id);
    try {
      const res = await api.post<AcquisitionSource>(`/tenants/${tenantId}/acquisition-sources/${s.id}/send-credentials`);
      if (res.data.credentials_email_sent) {
        setSuccess(tx("New login credentials were emailed to {0}.", { 0: s.contact_email }));
      } else {
        setError(tx("A new password was issued for {0}, but the email could not be sent. Check the email settings and try again.", { 0: s.contact_email }));
      }
      fetchSources();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to resend credentials."));
    } finally {
      setResendingId(null);
    }
  };

  const handleDelete = async (s: AcquisitionSource) => {
    const loginNote = s.login_status
      ? `\n\nIts login (${s.contact_email}) will also be removed from User Management and can no longer sign in.`
      : "";
    if (!confirm(tx("Delete acquisition source \"{0}\"?{1}", { 0: s.name, 1: loginNote }))) return;
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/acquisition-sources/${s.id}`);
      setSuccess(tx("\"{0}\" deleted{1}", { 0: s.name, 1: s.login_status ? " along with its login." : "." }));
      fetchSources();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to delete acquisition source."));
    }
  };

  // Status tab + search, before the type pill — so each type pill can show how many it would leave.
  const statusScoped = sources.filter((s) => {
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
  const filtered = statusScoped.filter((s) => filterType === "ALL" || s.source_type === filterType);

  const activeSources = sources.filter(s => s.is_active);
  const totalCustomers = sources.reduce((sum, s) => sum + s.customer_count, 0);
  const topChannel = sources.length > 0 ? [...sources].sort((a, b) => b.customer_count - a.customer_count)[0] : null;

  const { pageItems: pagedSources, pagination } = usePagination(filtered);

  if (!authorized) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] font-sans">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-8 text-center space-y-4">
          <div className="text-red-500 font-bold">{tx("Unauthorized Access")}</div>
          <p className="text-slate-400 text-sm">{tx("Administrative privileges required.")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-4 max-w-screen-2xl mx-auto w-full font-sans">
      {/* Header — same shape as the Leads page */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Acquisition Sources")}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {tx("Manage agents, brokers, banks, and other origination channels.")}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 self-start px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow active:scale-95"
        >
          {tx("+ Add Source")}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-600 font-medium">{success}</div>}

      <div className="flex flex-col gap-3">
        {/* Toolbar: status tabs with counts, search, view toggle — every control 42px tall */}
        <div className="flex flex-wrap items-center gap-3 w-full">
          <div className="inline-flex h-[42px] items-stretch bg-white p-1 rounded-xl shadow-sm border border-slate-200 shrink-0">
            {([["ALL", "All", sources.length], ["ACTIVE", "Active", activeSources.length], ["INACTIVE", "Inactive", sources.length - activeSources.length]] as ["ALL" | "ACTIVE" | "INACTIVE", string, number][]).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilterStatus(value)}
                className={`inline-flex items-center gap-2 px-3.5 rounded-lg text-sm font-semibold transition-colors ${filterStatus === value
                  ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  }`}
              >
                {tx(label)}
                <span className={`min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${filterStatus === value ? "bg-white text-blue-700 ring-1 ring-inset ring-blue-100" : "bg-slate-100 text-slate-500"}`}>
                  {loading ? "—" : count}
                </span>
              </button>
            ))}
          </div>

          <div className="relative w-full max-w-[320px] shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              placeholder={tx("Search by name, code, partner, or type…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-[42px] pl-9 pr-8 text-sm border border-slate-200 rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-shadow"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                ✕
              </button>
            )}
          </div>

          <div className="ml-auto shrink-0 inline-flex h-[42px] items-stretch bg-white p-1 rounded-xl shadow-sm border border-slate-200">
            <button
              onClick={() => setViewMode("kanban")}
              className={`px-2 rounded-lg transition-all ${viewMode === "kanban" ? "bg-blue-50 text-blue-600" : "text-slate-500 hover:text-slate-700"}`}
              title={tx("Kanban Board")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="13" rx="1"/></svg>
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`px-2 rounded-lg transition-all ${viewMode === "list" ? "bg-blue-50 text-blue-600" : "text-slate-500 hover:text-slate-700"}`}
              title={tx("List View")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
          </div>
        </div>

        {/* Source type: quiet pills, the selected one dark, empty types dimmed; the old KPI cards as one line on the right */}
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={tx("Source type")}>
          {(["ALL", ...SOURCE_TYPES] as (SourceType | "ALL")[]).map((t) => {
            const on = filterType === t;
            const count = statusScoped.filter((s) => t === "ALL" || s.source_type === t).length;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilterType(t)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  on ? "bg-slate-900 text-white" : count === 0 ? "text-slate-400 hover:bg-slate-100" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {t !== "ALL" && <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-white" : count === 0 ? "bg-slate-300" : SOURCE_TYPE_DOT[t]}`} />}
                {t === "ALL" ? tx("All types") : tx(SOURCE_TYPE_LABELS[t])}
                <span className={`tabular-nums ${on ? "text-slate-300" : "text-slate-400"}`}>{loading ? "—" : count}</span>
              </button>
            );
          })}
          {!loading && sources.length > 0 && (
            <div className="ml-auto flex items-center gap-4 text-xs text-slate-500">
              <span className="whitespace-nowrap">{tx("Customers sourced")} <span className="font-semibold text-slate-800 tabular-nums">{totalCustomers}</span></span>
              {topChannel && topChannel.customer_count > 0 && (
                <span className="whitespace-nowrap">{tx("Top channel")} <span className="font-semibold text-slate-800">{topChannel.name}</span> <span className="tabular-nums">({topChannel.customer_count})</span></span>
              )}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-2 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
          <span className="text-xs text-slate-400">{tx("Loading sources…")}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center text-slate-400 bg-white rounded-xl border border-slate-200 shadow-sm">
          <p className="text-sm">{sources.length === 0 ? tx("No acquisition sources yet.") : tx("No sources match your search and filters.")}</p>
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
                    <span className={`w-2.5 h-2.5 rounded-full ${SOURCE_TYPE_DOT[type]}`} />
                    <span className="text-xs font-bold tabular-nums text-slate-400">{SOURCE_TYPE_NUMBER[type]}</span>
                    <h3 className="text-sm font-bold text-slate-800 tracking-wide uppercase">{tx(SOURCE_TYPE_LABELS[type])}</h3>
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
                        <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${s.is_active ? "bg-blue-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" : "bg-slate-300"}`} title={s.is_active ? tx("Active") : tx("Inactive")} />
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
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{tx("Customers")}</span>
                        <div className="flex items-center gap-1.5 bg-gradient-to-r from-blue-50 to-blue-50 border border-blue-100/50 px-2.5 py-1 rounded-lg">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3 text-blue-600"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                          <span className="font-bold text-blue-700 text-xs">{s.customer_count}</span>
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
            <table className="w-full text-sm min-w-[960px] text-left whitespace-nowrap">
              <thead className="bg-white border-b border-slate-200">
                <tr className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pl-6 pr-4 py-3">{tx("Name")}</th>
                  <th className="px-4 py-3">{tx("Type")}</th>
                  <th className="px-4 py-3">{tx("Partner")}</th>
                  <th className="px-4 py-3">{tx("Contact")}</th>
                  <th className="px-4 py-3">{tx("City")}</th>
                  <th className="px-4 py-3 text-right">{tx("Customers")}</th>
                  <th className="px-4 py-3">{tx("Status")}</th>
                  <th className="pl-4 pr-6 py-3 text-right w-16"><span className="sr-only">{tx("Actions")}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pagedSources.map((s) => {
                  const actions: RowAction[] = [
                    { key: "edit", label: tx("Edit"), icon: "edit", onSelect: () => openEdit(s) },
                    ...(s.login_status === "invited" ? [{ key: "resend", label: tx("Resend login"), icon: "mail", onSelect: () => handleResend(s) } as RowAction] : []),
                    { key: "delete", label: tx("Delete"), icon: "trash", tone: "danger", onSelect: () => handleDelete(s) },
                  ];
                  return (
                    <tr key={s.id} onClick={() => openEdit(s)} className={`group cursor-pointer transition-colors hover:bg-slate-50/70 ${s.is_active ? "" : "opacity-60"}`}>
                      <td className="pl-6 pr-4 py-3.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-100">
                            {initials(s.name)}
                          </span>
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{s.name}</div>
                            <div className="font-mono text-[11px] text-slate-400 mt-0.5">{s.code}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${SOURCE_TYPE_STYLE[s.source_type]}`}>
                          {tx(SOURCE_TYPE_LABELS[s.source_type])}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-[13px] text-slate-600">
                        {s.partner_name ? <span className="truncate max-w-[160px] inline-block align-bottom">{s.partner_name}</span> : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        {s.contact_person || s.contact_phone || s.contact_email ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[13px] font-medium text-slate-700">{s.contact_person || s.contact_email || s.contact_phone}</span>
                            {(() => {
                              const primary = s.contact_person || s.contact_email || s.contact_phone;
                              const rest = [s.contact_phone, s.contact_email].filter((v) => v && v !== primary).join(" · ");
                              return rest ? <span className="text-[11px] text-slate-400">{rest}</span> : null;
                            })()}
                            {s.login_status === "invited" && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-amber-700" title={tx("Credentials were emailed. They become a user once they sign in.")}>
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                                {tx("Invite sent · not signed in")}{s.login_role ? ` · ${s.login_role}` : ""}
                                {resendingId === s.id && <span className="text-slate-400">{" "}{tx("Sending…")}</span>}
                              </span>
                            )}
                            {s.login_status === "active" && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700" title={tx("Signed in — listed in User Management.")}>
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                {tx("Signed in ·")}{" "}{s.login_role || tx("user")}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-500">{s.city || <span className="text-slate-300">—</span>}</td>
                      <td className={`px-4 py-3.5 text-right tabular-nums text-[13px] ${s.customer_count > 0 ? "font-semibold text-slate-900" : "text-slate-400"}`}>{s.customer_count}</td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.is_active ? "text-emerald-700" : "text-slate-400"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${s.is_active ? "bg-emerald-500" : "bg-slate-300"}`} />
                          {s.is_active ? tx("Active") : tx("Inactive")}
                        </span>
                      </td>
                      <td className="pl-4 pr-6 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <RowActionsMenu actions={actions} disabled={resendingId === s.id} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination pagination={pagination} noun={tx("acquisition sources")} inline />
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h3 className="text-base font-bold text-slate-900">{editingId ? tx("Edit Acquisition Source") : tx("Add Acquisition Source")}</h3>
              {!editingId && (
                // Fills realistic values for whichever Type is currently selected.
                <DemoFillButton
                  className="ml-auto mr-3"
                  onFill={() => setForm((f) => ({ ...demoAcquisitionSource(f.source_type), source_type: f.source_type }))}
                />
              )}
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 bg-white hover:bg-slate-100 rounded-full p-1.5 transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm font-semibold text-red-600">{error}</div>}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Type *")}</label>
                  <select
                    value={form.source_type}
                    onChange={(e) => setForm((f) => ({ ...f, source_type: e.target.value as SourceType }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  >
                    {SOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>{SOURCE_TYPE_NUMBER[t]}. {tx(SOURCE_TYPE_LABELS[t])}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Producer Code *")}</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                    placeholder={tx("e.g. AGT-0417")}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Name *")}</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={tx("Agent name or firm / bank name")}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Partner (bank / firm)")}</label>
                  <input
                    type="text"
                    value={form.partner_name}
                    onChange={(e) => setForm((f) => ({ ...f, partner_name: e.target.value }))}
                    placeholder={tx("e.g. Habib Bank Limited")}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Contact Person")}</label>
                  <input
                    type="text"
                    value={form.contact_person}
                    onChange={(e) => setForm((f) => ({ ...f, contact_person: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("City")}</label>
                  <input
                    type="text"
                    value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Location")}</label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("CNIC")}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={15}
                    placeholder="42101-1234567-1"
                    value={form.cnic}
                    onChange={(e) => setForm((f) => ({ ...f, cnic: formatCnic(e.target.value) }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Contact Phone")}</label>
                  <input
                    type="text"
                    value={form.contact_phone}
                    onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">{tx("Contact Email")}</label>
                  <input
                    type="email"
                    value={form.contact_email}
                    onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
                  />
                  {!editingId && (
                    <p className="text-[11px] text-slate-400">
                      {tx("With an email, a login is created with the role that matches the type (Broker → Broker role) and its credentials are emailed here. They join User Management once they sign in.")}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 md:col-span-2 pt-2 bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                  <input
                    id="is_active"
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <label htmlFor="is_active" className="text-sm font-bold text-slate-800 cursor-pointer select-none">{tx("Channel is Active")}</label>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                disabled={saving}
                className="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200 shadow-sm hover:bg-slate-50 rounded-xl transition-colors"
              >
                {tx("Cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-600 rounded-xl shadow-sm hover:from-blue-700 hover:to-blue-700 disabled:opacity-50 transition-all active:scale-95"
              >
                {saving && <span className="animate-spin h-4 w-4 rounded-full border-2 border-white/30 border-t-white" />}
                {saving ? tx("Saving…") : editingId ? tx("Save Changes") : tx("Create Source")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
