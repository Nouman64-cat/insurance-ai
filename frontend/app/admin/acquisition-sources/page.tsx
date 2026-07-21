"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";

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
  const [search, setSearch] = useState("");

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

  const filtered = sources.filter((s) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      (s.partner_name ?? "").toLowerCase().includes(q) ||
      SOURCE_TYPE_LABELS[s.source_type].toLowerCase().includes(q)
    );
  });

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
            The agents, brokers, banks and channels credited with bringing customers in.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm active:scale-95 self-start"
        >
          Add Source
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      <div className="flex items-center justify-between gap-3">
        <input
          type="text"
          placeholder="Search by name, code, partner, or type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading sources…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">{sources.length === 0 ? "No acquisition sources yet." : "No sources match your search."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">Name</th>
                  <th className="px-5 py-3 text-left">Type</th>
                  <th className="px-5 py-3 text-left">Code</th>
                  <th className="px-5 py-3 text-left">Partner</th>
                  <th className="px-5 py-3 text-left">Contact</th>
                  <th className="px-5 py-3 text-left">City</th>
                  <th className="px-5 py-3 text-right">Customers</th>
                  <th className="px-5 py-3 text-center">Status</th>
                  <th className="px-5 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{s.name}</td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${SOURCE_TYPE_STYLE[s.source_type]}`}>
                        {SOURCE_TYPE_LABELS[s.source_type]}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-500">{s.code}</td>
                    <td className="px-5 py-3.5 text-slate-600">{s.partner_name || <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {s.contact_person || s.contact_phone || s.contact_email ? (
                        <div className="flex flex-col leading-tight">
                          {s.contact_person && <span className="text-xs text-slate-700">{s.contact_person}</span>}
                          {s.contact_phone && <span className="text-[11px] text-slate-400">{s.contact_phone}</span>}
                          {s.contact_email && <span className="text-[11px] text-slate-400">{s.contact_email}</span>}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">{s.city || <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-3.5 text-right font-semibold text-slate-700">{s.customer_count}</td>
                    <td className="px-5 py-3.5 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {s.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-center whitespace-nowrap">
                      <div className="inline-flex rounded-lg shadow-sm border border-slate-200 overflow-hidden divide-x divide-slate-200">
                        <button
                          onClick={() => openEdit(s)}
                          className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(s)}
                          className="px-3 py-1.5 text-xs font-semibold text-red-600 bg-white hover:bg-red-50 transition-colors"
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
        )}
      </div>

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">{editingId ? "Edit Acquisition Source" : "Add Acquisition Source"}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600">{error}</div>}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">Type *</label>
                  <select
                    value={form.source_type}
                    onChange={(e) => setForm((f) => ({ ...f, source_type: e.target.value as SourceType }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  >
                    {SOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>{SOURCE_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">Producer Code *</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                    placeholder="e.g. AGT-0417"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-semibold text-slate-600">Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Agent name or firm / bank name"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-semibold text-slate-600">Partner (bank / firm)</label>
                  <input
                    type="text"
                    value={form.partner_name}
                    onChange={(e) => setForm((f) => ({ ...f, partner_name: e.target.value }))}
                    placeholder="e.g. Habib Bank Limited — for bancassurance / corporate"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">Contact Person</label>
                  <input
                    type="text"
                    value={form.contact_person}
                    onChange={(e) => setForm((f) => ({ ...f, contact_person: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">City</label>
                  <input
                    type="text"
                    value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">Location</label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">CNIC</label>
                  <input
                    type="text"
                    value={form.cnic}
                    onChange={(e) => setForm((f) => ({ ...f, cnic: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text"
                    value={form.contact_phone}
                    onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email"
                    value={form.contact_email}
                    onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
                <div className="flex items-center gap-2 md:col-span-2 pt-1">
                  <input
                    id="is_active"
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                  />
                  <label htmlFor="is_active" className="text-xs font-semibold text-slate-600 cursor-pointer">Active</label>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {saving && <span className="animate-spin h-3 w-3 rounded-full border-2 border-white/30 border-t-white" />}
                {saving ? "Saving…" : editingId ? "Save Changes" : "Create Source"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
