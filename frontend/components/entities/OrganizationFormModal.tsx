"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";

export interface OrganizationFormValue {
  id: string;
  name: string;
  registration_number: string | null;
  industry: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

interface Props {
  open: boolean;
  /** "quick" = name + contact only; "full" = complete corporate entry */
  mode: "quick" | "full";
  /** Provide an organization to edit (full mode). Omit to create. */
  organization?: OrganizationFormValue | null;
  onClose: () => void;
  /**
   * Called after a successful create/update.
   * `entity.isNew` is true for freshly created records (so callers can route to
   * the Manage page to continue setup — the employee census and master policy).
   */
  onSaved: (message: string, entity: { id: string; isNew: boolean }) => void;
}

export default function OrganizationFormModal({ open, mode, organization, onClose, onSaved }: Props) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [industry, setIndustry] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const editingId = organization?.id ?? null;

  useEffect(() => {
    if (!open) return;
    setError("");
    if (mode === "full" && organization) {
      setName(organization.name);
      setRegistrationNumber(organization.registration_number || "");
      setIndustry(organization.industry || "");
      setContactPerson(organization.contact_person || "");
      setContactEmail(organization.contact_email || "");
      setContactPhone(organization.contact_phone || "");
    } else {
      setName("");
      setRegistrationNumber("");
      setIndustry("");
      setContactPerson("");
      setContactEmail("");
      setContactPhone("");
    }
  }, [open, mode, organization]);

  if (!open) return null;

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Company name is required.");
      return;
    }
    setSaving(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    try {
      const resp = await api.post(`/tenants/${tenantId}/organizations`, {
        name: name.trim(),
        contact_person: contactPerson.trim() || null,
        contact_phone: contactPhone.trim() || null,
      });
      onSaved(`Organization "${name.trim()}" added — set up its master policy when ready.`, { id: resp.data?.id, isNew: true });
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to add organization.");
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
        registration_number: registrationNumber || null,
        industry: industry || null,
        contact_person: contactPerson || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
      };
      if (editingId) {
        await api.patch(`/tenants/${tenantId}/organizations/${editingId}`, payload);
        onSaved(`Organization "${name}" updated successfully!`, { id: editingId, isNew: false });
      } else {
        const resp = await api.post(`/tenants/${tenantId}/organizations`, payload);
        onSaved(`Organization "${name}" created successfully!`, { id: resp.data?.id, isNew: true });
      }
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to save organization.");
    } finally {
      setSaving(false);
    }
  };

  if (mode === "quick") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-sm w-full p-6 space-y-4 my-8">
          <div className="flex justify-between items-center border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">Quick Organization</h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 font-medium">{error}</div>}
          <form onSubmit={handleQuickSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Company Name *</label>
              <input
                type="text" required value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. TechPak Solutions"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Contact Person</label>
              <input
                type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
                placeholder="e.g. Ali Raza (HR Manager)"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">Contact Phone</label>
              <input
                type="text" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+92 300 1234567"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <p className="text-[11px] text-slate-400">
              Adds the account now — fill in registration/industry details and set up its master policy later via "Complete Detail" or the Manage page.
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
                {saving ? "Saving…" : "Add Organization"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-5 my-8">
        <div className="flex justify-between items-center border-b border-slate-100 pb-4">
          <h3 className="text-lg font-bold text-slate-900">{editingId ? "Edit Organization" : "Add New Organization"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 bg-slate-50 hover:bg-slate-100 rounded-full p-1 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 font-medium">{error}</div>}

        <form onSubmit={handleFullSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">Company Name *</label>
            <input
              type="text" required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. TechPak Solutions"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">Registration No. (NTN)</label>
              <input
                type="text" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)}
                placeholder="e.g. 1234567-8"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">Industry</label>
              <input
                type="text" value={industry} onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. Textiles"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">Contact Person</label>
            <input
              type="text" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
              placeholder="e.g. Ali Raza (HR Manager)"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">Contact Email</label>
              <input
                type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                placeholder="hr@company.com"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">Contact Phone</label>
              <input
                type="text" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+92 300 1234567"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button" onClick={onClose}
              className="px-5 py-2.5 text-sm font-bold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={saving}
              className="px-5 py-2.5 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 rounded-xl transition-colors flex items-center gap-2 shadow-sm"
            >
              {saving && (
                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {editingId ? "Update Organization" : "Create Organization"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
