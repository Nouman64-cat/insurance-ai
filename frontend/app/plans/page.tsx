"use client";

import { useEffect, useState } from "react";
import {
  InsurancePlan,
  InsurancePlanCreate,
  MedicalExamTier,
  createInsurancePlan,
  deleteInsurancePlan,
  listInsurancePlans,
  seedDefaultPlans,
  updateInsurancePlan,
} from "../services/insurancePlans";

const COLOR_CLASSES: Record<string, { badge: string; accent: string }> = {
  blue: { badge: "bg-blue-50 text-blue-700 border-blue-200", accent: "border-t-blue-500" },
  violet: { badge: "bg-violet-50 text-violet-700 border-violet-200", accent: "border-t-violet-500" },
  amber: { badge: "bg-amber-50 text-amber-700 border-amber-200", accent: "border-t-amber-500" },
  emerald: { badge: "bg-emerald-50 text-emerald-700 border-emerald-200", accent: "border-t-emerald-500" },
  indigo: { badge: "bg-indigo-50 text-indigo-700 border-indigo-200", accent: "border-t-indigo-500" },
};

const COLOR_OPTIONS = Object.keys(COLOR_CLASSES);
const INSURANCE_TYPES = ["TERM_LIFE", "WHOLE_LIFE", "ENDOWMENT", "CHILD_EDUCATION_MARRIAGE", "GROUP_LIFE"] as const;
const STATUSES = ["Draft", "Active", "Archived"] as const;

const STATUS_BADGE: Record<string, string> = {
  Active: "bg-green-50 text-green-700 border-green-200",
  Draft: "bg-slate-100 text-slate-600 border-slate-200",
  Archived: "bg-red-50 text-red-600 border-red-200",
};

function emptyForm(): InsurancePlanCreate {
  return {
    code: "",
    label: "",
    insurance_type: "TERM_LIFE",
    category: "Individual",
    status: "Draft",
    description: "",
    color: "blue",
    entry_age_min: 18,
    entry_age_max: 65,
    entry_age_label: "Proposer",
    dependent_age_min: null,
    dependent_age_max: null,
    term_min_years: 5,
    term_max_years: 30,
    max_maturity_age: 70,
    max_income_multiple: 20,
    min_group_size: null,
    underwriting_basis: null,
    medical_exam_tiers: [{ minSumAssured: 0, tier: "No medical exam required" }],
    required_documents: [],
  };
}

