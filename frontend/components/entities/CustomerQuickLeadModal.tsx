"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { listAgents, Agent } from "@/app/services/agents";
import { AcquisitionSource, SOURCE_TYPE_LABELS } from "./customerShared";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export default function CustomerQuickLeadModal({ open, onClose, onSaved }: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [acquisitionSourceId, setAcquisitionSourceId] = useState("");
  const [sources, setSources] = useState<AcquisitionSource[]>([]);
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [agentOptions, setAgentOptions] = useState<Agent[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setFirstName("");
    setLastName("");
    setPhone("");
    setAcquisitionSourceId("");
    setAssignedAgentId("");
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) {
      api
        .get<AcquisitionSource[]>(`/tenants/${tenantId}/acquisition-sources`)
        .then((resp) => setSources(resp.data || []))
        .catch(() => setSources([]));
      // Users holding the "Agent" RBAC role, as managed on the Users page.
      // Assigning here is what routes the lead to that agent's mobile app.
      listAgents(tenantId).then(setAgentOptions).catch(() => setAgentOptions([]));
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) {
      setError("First Name is required for Quick Lead.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const tenantId = localStorage.getItem("tenant_id");
      const payload = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        profile_status: "LEAD",
        acquisition_source_id: acquisitionSourceId || null,
        // Without this the lead is created unassigned and never reaches any
        // agent's mobile app, which filters by assigned_agent_id.
        assigned_agent_id: assignedAgentId || null,
        details: {
          phone: phone.trim(),
          created_via: "Quick Lead Onboarding",
        },
      };
      await api.post(`/tenants/${tenantId}/customers`, payload);
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      onSaved(`Lead '${fullName}' added successfully!`);
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail || "Failed to create quick lead.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden border border-slate-100 transform transition-all">
        <div className="px-6 py-5 bg-gradient-to-r from-blue-600 to-blue-700 text-white flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2">
              <span>🚀</span> Quick Lead Entry
            </h3>
            <p className="text-xs text-blue-100 mt-0.5">
              Capture initial contact info. Diagnostic medical & financial details can be filled later.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white text-xl font-bold p-1 transition-colors"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mx-6 mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 font-medium">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              First Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Tariq"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Last Name
            </label>
            <input
              type="text"
              placeholder="e.g. Mahmood"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Phone Number
            </label>
            <input
              type="text"
              placeholder="e.g. 0300-1234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Lead Generated By (Source)
            </label>
            <select
              value={acquisitionSourceId}
              onChange={(e) => setAcquisitionSourceId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">-- Direct / Unassigned --</option>
              {sources.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name} ({SOURCE_TYPE_LABELS[src.source_type] ?? src.source_type})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Assign to Agent
            </label>
            <select
              value={assignedAgentId}
              onChange={(e) => setAssignedAgentId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">-- Unassigned --</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              {assignedAgentId
                ? "This lead will appear on the agent's mobile app, and they will be notified."
                : "Unassigned leads stay in the portal only — no agent will be notified."}
            </p>
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-all shadow-md disabled:opacity-50"
            >
              {saving ? "Capturing..." : "Register Lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
