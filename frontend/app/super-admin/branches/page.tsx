"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import api from "@/app/services/api";

interface Tenant {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
}

const BRANCH_TYPES = [
  { value: "HEAD_OFFICE", label: "Head Office" },
  { value: "REGIONAL_OFFICE", label: "Regional Office" },
  { value: "BRANCH", label: "Branch" },
  { value: "LIAISON_OFFICE", label: "Liaison Office" },
];

const branchTypeLabel = (value: string) =>
  BRANCH_TYPES.find((t) => t.value === value)?.label ?? value;

interface Branch {
  id: string;
  tenant_id: string;
  branch_code: string;
  name: string;
  branch_type: string;
  region?: string | null;
  city: string;
  address?: string | null;
  postal_code?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  is_active: boolean;
  opened_date?: string | null;
  created_at: string;
}

interface BranchFormFields {
  branch_code: string;
  name: string;
  branch_type: string;
  region: string;
  city: string;
  address: string;
  postal_code: string;
  contact_person: string;
  contact_phone: string;
  contact_email: string;
  opened_date: string;
}

const emptyBranchForm: BranchFormFields = {
  branch_code: "",
  name: "",
  branch_type: "BRANCH",
  region: "",
  city: "",
  address: "",
  postal_code: "",
  contact_person: "",
  contact_phone: "",
  contact_email: "",
  opened_date: "",
};

