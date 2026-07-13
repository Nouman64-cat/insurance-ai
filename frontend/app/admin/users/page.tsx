"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

const createUserSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  roleId: z.string().min(1, "Role is required"),
});

const editUserSchema = z.object({
  firstName: z.string().min(2, "First name must be at least 2 characters"),
  lastName: z.string().min(2, "Last name must be at least 2 characters"),
  password: z.string().optional(),
  roleId: z.string().min(1, "Role is required"),
  status: z.string(),
  phone: z.string().optional(),
  department: z.string().optional(),
  employeeId: z.string().optional(),
  designation: z.string().optional(),
  dateOfJoining: z.string().optional(),
});

interface User {
  id: string;
  email: string;
  username: string;
  full_name: string;
  role_id: string;
  is_active: boolean;
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

interface Role {
  id: string;
  name: string;
  description: string;
}

export default function UserManagementPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [currentUserEmail, setCurrentUserEmail] = useState("");

  // Modal / Form state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  const [formLoading, setFormLoading] = useState(false);

  const createForm = useForm<z.infer<typeof createUserSchema>>({
    resolver: zodResolver(createUserSchema),
    mode: "onChange",
    defaultValues: { fullName: "", email: "", roleId: "" }
  });

  const editForm = useForm<z.infer<typeof editUserSchema>>({
    resolver: zodResolver(editUserSchema),
    mode: "onChange",
    defaultValues: {
      firstName: "", lastName: "", password: "", roleId: "",
      status: "ACTIVE", phone: "", department: "", employeeId: "",
      designation: "", dateOfJoining: ""
    }
  });

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    setCurrentUserEmail(localStorage.getItem("user_email") ?? "");
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
      const [usersResp, rolesResp] = await Promise.all([
        api.get<User[]>(`/tenants/${tenantId}/users/`),
        api.get<Role[]>("/roles"),
      ]);

      setUsers(usersResp.data);
      setRoles(rolesResp.data);
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
    createForm.reset({ fullName: "", email: "", roleId: roles[0]?.id ?? "" });
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleOpenEditModal = (user: User) => {
    setSelectedUser(user);
    editForm.reset({
      firstName: user.first_name ?? "",
      lastName: user.last_name ?? "",
      password: "",
      roleId: user.role_id,
      status: user.status ?? "ACTIVE",
      phone: user.phone ?? "",
      department: user.department ?? "",
      employeeId: user.employee_id ?? "",
      designation: user.designation ?? "",
      dateOfJoining: user.date_of_joining ?? "",
    });
    setError("");
    setSuccess("");
    setShowEditModal(true);
  };

