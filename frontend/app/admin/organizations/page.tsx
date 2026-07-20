"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";

interface Organization {
  id: string;
  tenant_id: string;
  name: string;
  registration_number: string | null;
  industry: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
}

export default function OrganizationsPage() {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [industry, setIndustry] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchOrganizations();
  }, []);

  const fetchOrganizations = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const resp = await api.get<Organization[]>(`/tenants/${tenantId}/organizations`);
      setOrganizations(resp.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load organizations.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreateModal = (org?: Organization) => {
    if (org) {
      setEditingOrgId(org.id);
      setName(org.name);
      setRegistrationNumber(org.registration_number || "");
      setIndustry(org.industry || "");
      setContactPerson(org.contact_person || "");
      setContactEmail(org.contact_email || "");
      setContactPhone(org.contact_phone || "");
    } else {
      setEditingOrgId(null);
      setName("");
      setRegistrationNumber("");
      setIndustry("");
      setContactPerson("");
      setContactEmail("");
      setContactPhone("");
    }
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    try {
      const payload = {
        name,
        registration_number: registrationNumber || null,
        industry: industry || null,
        contact_person: contactPerson || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
      };

      if (editingOrgId) {
        await api.patch(`/tenants/${tenantId}/organizations/${editingOrgId}`, payload);
        setSuccess(`Organization "${name}" updated successfully!`);
      } else {
        await api.post(`/tenants/${tenantId}/organizations`, payload);
        setSuccess(`Organization "${name}" created successfully!`);
      }
      setShowCreateModal(false);
      fetchOrganizations();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to save organization.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteOrganization = async (orgId: string, orgName: string) => {
    if (!confirm(`Are you sure you want to delete the organization "${orgName}"? This action cannot be undone.`)) {
      return;
    }
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    try {
      await api.delete(`/tenants/${tenantId}/organizations/${orgId}`);
      setSuccess(`Organization "${orgName}" deleted successfully!`);
      fetchOrganizations();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete organization.");
    }
  };

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
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Organization Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Businesses insuring their staff under a group policy, rather than individuals shopping for their own coverage.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Search organizations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
          />
          <button
            onClick={() => handleOpenCreateModal()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm hover:shadow active:scale-95 w-full sm:w-auto justify-center"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Organization
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Registered Organizations</p>
          <span className="text-xs text-slate-400 font-medium">Total: {organizations.length}</span>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading organizations...</span>
          </div>
        ) : organizations.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">No organizations registered in this tenant.</p>
            <button onClick={() => handleOpenCreateModal()} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
              Add the first organization
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3.5 text-left">Company Name</th>
                  <th className="px-5 py-3.5 text-left">Industry</th>
                  <th className="px-5 py-3.5 text-left">Contact Person</th>
                  <th className="px-5 py-3.5 text-left">Contact Email</th>
                  <th className="px-5 py-3.5 text-left">Created</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {organizations
                  .filter((org) => {
                    const q = search.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      org.name.toLowerCase().includes(q) ||
                      (org.industry || "").toLowerCase().includes(q) ||
                      (org.contact_person || "").toLowerCase().includes(q) ||
                      (org.contact_email || "").toLowerCase().includes(q)
                    );
                  })
                  .map((org) => (
                  <tr key={org.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{org.name}</td>
                    <td className="px-5 py-3.5 text-slate-600">{org.industry ?? "—"}</td>
                    <td className="px-5 py-3.5 text-slate-600">{org.contact_person ?? "—"}</td>
                    <td className="px-5 py-3.5 text-slate-600">{org.contact_email ?? "—"}</td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">
                      {new Date(org.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </td>
                    <td className="px-5 py-3.5 text-right space-x-3">
                      <button
                        onClick={() => handleOpenCreateModal(org)}
                        className="text-xs font-bold text-emerald-600 hover:text-emerald-800 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteOrganization(org.id, org.name)}
                        className="text-xs font-bold text-red-600 hover:text-red-800 transition-colors"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => router.push(`/admin/organizations/${org.id}`)}
                        className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        Manage →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CREATE ORGANIZATION MODAL ── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">{editingOrgId ? "Edit Organization" : "Add New Organization"}</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Company Name *</label>
                <input
                  type="text" required value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. TechPak Solutions"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Registration No. (NTN)</label>
                  <input
                    type="text" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)}
                    placeholder="e.g. 1234567-8"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Industry</label>
                  <input
                    type="text" value={industry} onChange={(e) => setIndustry(e.target.value)}
                    placeholder="e.g. Textiles"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Contact Person</label>
                <input
                  type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
                  placeholder="e.g. Ali Raza (HR Manager)"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="hr@company.com"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="+92 300 1234567"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button" onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit" disabled={formLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {formLoading && (
                    <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  {editingOrgId ? "Update Organization" : "Create Organization"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