function BranchManagementContent() {
  const searchParams = useSearchParams();
  const preselectedTenantId = searchParams.get("tenantId");

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<BranchFormFields>(emptyBranchForm);
  const [formLoading, setFormLoading] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [editForm, setEditForm] = useState<BranchFormFields>(emptyBranchForm);
  const [editActive, setEditActive] = useState(true);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tenantId) {
      fetchBranches(tenantId);
    } else {
      setBranches([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const fetchTenants = async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await api.get<Tenant[]>("/tenants");
      setTenants(resp.data);
      if (preselectedTenantId && resp.data.some((t) => t.id === preselectedTenantId)) {
        setTenantId(preselectedTenantId);
      } else if (resp.data.length > 0) {
        setTenantId(resp.data[0].id);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load tenants.");
    } finally {
      setLoading(false);
    }
  };

  const fetchBranches = async (forTenantId: string) => {
    setBranchesLoading(true);
    setBranchesError("");
    try {
      const resp = await api.get<Branch[]>(`/tenants/${forTenantId}/branches`);
      setBranches(resp.data);
    } catch (err: any) {
      setBranchesError(err.response?.data?.detail ?? err.message ?? "Failed to load branches.");
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleOpenCreateModal = () => {
    setCreateForm(emptyBranchForm);
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);

    try {
      const payload: Record<string, any> = {
        branch_code: createForm.branch_code,
        name: createForm.name,
        branch_type: createForm.branch_type,
        city: createForm.city,
      };
      if (createForm.region.trim()) payload.region = createForm.region;
      if (createForm.address.trim()) payload.address = createForm.address;
      if (createForm.postal_code.trim()) payload.postal_code = createForm.postal_code;
      if (createForm.contact_person.trim()) payload.contact_person = createForm.contact_person;
      if (createForm.contact_phone.trim()) payload.contact_phone = createForm.contact_phone;
      if (createForm.contact_email.trim()) payload.contact_email = createForm.contact_email;
      if (createForm.opened_date.trim()) payload.opened_date = createForm.opened_date;

      await api.post(`/tenants/${tenantId}/branches`, payload);
      setSuccess(`Branch "${createForm.name}" created successfully!`);
      setShowCreateModal(false);
      fetchBranches(tenantId);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(
        Array.isArray(detail)
          ? detail.map((d: any) => d.msg).join(", ")
          : detail ?? err.message ?? "Failed to create branch."
      );
    } finally {
      setFormLoading(false);
    }
  };

  const handleOpenEditModal = (branch: Branch) => {
    setEditingBranch(branch);
    setEditForm({
      branch_code: branch.branch_code,
      name: branch.name,
      branch_type: branch.branch_type,
      region: branch.region ?? "",
      city: branch.city,
      address: branch.address ?? "",
      postal_code: branch.postal_code ?? "",
      contact_person: branch.contact_person ?? "",
      contact_phone: branch.contact_phone ?? "",
      contact_email: branch.contact_email ?? "",
      opened_date: branch.opened_date?.slice(0, 10) ?? "",
    });
    setEditActive(branch.is_active);
    setError("");
    setSuccess("");
    setShowEditModal(true);
  };

  const handleEditBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBranch) return;
    setError("");
    setSuccess("");
    setFormLoading(true);

    try {
      await api.patch(`/branches/${editingBranch.id}`, {
        name: editForm.name,
        branch_type: editForm.branch_type,
        region: editForm.region || null,
        city: editForm.city,
        address: editForm.address || null,
        postal_code: editForm.postal_code || null,
        contact_person: editForm.contact_person || null,
        contact_phone: editForm.contact_phone || null,
        contact_email: editForm.contact_email || null,
        opened_date: editForm.opened_date || null,
        is_active: editActive,
      });
      setSuccess(`Branch "${editForm.name}" updated successfully!`);
      setShowEditModal(false);
      fetchBranches(tenantId);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(
        Array.isArray(detail)
          ? detail.map((d: any) => d.msg).join(", ")
          : detail ?? err.message ?? "Failed to update branch."
      );
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteBranch = async (branch: Branch) => {
    if (!confirm(`Are you sure you want to delete the branch "${branch.name}" (${branch.branch_code})?`)) {
      return;
    }
    setError("");
    setSuccess("");
    try {
      await api.delete(`/branches/${branch.id}`);
      setSuccess(`Branch "${branch.name}" deleted successfully!`);
      fetchBranches(tenantId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete branch.");
    }
  };

  if (!authorized) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 text-center font-sans min-h-screen">
        <div className="max-w-md p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-xl">
          <div className="w-16 h-16 bg-red-950/40 text-red-500 border border-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Access Denied</h1>
          <p className="text-slate-400 text-sm mb-6">
            You do not have SuperAdmin privileges to access the Platform console.
          </p>
          <a href="/" className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  const selectedTenant = tenants.find((t) => t.id === tenantId);

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Branch Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage regional offices and branches for a tenant's office network.
          </p>
        </div>
        {tenants.length > 0 && (
          <button
            onClick={handleOpenCreateModal}
            disabled={!tenantId}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow-md active:scale-95 self-start disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Branch
          </button>
        )}
      </div>

      {/* Message banners */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">
          {success}
        </div>
      )}

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-slate-400">Loading tenants...</span>
        </div>
      ) : tenants.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm py-16 text-center text-slate-400 px-5">
          <p className="text-sm">No tenants exist yet.</p>
          <a href="/super-admin/tenants" className="mt-3 inline-block text-xs text-blue-600 font-semibold hover:underline">
            Create a tenant first
          </a>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-slate-600">Tenant</label>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
              >
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.code})
                  </option>
                ))}
              </select>
            </div>
            <span className="text-xs text-slate-400 font-medium">Total: {branches.length}</span>
          </div>

          {branchesLoading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3">
              <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-slate-400">Fetching branches...</span>
            </div>
          ) : branchesError ? (
            <div className="py-16 text-center text-sm text-red-500 px-5">{branchesError}</div>
          ) : branches.length === 0 ? (
            <div className="py-20 text-center text-slate-400">
              <p className="text-sm">
                No branches registered for {selectedTenant ? selectedTenant.name : "this tenant"} yet.
              </p>
              <button
                onClick={handleOpenCreateModal}
                className="mt-3 text-xs text-blue-600 font-semibold hover:underline"
              >
                Add the first branch
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    <th className="px-5 py-3.5 text-left">Code</th>
                    <th className="px-5 py-3.5 text-left">Name</th>
                    <th className="px-5 py-3.5 text-left">Type</th>
                    <th className="px-5 py-3.5 text-left">Region / City</th>
                    <th className="px-5 py-3.5 text-center">Status</th>
                    <th className="px-5 py-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branches.map((branch) => (
                    <tr key={branch.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3.5">
                        <span className="inline-flex px-2 py-0.5 rounded text-xs font-mono font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                          {branch.branch_code}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 font-semibold text-slate-800">{branch.name}</td>
                      <td className="px-5 py-3.5 text-slate-600">{branchTypeLabel(branch.branch_type)}</td>
                      <td className="px-5 py-3.5 text-slate-600">
                        {branch.region ? `${branch.region} — ` : ""}
                        {branch.city}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${
                            branch.is_active
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-slate-100 text-slate-700 border-slate-200"
                          }`}
                        >
                          {branch.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right space-x-2">
                        <button
                          onClick={() => handleOpenEditModal(branch)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                        >
                          Edit
                        </button>
                        <span className="text-slate-200">|</span>
                        <button
                          onClick={() => handleDeleteBranch(branch)}
                          className="text-xs font-bold text-red-500 hover:text-red-700 transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── CREATE BRANCH MODAL ── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-xl w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Add New Branch</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreateBranch} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Branch Code *</label>
                  <input
                    type="text"
                    required
                    value={createForm.branch_code}
                    onChange={(e) => setCreateForm((f) => ({ ...f, branch_code: e.target.value.toUpperCase() }))}
                    placeholder="e.g. LHR-01"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 font-mono placeholder:text-slate-400 placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Branch Type *</label>
                  <select
                    value={createForm.branch_type}
                    onChange={(e) => setCreateForm((f) => ({ ...f, branch_type: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                  >
                    {BRANCH_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Branch Name *</label>
                  <input
                    type="text"
                    required
                    value={createForm.name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Lahore Main Branch"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Region</label>
                  <input
                    type="text"
                    value={createForm.region}
                    onChange={(e) => setCreateForm((f) => ({ ...f, region: e.target.value }))}
                    placeholder="e.g. Punjab"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">City *</label>
                  <input
                    type="text"
                    required
                    value={createForm.city}
                    onChange={(e) => setCreateForm((f) => ({ ...f, city: e.target.value }))}
                    placeholder="e.g. Lahore"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Address</label>
                  <input
                    type="text"
                    value={createForm.address}
                    onChange={(e) => setCreateForm((f) => ({ ...f, address: e.target.value }))}
                    placeholder="Street address"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Postal Code</label>
                  <input
                    type="text"
                    value={createForm.postal_code}
                    onChange={(e) => setCreateForm((f) => ({ ...f, postal_code: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Opened Date</label>
                  <input
                    type="date"
                    value={createForm.opened_date}
                    onChange={(e) => setCreateForm((f) => ({ ...f, opened_date: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Person</label>
                  <input
                    type="text"
                    value={createForm.contact_person}
                    onChange={(e) => setCreateForm((f) => ({ ...f, contact_person: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text"
                    value={createForm.contact_phone}
                    onChange={(e) => setCreateForm((f) => ({ ...f, contact_phone: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email"
                    value={createForm.contact_email}
                    onChange={(e) => setCreateForm((f) => ({ ...f, contact_email: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {formLoading && (
                    <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  Create Branch
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── EDIT BRANCH MODAL ── */}
      {showEditModal && editingBranch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-xl w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Edit Branch</h3>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditBranch} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Branch Code</label>
                  <input
                    type="text"
                    disabled
                    value={editForm.branch_code}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-400 font-mono focus:outline-none cursor-not-allowed"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Branch Type *</label>
                  <select
                    value={editForm.branch_type}
                    onChange={(e) => setEditForm((f) => ({ ...f, branch_type: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                  >
                    {BRANCH_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Branch Name *</label>
                  <input
                    type="text"
                    required
                    value={editForm.name}
                    onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Region</label>
                  <input
                    type="text"
                    value={editForm.region}
                    onChange={(e) => setEditForm((f) => ({ ...f, region: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">City *</label>
                  <input
                    type="text"
                    required
                    value={editForm.city}
                    onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Address</label>
                  <input
                    type="text"
                    value={editForm.address}
                    onChange={(e) => setEditForm((f) => ({ ...f, address: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Postal Code</label>
                  <input
                    type="text"
                    value={editForm.postal_code}
                    onChange={(e) => setEditForm((f) => ({ ...f, postal_code: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Opened Date</label>
                  <input
                    type="date"
                    value={editForm.opened_date}
                    onChange={(e) => setEditForm((f) => ({ ...f, opened_date: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Person</label>
                  <input
                    type="text"
                    value={editForm.contact_person}
                    onChange={(e) => setEditForm((f) => ({ ...f, contact_person: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
                  <input
                    type="text"
                    value={editForm.contact_phone}
                    onChange={(e) => setEditForm((f) => ({ ...f, contact_phone: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
                  <input
                    type="email"
                    value={editForm.contact_email}
                    onChange={(e) => setEditForm((f) => ({ ...f, contact_email: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1.5">
                <input
                  type="checkbox"
                  id="editBranchActive"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500/20 h-4 w-4"
                />
                <label htmlFor="editBranchActive" className="text-xs font-semibold text-slate-700 select-none">
                  Branch Active Status
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {formLoading && (
                    <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BranchManagementPage() {
  return (
    <Suspense fallback={null}>
      <BranchManagementContent />
    </Suspense>
  );
}