  const handleCreateUser = async (data: z.infer<typeof createUserSchema>) => {
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    try {
      await api.post(`/tenants/${tenantId}/users/`, {
        email: data.email,
        full_name: data.fullName,
        role_id: data.roleId,
      });

      setSuccess(`User created successfully! Login credentials were emailed to ${data.email}.`);
      setShowCreateModal(false);
      fetchUsersAndRoles();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to create user.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleEditUser = async (data: z.infer<typeof editUserSchema>) => {
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");

    if (!selectedUser) return;

    try {
      const updateData: any = {
        role_id: data.roleId,
        status: data.status,
        first_name: data.firstName,
        last_name: data.lastName,
        phone: data.phone || null,
        department: data.department || null,
        employee_id: data.employeeId || null,
        designation: data.designation || null,
        date_of_joining: data.dateOfJoining || null,
      };

      if (data.password) {
        updateData.password = data.password;
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

  const visibleUsers = users.filter((u) => u.email !== currentUserEmail);

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
          <span className="text-xs text-slate-400 font-medium">Total: {visibleUsers.length}</span>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-3">
            <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-xs text-slate-400">Fetching tenant directory...</span>
          </div>
        ) : visibleUsers.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">No other users registered in this tenant.</p>
            <button
              onClick={handleOpenCreateModal}
              className="mt-3 text-xs text-blue-600 font-semibold hover:underline"
            >
              Register a new account
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3.5 text-left">Username</th>
                  <th className="px-5 py-3.5 text-left">Full Name</th>
                  <th className="px-5 py-3.5 text-left">Email Address</th>
                  <th className="px-5 py-3.5 text-left">Portal Role</th>
                  <th className="px-5 py-3.5 text-left">Department</th>
                  <th className="px-5 py-3.5 text-center">Status</th>
                  <th className="px-5 py-3.5 text-left">Created Date</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 font-medium text-slate-700">{user.username}</td>
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{user.full_name}</td>
                    <td className="px-5 py-3.5 text-slate-600">{user.email}</td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                        {getRoleName(user.role_id)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">{user.department ?? "—"}</td>
                    <td className="px-5 py-3.5 text-center">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${
                          user.status === "ACTIVE"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : user.status === "SUSPENDED"
                            ? "bg-amber-50 text-amber-700 border-amber-200"
                            : user.status === "LOCKED"
                            ? "bg-rose-50 text-rose-700 border-rose-200"
                            : "bg-slate-100 text-slate-700 border-slate-200"
                        }`}
                      >
                        {user.status === "ACTIVE"
                          ? "Active"
                          : user.status === "SUSPENDED"
                          ? "Suspended"
                          : user.status === "LOCKED"
                          ? "Locked"
                          : user.status === "INACTIVE"
                          ? "Inactive"
                          : "Active"}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
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

            <form onSubmit={createForm.handleSubmit(handleCreateUser)} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Full Name *</label>
                <input
                  type="text"
                  {...createForm.register("fullName", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                  placeholder="e.g. Ali Raza"
                  className={`w-full bg-slate-50 border ${createForm.formState.errors.fullName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                />
                {createForm.formState.errors.fullName && <span className="text-[10px] text-red-500">{createForm.formState.errors.fullName.message}</span>}
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Email Address *</label>
                <input
                  type="email"
                  {...createForm.register("email")}
                  placeholder="e.g. ali@adamjeelife.com"
                  className={`w-full bg-slate-50 border ${createForm.formState.errors.email ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                />
                {createForm.formState.errors.email && <span className="text-[10px] text-red-500">{createForm.formState.errors.email.message}</span>}
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Portal Role *</label>
                <select
                  {...createForm.register("roleId")}
                  className={`w-full bg-slate-50 border ${createForm.formState.errors.roleId ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer`}
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              <p className="text-xs text-slate-400">
                A username and password will be generated automatically and emailed to this address.
              </p>

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
      {showEditModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-2xl w-full p-6 space-y-4 my-8">
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

            <form onSubmit={editForm.handleSubmit(handleEditUser)} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Username (Read Only)</label>
                  <input
                    type="text"
                    disabled
                    value={selectedUser.username}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-500 cursor-not-allowed focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Email (Read Only)</label>
                  <input
                    type="email"
                    disabled
                    value={selectedUser.email}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-500 cursor-not-allowed focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">First Name *</label>
                  <input
                    type="text"
                    {...editForm.register("firstName", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.firstName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.firstName && <span className="text-[10px] text-red-500">{editForm.formState.errors.firstName.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Last Name *</label>
                  <input
                    type="text"
                    {...editForm.register("lastName", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.lastName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.lastName && <span className="text-[10px] text-red-500">{editForm.formState.errors.lastName.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Password (Leave blank to keep same)</label>
                  <input
                    type="password"
                    {...editForm.register("password")}
                    placeholder="Enter new password if updating"
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.password ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.password && <span className="text-[10px] text-red-500">{editForm.formState.errors.password.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Portal Role *</label>
                  <select
                    {...editForm.register("roleId")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.roleId ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer`}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Phone</label>
                  <input
                    type="text"
                    {...editForm.register("phone")}
                    placeholder="e.g. +923001234567"
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.phone ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.phone && <span className="text-[10px] text-red-500">{editForm.formState.errors.phone.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Department</label>
                  <input
                    type="text"
                    {...editForm.register("department")}
                    placeholder="e.g. Underwriting"
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.department ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.department && <span className="text-[10px] text-red-500">{editForm.formState.errors.department.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Employee ID</label>
                  <input
                    type="text"
                    {...editForm.register("employeeId")}
                    placeholder="e.g. EMP-1049"
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.employeeId ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.employeeId && <span className="text-[10px] text-red-500">{editForm.formState.errors.employeeId.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Designation</label>
                  <input
                    type="text"
                    {...editForm.register("designation")}
                    placeholder="e.g. Senior Underwriter"
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.designation ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.designation && <span className="text-[10px] text-red-500">{editForm.formState.errors.designation.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Date of Joining</label>
                  <input
                    type="date"
                    {...editForm.register("dateOfJoining")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.dateOfJoining ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all`}
                  />
                  {editForm.formState.errors.dateOfJoining && <span className="text-[10px] text-red-500">{editForm.formState.errors.dateOfJoining.message}</span>}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Account Status *</label>
                  <select
                    {...editForm.register("status")}
                    className={`w-full bg-slate-50 border ${editForm.formState.errors.status ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer`}
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