export default function InsurancePlansPage() {
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InsurancePlanCreate>(emptyForm());
  const [docInput, setDocInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    setIsAdmin(localStorage.getItem("user_role") === "Admin");
    const tid = localStorage.getItem("tenant_id");
    setTenantId(tid);
    if (!tid) {
      setError("No active tenant found. Please log in again.");
      setLoading(false);
      return;
    }
    void fetchPlans(tid);
  }, []);

  async function fetchPlans(tid: string) {
    setLoading(true);
    setError("");
    try {
      setPlans(await listInsurancePlans(tid));
    } catch (err: any) {
      setError(err.message ?? "Failed to load insurance plans.");
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setDocInput("");
    setFormError("");
    setShowModal(true);
  }

  function openEdit(plan: InsurancePlan) {
    setEditingId(plan.id);
    setForm({
      code: plan.code,
      label: plan.label,
      insurance_type: plan.insurance_type,
      category: plan.category,
      status: plan.status,
      description: plan.description,
      color: plan.color,
      entry_age_min: plan.entry_age_min,
      entry_age_max: plan.entry_age_max,
      entry_age_label: plan.entry_age_label,
      dependent_age_min: plan.dependent_age_min,
      dependent_age_max: plan.dependent_age_max,
      term_min_years: plan.term_min_years,
      term_max_years: plan.term_max_years,
      max_maturity_age: plan.max_maturity_age,
      max_income_multiple: plan.max_income_multiple,
      min_group_size: plan.min_group_size,
      underwriting_basis: plan.underwriting_basis,
      medical_exam_tiers: plan.medical_exam_tiers,
      required_documents: plan.required_documents,
    });
    setDocInput(plan.required_documents.join(", "));
    setFormError("");
    setShowModal(true);
  }

  async function handleSeedDefaults() {
    if (!tenantId) return;
    setLoading(true);
    try {
      await seedDefaultPlans(tenantId);
      await fetchPlans(tenantId);
    } catch (err: any) {
      setError(err.message ?? "Failed to seed default plans.");
      setLoading(false);
    }
  }

  async function handleDelete(plan: InsurancePlan) {
    if (!tenantId) return;
    if (!window.confirm(`Delete plan "${plan.label}"? This cannot be undone.`)) return;
    try {
      await deleteInsurancePlan(tenantId, plan.id);
      await fetchPlans(tenantId);
    } catch (err: any) {
      setError(err.message ?? "Failed to delete plan.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    setFormError("");

    const documents = docInput
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const payload: InsurancePlanCreate = { ...form, required_documents: documents };

    try {
      if (editingId) {
        const { code, ...update } = payload;
        await updateInsurancePlan(tenantId, editingId, update);
      } else {
        await createInsurancePlan(tenantId, payload);
      }
      setShowModal(false);
      await fetchPlans(tenantId);
    } catch (err: any) {
      setFormError(err.message ?? "Failed to save plan.");
    } finally {
      setSaving(false);
    }
  }

  function setField<K extends keyof InsurancePlanCreate>(key: K, value: InsurancePlanCreate[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function updateTier(index: number, patch: Partial<MedicalExamTier>) {
    setForm((f) => ({
      ...f,
      medical_exam_tiers: f.medical_exam_tiers.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    }));
  }

  function addTier() {
    setForm((f) => ({ ...f, medical_exam_tiers: [...f.medical_exam_tiers, { minSumAssured: 0, tier: "" }] }));
  }

  function removeTier(index: number) {
    setForm((f) => ({ ...f, medical_exam_tiers: f.medical_exam_tiers.filter((_, i) => i !== index) }));
  }

  const individual = plans.filter((p) => p.category === "Individual");
  const group = plans.filter((p) => p.category === "Group");

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Insurance Plans</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Your tenant&apos;s catalog of plan types, their eligibility rules, and required documents.
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            {plans.length === 0 && !loading && (
              <button
                onClick={handleSeedDefaults}
                className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Load default catalog
              </button>
            )}
            <button
              onClick={openCreate}
              className="text-sm font-semibold px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              + New Plan
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500 py-10 text-center">Loading plans…</div>
      ) : plans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
          <p className="text-sm text-slate-600 font-medium">No insurance plans defined yet.</p>
          {isAdmin ? (
            <p className="text-xs text-slate-500 mt-1">
              Use <span className="font-semibold">Load default catalog</span> to start from the standard plans, or{" "}
              <span className="font-semibold">+ New Plan</span> to define your own.
            </p>
          ) : (
            <p className="text-xs text-slate-500 mt-1">Ask your administrator to configure the plan catalog.</p>
          )}
        </div>
      ) : (
        <>
          {individual.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">Individual Plans</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {individual.map((plan) => (
                  <PlanCard key={plan.id} plan={plan} isAdmin={isAdmin} onEdit={openEdit} onDelete={handleDelete} />
                ))}
              </div>
            </section>
          )}

          {group.length > 0 && (
            <section className="space-y-3 pt-2">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">Group / Business Plans</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {group.map((plan) => (
                  <PlanCard key={plan.id} plan={plan} isAdmin={isAdmin} onEdit={openEdit} onDelete={handleDelete} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {showModal && (
        <PlanFormModal
          form={form}
          editingId={editingId}
          docInput={docInput}
          saving={saving}
          formError={formError}
          onClose={() => setShowModal(false)}
          onSubmit={handleSubmit}
          setField={setField}
          setDocInput={setDocInput}
          updateTier={updateTier}
          addTier={addTier}
          removeTier={removeTier}
        />
      )}
    </div>
  );
}

