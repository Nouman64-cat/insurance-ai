"use client";

import { useEffect, useState } from "react";
import api from "@/app/services/api";
import { Pagination, usePagination } from "@/components/Pagination";

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
  const visible = roles.filter(
    (r) => !needle || r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle)
  );
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

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Role Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Create, edit and delete the roles that can be assigned to users. Roles apply across the whole platform.
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

      {/* What custom roles do and don't do */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-600 leading-relaxed">
        <span className="font-semibold text-slate-700">Built-in roles</span> are recognised by name throughout the platform, so they can&apos;t be
        renamed or deleted (their description can be edited). <span className="font-semibold text-slate-700">Custom roles</span> can be created and
        assigned to users, but the portal&apos;s access rules are tied to the built-in role names — a new role carries no extra access until
        permissions are set up for it.
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-600 font-medium">{success}</div>}

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
          <div className="px-5 py-3 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{roles.length}</span> roles ·{" "}
              <span className="font-semibold text-slate-700">{customCount}</span> custom
            </p>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search roles…"
              className="w-full sm:w-64 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  <th className="px-5 py-3 text-left">Role</th>
                  <th className="px-5 py-3 text-left">Description</th>
                  <th className="px-5 py-3 text-right">Users</th>
                  <th className="px-5 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100/80">
                {pagedRoles.map((role) => (
                  <tr key={role.id} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-800">{role.name}</span>
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            role.is_system
                              ? "bg-slate-100 text-slate-600 border-slate-200"
                              : "bg-blue-50 text-blue-700 border-blue-200"
                          }`}
                        >
                          {role.is_system ? "Built-in" : "Custom"}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-slate-600 max-w-xl">
                      {role.description || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3.5 text-right font-bold text-slate-800">
                      {role.user_count > 0 ? (
                        <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md inline-block">{role.user_count}</span>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center whitespace-nowrap">
                      <div className="inline-flex rounded-lg shadow-sm border border-slate-200 overflow-hidden divide-x divide-slate-200">
                        <button
                          onClick={() => openEdit(role)}
                          className="px-3 py-1.5 text-xs font-bold text-blue-600 bg-white hover:bg-blue-50 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(role)}
                          disabled={role.is_system || deletingId === role.id}
                          title={role.is_system ? "Built-in roles can't be deleted" : undefined}
                          className="px-3 py-1.5 text-xs font-bold text-red-600 bg-white hover:bg-red-50 transition-colors disabled:text-slate-300 disabled:hover:bg-white disabled:cursor-not-allowed"
                        >
                          {deletingId === role.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-slate-400">
                      {roles.length === 0 ? "No roles yet." : "No roles match your search."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination pagination={pagination} noun="roles" inline />
        </div>
      )}

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h3 className="text-base font-bold text-slate-900">{editing ? `Edit Role — ${editing.name}` : "Add Role"}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 p-1" title="Close">✕</button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              {formError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm font-semibold text-red-600">{formError}</div>
              )}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Role name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={!!editing?.is_system}
                  maxLength={50}
                  placeholder="e.g. Compliance Officer"
                  className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none disabled:bg-slate-50 disabled:text-slate-500"
                />
                <p className="text-[11px] text-slate-400">
                  {editing?.is_system
                    ? "Built-in role — the name is fixed because the platform recognises it by name."
                    : "2–50 characters: letters, numbers, spaces, hyphens or underscores."}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  maxLength={500}
                  rows={3}
                  placeholder="What this role is for"
                  className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none resize-none"
                />
                <p className="text-[11px] text-slate-400 text-right">{form.description.length}/500</p>
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  disabled={saving}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-all"
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
