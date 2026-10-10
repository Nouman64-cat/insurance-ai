"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { listAgents, Agent } from "@/app/services/agents";
import SourcePicker, { useAcquisitionSources } from "./SourcePicker";
import DemoFillButton from "@/components/DemoFillButton";
import { demoQuickLead } from "@/lib/demoData";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  // Agent to preselect (matched by email) — set when the form is opened from
  // the Copilot after the user already picked who owns the lead.
  defaultAgentEmail?: string | null;
  // Acquisition source to preselect (by id) — the one picked in the Copilot.
  defaultSourceId?: string | null;
  // Agent to preselect by user id — an Agent-type source's own login, which the
  // Copilot passes instead of asking for an agent a second time.
  defaultAgentId?: string | null;
}

export default function CustomerQuickLeadModal({ open, onClose, onSaved, defaultAgentEmail, defaultSourceId, defaultAgentId }: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [acquisitionSourceId, setAcquisitionSourceId] = useState("");
  const sources = useAcquisitionSources(open);
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
      // Users holding the "Agent" RBAC role, as managed on the Users page.
      // Assigning here is what routes the lead to that agent's mobile app.
      listAgents(tenantId).then(setAgentOptions).catch(() => setAgentOptions([]));
    }
  }, [open]);

  // The agent list loads after the form opens, so preselect once it arrives.
  // Keyed on the list rather than the selection, so a later manual change
  // (even back to "Unassigned") is never overridden.
  useEffect(() => {
    if (!open || !defaultAgentEmail) return;
    const match = agentOptions.find((a) => a.email?.toLowerCase() === defaultAgentEmail.toLowerCase());
    if (match) setAssignedAgentId(match.id);
  }, [open, agentOptions, defaultAgentEmail]);

  useEffect(() => {
    if (!open || !defaultAgentId) return;
    if (agentOptions.some((a) => a.id === defaultAgentId)) setAssignedAgentId(defaultAgentId);
  }, [open, agentOptions, defaultAgentId]);

  // Same for the source: its list loads after the form opens, so preselect when
  // it arrives (and never override a later manual change).
  useEffect(() => {
    if (!open || !defaultSourceId) return;
    if (sources.some((src) => src.id === defaultSourceId)) setAcquisitionSourceId(defaultSourceId);
  }, [open, sources, defaultSourceId]);

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
          <div className="flex items-center gap-2">
            <DemoFillButton
              className="!bg-white"
              onFill={() => {
                const lead = demoQuickLead();
                setFirstName(lead.first);
                setLastName(lead.last);
                setPhone(lead.phone);
              }}
            />
            <button
              onClick={onClose}
              className="text-white/80 hover:text-white text-xl font-bold p-1 transition-colors"
            >
              ✕
            </button>
          </div>
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

          <SourcePicker
            sources={sources}
            sourceId={acquisitionSourceId}
            onChange={(src) => {
              setAcquisitionSourceId(src?.id ?? "");
              // An Agent source is a login of its own: picking one hands the lead to that agent's mobile app.
              setAssignedAgentId(src?.user_id && agentOptions.some((a) => a.id === src.user_id) ? src.user_id : "");
            }}
            labelClass="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1"
            selectClass="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          />

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