// ── Plan card ─────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  isAdmin,
  onEdit,
  onDelete,
}: {
  plan: InsurancePlan;
  isAdmin: boolean;
  onEdit: (p: InsurancePlan) => void;
  onDelete: (p: InsurancePlan) => void;
}) {
  const colors = COLOR_CLASSES[plan.color] ?? COLOR_CLASSES.blue;
  const tiers = [...plan.medical_exam_tiers].sort((a, b) => a.minSumAssured - b.minSumAssured);

  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-t-4 ${colors.accent} shadow-sm overflow-hidden`}>
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900">{plan.label}</h2>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS_BADGE[plan.status] ?? ""}`}>
              {plan.status}
            </span>
          </div>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${colors.badge}`}>
            {plan.code}
          </span>
        </div>

        <p className="text-sm text-slate-600 leading-relaxed">{plan.description}</p>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 pt-2 border-t border-slate-100">
          <Field label={`${plan.entry_age_label} Entry Age`} value={`${plan.entry_age_min}–${plan.entry_age_max} years`} />
          <Field label="Policy Term" value={`${plan.term_min_years}–${plan.term_max_years} years`} />
          <Field label="Max Maturity Age" value={`${plan.max_maturity_age} years`} />
          <Field label="Max Coverage" value={`${plan.max_income_multiple}× annual income`} />
          {plan.dependent_age_min != null && plan.dependent_age_max != null && (
            <div className="col-span-2">
              <FieldInline label="Dependent Age (at entry)" value={`${plan.dependent_age_min}–${plan.dependent_age_max} years`} />
            </div>
          )}
          {plan.min_group_size != null && (
            <div className="col-span-2">
              <FieldInline label="Minimum Group Size" value={`${plan.min_group_size} employees`} />
            </div>
          )}
        </div>

        {tiers.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Medical Exam Thresholds (PKR)
            </span>
            <div className="space-y-1">
              {tiers.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">
                    {i === tiers.length - 1
                      ? `≥ PKR ${t.minSumAssured.toLocaleString()}`
                      : `PKR ${t.minSumAssured.toLocaleString()} – ${(tiers[i + 1].minSumAssured - 1).toLocaleString()}`}
                  </span>
                  <span className="font-semibold text-slate-700">{t.tier}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {plan.underwriting_basis && (
          <div className="pt-2 border-t border-slate-100">
            <FieldInline label="Underwriting Basis" value={plan.underwriting_basis} />
          </div>
        )}

        {plan.required_documents.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Required Documents (Underwriting)
            </span>
            <div className="flex flex-wrap gap-1.5">
              {plan.required_documents.map((doc) => (
                <span key={doc} className="text-xs px-2 py-1 rounded-lg border bg-slate-50 text-slate-700 border-slate-200">
                  {doc}
                </span>
              ))}
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="pt-3 border-t border-slate-100 flex items-center gap-2">
            <button
              onClick={() => onEdit(plan)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(plan)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function FieldInline({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </>
  );
}

// ── Form modal ────────────────────────────────────────────────────────────────

function PlanFormModal({
  form,
  editingId,
  docInput,
  saving,
  formError,
  onClose,
  onSubmit,
  setField,
  setDocInput,
  updateTier,
  addTier,
  removeTier,
}: {
  form: InsurancePlanCreate;
  editingId: string | null;
  docInput: string;
  saving: boolean;
  formError: string;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  setField: <K extends keyof InsurancePlanCreate>(key: K, value: InsurancePlanCreate[K]) => void;
  setDocInput: (v: string) => void;
  updateTier: (index: number, patch: Partial<MedicalExamTier>) => void;
  addTier: () => void;
  removeTier: (index: number) => void;
}) {
  const inputCls =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40";
  const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={onSubmit} className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900">{editingId ? "Edit Plan" : "New Insurance Plan"}</h2>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
              ×
            </button>
          </div>

          {formError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Code {editingId && <span className="text-slate-400">(immutable)</span>}</label>
              <input
                className={inputCls}
                value={form.code}
                disabled={!!editingId}
                onChange={(e) => setField("code", e.target.value)}
                placeholder="TERM_LIFE"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Label</label>
              <input className={inputCls} value={form.label} onChange={(e) => setField("label", e.target.value)} placeholder="Term Life" required />
            </div>
            <div>
              <label className={labelCls}>Insurance Type</label>
              <select className={inputCls} value={form.insurance_type} onChange={(e) => setField("insurance_type", e.target.value as any)}>
                {INSURANCE_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Category</label>
              <select className={inputCls} value={form.category} onChange={(e) => setField("category", e.target.value as any)}>
                <option value="Individual">Individual</option>
                <option value="Group">Group</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select className={inputCls} value={form.status} onChange={(e) => setField("status", e.target.value as any)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Accent Colour</label>
              <select className={inputCls} value={form.color} onChange={(e) => setField("color", e.target.value)}>
                {COLOR_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Description</label>
            <textarea className={inputCls} rows={3} value={form.description} onChange={(e) => setField("description", e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField label="Entry Age Min" value={form.entry_age_min} onChange={(v) => setField("entry_age_min", v)} />
            <NumField label="Entry Age Max" value={form.entry_age_max} onChange={(v) => setField("entry_age_max", v)} />
            <div>
              <label className={labelCls}>Entry Age Label</label>
              <input className={inputCls} value={form.entry_age_label} onChange={(e) => setField("entry_age_label", e.target.value)} />
            </div>
            <NumField label="Term Min (yrs)" value={form.term_min_years} onChange={(v) => setField("term_min_years", v)} />
            <NumField label="Term Max (yrs)" value={form.term_max_years} onChange={(v) => setField("term_max_years", v)} />
            <NumField label="Max Maturity Age" value={form.max_maturity_age} onChange={(v) => setField("max_maturity_age", v)} />
            <NumField label="Max Income Multiple" value={form.max_income_multiple} onChange={(v) => setField("max_income_multiple", v)} step="any" />
            <NumField
              label="Dependent Age Min"
              value={form.dependent_age_min}
              nullable
              onChange={(v) => setField("dependent_age_min", v)}
            />
            <NumField
              label="Dependent Age Max"
              value={form.dependent_age_max}
              nullable
              onChange={(v) => setField("dependent_age_max", v)}
            />
          </div>

          {form.category === "Group" && (
            <div className="grid grid-cols-2 gap-4">
              <NumField label="Min Group Size" value={form.min_group_size} nullable onChange={(v) => setField("min_group_size", v)} />
              <div>
                <label className={labelCls}>Underwriting Basis</label>
                <input
                  className={inputCls}
                  value={form.underwriting_basis ?? ""}
                  onChange={(e) => setField("underwriting_basis", e.target.value || null)}
                />
              </div>
            </div>
          )}

          {/* Medical exam tiers */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={labelCls + " mb-0"}>Medical Exam Tiers</label>
              <button type="button" onClick={addTier} className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                + Add tier
              </button>
            </div>
            <div className="space-y-2">
              {form.medical_exam_tiers.map((tier, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="number"
                    className={inputCls + " w-40"}
                    value={tier.minSumAssured}
                    onChange={(e) => updateTier(i, { minSumAssured: Number(e.target.value) })}
                    placeholder="Min sum assured"
                  />
                  <input
                    className={inputCls}
                    value={tier.tier}
                    onChange={(e) => updateTier(i, { tier: e.target.value })}
                    placeholder="Requirement"
                  />
                  <button type="button" onClick={() => removeTier(i)} className="text-red-500 hover:text-red-700 px-2">
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className={labelCls}>Required Documents (comma-separated)</label>
            <input className={inputCls} value={docInput} onChange={(e) => setDocInput(e.target.value)} placeholder="CNIC, Medical Report, Salary Slip" />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="text-sm font-semibold px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="text-sm font-semibold px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Create plan"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  nullable,
  step,
}: {
  label: string;
  value: number | null;
  onChange: (v: any) => void;
  nullable?: boolean;
  step?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1">{label}</label>
      <input
        type="number"
        step={step}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(nullable ? null : 0);
          } else {
            onChange(Number(raw));
          }
        }}
      />
    </div>
  );
}
