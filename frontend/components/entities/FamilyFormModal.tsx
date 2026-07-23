"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { listBranches, Branch } from "@/app/services/branches";
import { listAgents, Agent } from "@/app/services/agents";
import { PAKISTAN_PROVINCES } from "@/lib/pakistanProvinces";

export interface FamilyFormValue {
  id: string;
  name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  household_declared_income: number | null;
  branch_id?: string | null;
  assigned_agent_id?: string | null;
  city?: string | null;
  province?: string | null;
}

interface Props {
  open: boolean;
  /** "quick" = name + contact only; "full" = complete household entry */
  mode: "quick" | "full";
  /** Provide a family to edit (full mode). Omit to create. */
  family?: FamilyFormValue | null;
  onClose: () => void;
  /**
   * Called after a successful create/update.
   * `entity.isNew` is true for freshly created records (so callers can route to
   * the Manage page to continue setup — adding members and a policy).
   */
  onSaved: (message: string, entity: { id: string; isNew: boolean }) => void;
}

export default function FamilyFormModal({ open, mode, family, onClose, onSaved }: Props) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Full entry fields
  const [name, setName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [householdIncome, setHouseholdIncome] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [branchId, setBranchId] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [agentOptions, setAgentOptions] = useState<Agent[]>([]);

  const editingId = family?.id ?? null;

  useEffect(() => {
    if (!open || mode !== "full") return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    listBranches(tenantId).then(setBranchOptions).catch(() => setBranchOptions([]));
    listAgents(tenantId).then(setAgentOptions).catch(() => setAgentOptions([]));
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    setError("");
    if (mode === "full" && family) {
      setName(family.name);
      setContactPerson(family.contact_person || "");
      setContactEmail(family.contact_email || "");
      setContactPhone(family.contact_phone || "");
      setHouseholdIncome(family.household_declared_income?.toString() || "");
      setCity(family.city || "");
      setProvince(family.province || "");
      setBranchId(family.branch_id || "");
      setAssignedAgentId(family.assigned_agent_id || "");
    } else {
      setName("");
      setContactPerson("");
      setContactEmail("");
      setContactPhone("");
      setHouseholdIncome("");
      setCity("");
      setProvince("");
      setBranchId("");
      setAssignedAgentId("");
    }
  }, [open, mode, family]);

  if (!open) return null;

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Family name is required.");
      return;
    }
    setSaving(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    try {
      const resp = await api.post(`/tenants/${tenantId}/families`, {
        name: name.trim(),
        contact_person: contactPerson.trim() || null,
        contact_phone: contactPhone.trim() || null,
      });
      onSaved(`Family "${name.trim()}" added — add members and a policy when ready.`, { id: resp.data?.id, isNew: true });
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to add family.");
    } finally {
      setSaving(false);
    }
  };

  const handleFullSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    const tenantId = localStorage.getItem("tenant_id");
    try {
      const payload = {
        name,
        contact_person: contactPerson || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        household_declared_income: householdIncome ? parseFloat(householdIncome) : null,
        city: city || null,
        province: province || null,
        branch_id: branchId || null,
        assigned_agent_id: assignedAgentId || null,
      };
      if (editingId) {
        await api.patch(`/tenants/${tenantId}/families/${editingId}`, payload);
        onSaved(`Family "${name}" updated successfully!`, { id: editingId, isNew: false });
      } else {
        const resp = await api.post(`/tenants/${tenantId}/families`, payload);
        onSaved(`Family "${name}" created successfully!`, { id: resp.data?.id, isNew: true });
      }
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to save family group.");
    } finally {
      setSaving(false);
    }
  };

  if (mode === "quick") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-sm w-full p-6 space-y-4 my-8">
          <div className="flex justify-between items-center border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">Quick Family</h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 font-medium">{error}</div>}
          <form onSubmit={handleQuickSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Family Name *</label>
              <input
                type="text" required value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Rehman Family"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Contact Person (Proposer)</label>
              <input
                type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
                placeholder="e.g. Asad Rehman"
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
            <p className="text-[11px] text-slate-400">
              Adds the household now — add members, household income, and a policy later via "Complete Detail" or the Manage page.
            </p>
            <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
              <button
                type="button" onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit" disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 rounded-lg transition-colors"
              >
                {saving ? "Saving…" : "Add Family"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
        <div className="flex justify-between items-center border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900">{editingId ? "Edit Family" : "Add New Family"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 font-medium">{error}</div>}

        <form onSubmit={handleFullSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-600">Family Name *</label>
            <input
              type="text" required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rehman Family"
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-600">Contact Person (Proposer)</label>
            <input
              type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
              placeholder="e.g. Asad Rehman"
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Contact Email</label>
              <input
                type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                placeholder="family@example.com"
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

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-600">Household Annual Income (PKR)</label>
            <input
              type="number" value={householdIncome} onChange={(e) => setHouseholdIncome(e.target.value)}
              placeholder="2400000"
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            />
            <p className="text-[11px] text-slate-400">
              Used for the floater's income-eligibility check — children and non-earning members don't have their own income.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">City</label>
              <input
                type="text" value={city} onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Lahore"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Province</label>
              <select
                value={province} onChange={(e) => setProvince(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              >
                <option value="">Select province</option>
                {PAKISTAN_PROVINCES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Branch</label>
              <select
                value={branchId} onChange={(e) => setBranchId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              >
                <option value="">Unassigned</option>
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Assigned Agent</label>
              <select
                value={assignedAgentId} onChange={(e) => setAssignedAgentId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              >
                <option value="">Unassigned</option>
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              type="button" onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={saving}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors flex items-center gap-1.5"
            >
              {saving && (
                <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {editingId ? "Update Family" : "Create Family"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
