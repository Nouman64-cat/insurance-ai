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

interface Role {
  id: string;
  name: string;
}

interface AdminUser {
  id: string;
  email: string;
  username: string;
  full_name: string;
  role_id: string;
  is_active?: boolean;
  status: string;
  created_at: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  department?: string;
  employee_id?: string;
  designation?: string;
  date_of_joining?: string;
}

function AdminManagementContent() {
  const searchParams = useSearchParams();
  const preselectedTenantId = searchParams.get("tenantId");

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [tenantId, setTenantId] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [formLoading, setFormLoading] = useState(false);

  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [adminsLoading, setAdminsLoading] = useState(false);
  const [adminsError, setAdminsError] = useState("");

  // Edit modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedAdmin, setSelectedAdmin] = useState<AdminUser | null>(null);

  // Edit form fields
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editStatus, setEditStatus] = useState("ACTIVE");
  const [editPhone, setEditPhone] = useState("");
  const [editDepartment, setEditDepartment] = useState("");
  const [editEmployeeId, setEditEmployeeId] = useState("");
  const [editDesignation, setEditDesignation] = useState("");
  const [editDateOfJoining, setEditDateOfJoining] = useState("");

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchTenantsAndRoles();
  }, []);

  useEffect(() => {
    if (tenantId) {
      fetchAdmins(tenantId);
    } else {
      setAdmins([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const fetchTenantsAndRoles = async () => {
    setLoading(true);
    setError("");
    try {
      const [tenantsResp, rolesResp] = await Promise.all([
        api.get<Tenant[]>("/tenants"),
        api.get<Role[]>("/roles"),
      ]);
      setTenants(tenantsResp.data);
      setRoles(rolesResp.data);
      if (preselectedTenantId && tenantsResp.data.some((t) => t.id === preselectedTenantId)) {
        setTenantId(preselectedTenantId);
      } else if (tenantsResp.data.length > 0) {
        setTenantId(tenantsResp.data[0].id);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load tenants.");
    } finally {
      setLoading(false);
    }
  };

  const fetchAdmins = async (forTenantId: string) => {
    setAdminsLoading(true);
    setAdminsError("");
    try {
      const resp = await api.get<AdminUser[]>(`/tenants/${forTenantId}/users/`);
      const adminRoleIds = new Set(roles.filter((r) => r.name === "Admin").map((r) => r.id));
      setAdmins(resp.data.filter((u) => adminRoleIds.has(u.role_id)));
    } catch (err: any) {
      setAdminsError(err.response?.data?.detail ?? err.message ?? "Failed to load admins.");
      setAdmins([]);
    } finally {
      setAdminsLoading(false);
    }
  };

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);

    const adminRole = roles.find((r) => r.name === "Admin");
    if (!adminRole) {
      setError("Admin role not found.");
      setFormLoading(false);
      return;
    }

    try {
      if (admins.length > 0) {
        await api.post(`/tenants/${tenantId}/users/`, {
          email,
          full_name: fullName,
          role_id: adminRole.id,
        });
      } else {
        try {
          await api.post(`/tenants/${tenantId}/setup`, {
            email,
            full_name: fullName,
          });
        } catch (setupErr: any) {
          if (setupErr.response?.status === 409) {
            await api.post(`/tenants/${tenantId}/users/`, {
              email,
              full_name: fullName,
              role_id: adminRole.id,
            });
          } else {
            throw setupErr;
          }
        }
      }
      const tenantName = tenants.find((t) => t.id === tenantId)?.name ?? "the tenant";
      setSuccess(`Admin account created for "${tenantName}". Login credentials were emailed to ${email}.`);
      setFullName("");
      setEmail("");
      fetchAdmins(tenantId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to create admin.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleOpenEditModal = (admin: AdminUser) => {
    setSelectedAdmin(admin);
    setEditFirstName(admin.first_name ?? "");
    setEditLastName(admin.last_name ?? "");
    setEditPassword("");
    setEditStatus(admin.status ?? "ACTIVE");
    setEditPhone(admin.phone ?? "");
    setEditDepartment(admin.department ?? "");
    setEditEmployeeId(admin.employee_id ?? "");
    setEditDesignation(admin.designation ?? "");
    setEditDateOfJoining(admin.date_of_joining ?? "");
    setError("");
    setSuccess("");
    setShowEditModal(true);
  };

  const handleEditAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);

    if (!selectedAdmin) return;

    try {
      const updateData: any = {
        status: editStatus,
        first_name: editFirstName,
        last_name: editLastName,
        phone: editPhone || null,
        department: editDepartment || null,
        employee_id: editEmployeeId || null,
        designation: editDesignation || null,
        date_of_joining: editDateOfJoining || null,
      };

      if (editPassword) {
        updateData.password = editPassword;
      }

      await api.patch(`/tenants/${tenantId}/users/${selectedAdmin.id}`, updateData);

      setSuccess("Admin account updated successfully!");
      setShowEditModal(false);
      fetchAdmins(tenantId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update admin.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteAdmin = async (admin: AdminUser) => {
    if (!confirm(`Are you sure you want to delete the admin "${admin.full_name}"?`)) {
      return;
    }

    setError("");
    setSuccess("");

    try {
      await api.delete(`/tenants/${tenantId}/users/${admin.id}`);
      setSuccess("Admin account deleted successfully!");
      fetchAdmins(tenantId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete admin.");
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
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Admin Management</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Provision the first Admin account for a tenant. Login credentials are emailed automatically.
        </p>
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
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">

          {/* ── Create Admin Form ── */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
              <p className="text-sm font-semibold text-slate-700">Create Admin Account</p>
            </div>

            <form onSubmit={handleCreateAdmin} className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Tenant *</label>
                <select
                  required
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                >
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Full Name *</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Ali Raza"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Email Address *</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. ali@adamjeelife.com"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <p className="text-xs text-slate-400">
                A username and password will be generated automatically and emailed to this address.
              </p>

              <div className="pt-3 border-t border-slate-100">
                <button
                  type="submit"
                  disabled={formLoading}
                  className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors"
                >
                  {formLoading && (
                    <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  Create Admin
                </button>
              </div>
            </form>
          </div>

          {/* ── Existing Admins for Selected Tenant ── */}
          <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">
                Admins {selectedTenant ? `— ${selectedTenant.name}` : ""}
              </p>
              <span className="text-xs text-slate-400 font-medium">Total: {admins.length}</span>
            </div>

            {adminsLoading ? (
              <div className="py-16 flex flex-col items-center justify-center gap-3">
                <svg className="animate-spin h-6 w-6 text-blue-500" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-xs text-slate-400">Loading admins...</span>
              </div>
            ) : adminsError ? (
              <div className="py-16 text-center text-sm text-red-500 px-5">{adminsError}</div>
            ) : admins.length === 0 ? (
              <div className="py-16 text-center text-slate-400 px-5">
                <p className="text-sm">No Admin has been provisioned for this tenant yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3.5 text-left">Full Name</th>
                      <th className="px-5 py-3.5 text-left">Email</th>
                      <th className="px-5 py-3.5 text-center">Status</th>
                      <th className="px-5 py-3.5 text-left">Created</th>
                      <th className="px-5 py-3.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {admins.map((admin) => (
                      <tr key={admin.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-3.5 font-semibold text-slate-800">{admin.full_name}</td>
                        <td className="px-5 py-3.5 text-slate-600">{admin.email}</td>
                        <td className="px-5 py-3.5 text-center">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${
                              admin.status === "ACTIVE"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : admin.status === "SUSPENDED"
                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                : admin.status === "LOCKED"
                                ? "bg-rose-50 text-rose-700 border-rose-200"
                                : "bg-slate-100 text-slate-700 border-slate-200"
                            }`}
                          >
                            {admin.status === "ACTIVE"
                              ? "Active"
                              : admin.status === "SUSPENDED"
                              ? "Suspended"
                              : admin.status === "LOCKED"
                              ? "Locked"
                              : admin.status === "INACTIVE"
                              ? "Inactive"
                              : admin.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-xs text-slate-400">
                          {new Date(admin.created_at).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                        <td className="px-5 py-3.5 text-right space-x-2">
                          <button
                            onClick={() => handleOpenEditModal(admin)}
                            className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                          >
                            Edit
                          </button>
                          <span className="text-slate-200">|</span>
                          <button
                            onClick={() => handleDeleteAdmin(admin)}
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
        </div>
      )}

      {/* ── EDIT ADMIN MODAL ── */}
      {showEditModal && selectedAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-2xl w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Edit Admin Account</h3>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditAdmin} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Username (Read Only)</label>
                  <input
                    type="text"
                    disabled
                    value={selectedAdmin.username}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-500 cursor-not-allowed focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Email (Read Only)</label>
                  <input
                    type="email"
                    disabled
                    value={selectedAdmin.email}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-500 cursor-not-allowed focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">First Name *</label>
                  <input
                    type="text"
                    required
                    value={editFirstName}
                    onChange={(e) => setEditFirstName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Last Name *</label>
                  <input
                    type="text"
                    required
                    value={editLastName}
                    onChange={(e) => setEditLastName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Password (Leave blank to keep same)</label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="Enter new password if updating"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Phone</label>
                  <input
                    type="text"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="e.g. +923001234567"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Department</label>
                  <input
                    type="text"
                    value={editDepartment}
                    onChange={(e) => setEditDepartment(e.target.value)}
                    placeholder="e.g. Underwriting"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Employee ID</label>
                  <input
                    type="text"
                    value={editEmployeeId}
                    onChange={(e) => setEditEmployeeId(e.target.value)}
                    placeholder="e.g. EMP-1049"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Designation</label>
                  <input
                    type="text"
                    value={editDesignation}
                    onChange={(e) => setEditDesignation(e.target.value)}
                    placeholder="e.g. Senior Underwriter"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Date of Joining</label>
                  <input
                    type="date"
                    value={editDateOfJoining}
                    onChange={(e) => setEditDateOfJoining(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Account Status *</label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="SUSPENDED">Suspended</option>
                    <option value="LOCKED">Locked</option>
                  </select>
                </div>
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

export default function AdminManagementPage() {
  return (
    <Suspense fallback={null}>
      <AdminManagementContent />
    </Suspense>
  );
}
