"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";

interface User {
  id: string;
  email: string;
  full_name: string;
  role_id: string;
  is_active: boolean;
  created_at: string;
}

interface Role {
  id: string;
  name: string;
  description: string;
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Modal / Form state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  // Form Fields
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [formLoading, setFormLoading] = useState(false);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchUsersAndRoles();
  }, []);

  const fetchUsersAndRoles = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");

    if (!tenantId) {
      setError("No active organization tenant found. Please log in again.");
      setLoading(false);
      return;
    }

    try {
      // Fetch users and roles in parallel
      const [usersResp, rolesResp] = await Promise.all([
        api.get<User[]>(`/tenants/${tenantId}/users/`),
        api.get<Role[]>("/roles"),
      ]);

      setUsers(usersResp.data);
      setRoles(rolesResp.data);
      if (rolesResp.data.length > 0) {
        setRoleId(rolesResp.data[0].id);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load admin management data.");
    } finally {
      setLoading(false);
    }
  };

  const getRoleName = (roleId: string) => {
    const role = roles.find((r) => r.id === roleId);
    return role ? role.name : "Unknown Role";
  };

  const handleOpenCreateModal = () => {
    setFullName("");
    setEmail("");
    setPassword("");
    if (roles.length > 0) setRoleId(roles[0].id);
    setIsActive(true);
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleOpenEditModal = (user: User) => {
    setSelectedUser(user);
    setFullName(user.full_name);
    setEmail(user.email);
    setPassword(""); // Keep blank if not editing password
    setRoleId(user.role_id);
    setIsActive(user.is_active);
    setError("");
    setSuccess("");
    setShowEditModal(true);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    try {
      await api.post(`/tenants/${tenantId}/users/`, {
        email,
        password,
        full_name: fullName,
        role_id: roleId,
      });

      setSuccess("User created successfully!");
      setShowCreateModal(false);
      fetchUsersAndRoles();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to create user.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    if (!selectedUser) return;

    try {
      const updateData: any = {
        full_name: fullName,
        role_id: roleId,
        is_active: isActive,
      };
      
      // Only send password if updated
      if (password) {
        updateData.password = password;
      }

      await api.patch(`/tenants/${tenantId}/users/${selectedUser.id}`, updateData);

      setSuccess("User updated successfully!");
      setShowEditModal(false);
      fetchUsersAndRoles();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update user.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteUser = async (user: User) => {
    if (!confirm(`Are you sure you want to delete the user "${user.full_name}"?`)) {
      return;
    }

    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");

    try {
      await api.delete(`/tenants/${tenantId}/users/${user.id}`);
      setSuccess("User deleted successfully!");
      fetchUsersAndRoles();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete user.");
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
            You do not have administrative privileges to access the User Management console.
          </p>
          <a href="/" className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Admin console to manage users, assign system roles, and control active portal status.
          </p>
        </div>
        <button
          onClick={handleOpenCreateModal}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow-md active:scale-95 self-start"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add New User
        </button>
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

      {/* Main content table card */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">All Portal Accounts</p>
          <span className="text-xs text-slate-400 font-medium">Total: {users.length}</span>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-3">
            <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-xs text-slate-400">Fetching tenant directory...</span>
          </div>
        ) : users.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">No users registered in this tenant.</p>
            <button
              onClick={handleOpenCreateModal}
              className="mt-3 text-xs text-blue-600 font-semibold hover:underline"
            >
              Register the first account
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3.5 text-left">Full Name</th>
                  <th className="px-5 py-3.5 text-left">Email Address</th>
                  <th className="px-5 py-3.5 text-left">Portal Role</th>
                  <th className="px-5 py-3.5 text-center">Status</th>
                  <th className="px-5 py-3.5 text-left">Created Date</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{user.full_name}</td>
                    <td className="px-5 py-3.5 text-slate-600">{user.email}</td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                        {getRoleName(user.role_id)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${
                          user.is_active
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-red-50 text-red-600 border-red-200"
                        }`}
                      >
                        {user.is_active ? "Active" : "Suspended"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">
                      {new Date(user.created_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="px-5 py-3.5 text-right space-x-2">
                      <button
                        onClick={() => handleOpenEditModal(user)}
                        className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        Edit
                      </button>
                      <span className="text-slate-200">|</span>
                      <button
                        onClick={() => handleDeleteUser(user)}
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

      {/* ── CREATE USER MODAL ── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Add New Portal Account</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Full Name</label>
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
                <label className="block text-xs font-semibold text-slate-600">Email Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. ali@adamjeelife.com"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Portal Role</label>
                <select
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
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
                  Create Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── EDIT USER MODAL ── */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Edit Portal Account</h3>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditUser} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Email (Read Only)</label>
                <input
                  type="email"
                  disabled
                  value={email}
                  className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-500 cursor-not-allowed focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Password (Leave blank to keep same)</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter new password if updating"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Portal Role</label>
                <select
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Active Toggle */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                <span className="text-xs font-semibold text-slate-700">Account Active Status</span>
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
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
