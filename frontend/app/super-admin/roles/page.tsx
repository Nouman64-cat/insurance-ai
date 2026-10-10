"use client";

import { useEffect, useState } from "react";
import api from "@/app/services/api";
import { Pagination, usePagination } from "@/components/Pagination";
import DemoFillButton from "@/components/DemoFillButton";
import { demoRole } from "@/lib/demoData";

interface Role {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  user_count: number;
}

interface RoleForm {
  name: string;
  description: string;
}

const emptyForm: RoleForm = { name: "", description: "" };

function errorText(err: any, fallback: string): string {
  const detail = err.response?.data?.detail;
  return Array.isArray(detail) ? detail.map((d: any) => d.msg).join(", ") : detail ?? err.message ?? fallback;
}

export default function RoleManagementPage() {
  const [authorized, setAuthorized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Create / edit modal. `editing` is null when creating.
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [form, setForm] = useState<RoleForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "system" | "custom">("all");

  useEffect(() => {
    if (localStorage.getItem("user_role") !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchRoles();
  }, []);

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const res = await api.get<Role[]>("/roles/management");
      setRoles(res.data);
      setError("");
    } catch (err: any) {
      setError(errorText(err, "Failed to load roles."));
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormError("");
    setShowModal(true);
  };

  const openEdit = (role: Role) => {
    setEditing(role);
    setForm({ name: role.name, description: role.description });
    setFormError("");
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!form.name.trim()) {
      setFormError("Role name is required.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        // A built-in role's name is fixed — only its description is sent.
        const payload = editing.is_system
          ? { description: form.description }
          : { name: form.name, description: form.description };
        await api.put(`/roles/${editing.id}`, payload);
        setSuccess(`Role "${editing.is_system ? editing.name : form.name.trim()}" updated.`);
      } else {
        await api.post("/roles", { name: form.name, description: form.description });
        setSuccess(`Role "${form.name.trim()}" created.`);
      }
      setError("");
      setShowModal(false);
      fetchRoles();
    } catch (err: any) {
      setFormError(errorText(err, "Failed to save role."));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (role: Role) => {
    setSuccess("");
    if (role.user_count > 0) {
      setError(`"${role.name}" is still assigned to ${role.user_count} user(s) — move them to another role before deleting it.`);
      return;
    }
    if (!confirm(`Delete the role "${role.name}"? This can't be undone.`)) return;
    setDeletingId(role.id);
    try {
      await api.delete(`/roles/${role.id}`);
      setError("");
      setSuccess(`Role "${role.name}" deleted.`);
      fetchRoles();
    } catch (err: any) {
      setError(errorText(err, "Failed to delete role."));
    } finally {
      setDeletingId(null);
    }
  };

  const needle = search.trim().toLowerCase();
  const visible = roles
    .filter((r) => typeFilter === "all" || (typeFilter === "system" ? r.is_system : !r.is_system))
    .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle))
    // Built-in roles first, then alphabetical.
    .sort((a, b) => Number(b.is_system) - Number(a.is_system) || a.name.localeCompare(b.name));
  const { pageItems: pagedRoles, pagination } = usePagination(visible);

  if (!authorized) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 text-center font-sans min-h-screen">
        <div className="max-w-md p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-xl">
          <h1 className="text-xl font-bold text-white mb-2">Access Denied</h1>
          <p className="text-slate-400 text-sm mb-6">You do not have SuperAdmin privileges to access the Platform console.</p>
          <a href="/" className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  const customCount = roles.filter((r) => !r.is_system).length;
  const filterTabs = [
    { key: "all" as const, label: "All", count: roles.length },
    { key: "system" as const, label: "Built-in", count: roles.length - customCount },
    { key: "custom" as const, label: "Custom", count: customCount },
  ];

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Role Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Roles that can be assigned to users. Roles apply across the whole platform.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow-md active:scale-95 self-start"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Role
        </button>
      </div>

      {/* Message banners */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 hover:text-red-600" title="Dismiss">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {success && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm px-4 py-3 flex items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </span>
          <p className="flex-1 text-sm font-semibold text-slate-800">{success}</p>
          <button onClick={() => setSuccess("")} className="p-1 text-slate-400 hover:text-slate-600" title="Dismiss">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-slate-400">Loading roles...</span>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Toolbar: type filter + search */}
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 self-start">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setTypeFilter(tab.key)}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    typeFilter === tab.key ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {tab.label}
                  <span className={`ml-1.5 ${typeFilter === tab.key ? "text-white/80" : "text-slate-400"}`}>{tab.count}</span>
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-64">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search roles…"
                className="w-full bg-white border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="py-20 text-center text-slate-400 px-5">
              <p className="text-sm">{roles.length === 0 ? "No roles yet." : "No roles match your filters."}</p>
              {roles.length === 0 ? (
                <button onClick={openCreate} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
                  Create the first role
                </button>
              ) : (
                <button
                  onClick={() => {
                    setSearch("");
                    setTypeFilter("all");
                  }}
                  className="mt-3 text-xs text-blue-600 font-semibold hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400 whitespace-nowrap">
                      <th className="px-5 py-3.5 text-left">Role</th>
                      <th className="px-5 py-3.5 text-left">Description</th>
                      <th className="px-5 py-3.5 text-center">Users</th>
                      <th className="px-5 py-3.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pagedRoles.map((role) => (
                      <tr key={role.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-3.5 w-72">
                          <div className="flex items-center gap-3">
                            <span
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                                role.is_system ? "bg-slate-100 text-slate-500" : "bg-blue-50 text-blue-600"
                              }`}
                            >
                              {role.is_system ? (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                                </svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
                                </svg>
                              )}
                            </span>
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-800 truncate">{role.name}</p>
                              <p className="text-[11px] text-slate-400">{role.is_system ? "Built-in" : "Custom"}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-slate-600">
                          {role.description ? (
                            <p className="line-clamp-2 max-w-2xl" title={role.description}>{role.description}</p>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-center whitespace-nowrap">
                          {role.user_count > 0 ? (
                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                              {role.user_count} {role.user_count === 1 ? "user" : "users"}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">No users</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden divide-x divide-slate-200">
                            <button
                              onClick={() => openEdit(role)}
                              className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-white hover:bg-slate-50 transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDelete(role)}
                              disabled={role.is_system || deletingId === role.id}
                              title={role.is_system ? "Built-in roles can't be deleted" : undefined}
                              className="px-3 py-1.5 text-xs font-semibold text-red-600 bg-white hover:bg-slate-50 transition-colors disabled:text-slate-300 disabled:hover:bg-white disabled:cursor-not-allowed"
                            >
                              {deletingId === role.id ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination pagination={pagination} noun="roles" inline />
            </>
          )}

          {/* What built-in vs custom means — kept with the table it explains */}
          <div className="px-5 py-3 border-t border-slate-100 flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4 shrink-0 text-slate-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
            </svg>
            <p>
              <span className="font-semibold text-slate-600">Built-in</span> roles are recognised by name across the platform, so only their
              description can be edited. <span className="font-semibold text-slate-600">Custom</span> roles can be assigned to users but carry no
              extra access until permissions are set up for them.
            </p>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">{editing ? `Edit Role — ${editing.name}` : "Add Role"}</h3>
              {!editing && (
                <DemoFillButton className="ml-auto mr-3" onFill={() => setForm(demoRole(roles.map((r) => r.name)))} />
              )}
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors" title="Close">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              {formError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs font-medium text-red-600">{formError}</div>
              )}
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Role Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={!!editing?.is_system}
                  maxLength={50}
                  placeholder="e.g. Compliance Officer"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
                />
                <p className="text-[11px] text-slate-400">
                  {editing?.is_system
                    ? "Built-in role — the name is fixed because the platform recognises it by name."
                    : "2–50 characters: letters, numbers, spaces, hyphens or underscores."}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  maxLength={500}
                  rows={3}
                  placeholder="What this role is for"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all resize-none"
                />
                <p className="text-[11px] text-slate-400 text-right">{form.description.length}/500</p>
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {saving && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
                  {editing ? "Save Changes" : "Create Role"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
