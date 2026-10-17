"use client";

import { useEffect, useRef, useState } from "react";
import {
  InsurancePlan,
  InsurancePlanCreate,
  MedicalExamTier,
  createInsurancePlan,
  deleteInsurancePlan,
  listInsurancePlans,
  removePolicyWording,
  uploadPolicyWording,
  seedDefaultPlans,
  updateInsurancePlan,
} from "../services/insurancePlans";
import { Pagination, usePagination } from "@/components/Pagination";
import { tx } from "@/lib/i18n/tx";
import PlanSurrenderDetails, { surrenderStatus } from "@/components/PlanSurrenderDetails";
import PlanClaimsDetails from "@/components/PlanClaimsDetails";

const COLOR_CLASSES: Record<string, { badge: string; accent: string }> = {
  blue: { badge: "bg-blue-50 text-blue-700 border-blue-200", accent: "border-t-blue-500" },
  violet: { badge: "bg-blue-50 text-blue-700 border-blue-200", accent: "border-t-blue-500" },
  amber: { badge: "bg-amber-50 text-amber-700 border-amber-200", accent: "border-t-amber-500" },
  emerald: { badge: "bg-blue-50 text-blue-700 border-blue-200", accent: "border-t-blue-500" },
  indigo: { badge: "bg-blue-50 text-blue-700 border-blue-200", accent: "border-t-blue-500" },
  rose: { badge: "bg-rose-50 text-rose-700 border-rose-200", accent: "border-t-rose-500" },
};

const TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term life", WHOLE_LIFE: "Whole life", ENDOWMENT: "Endowment",
  CHILD_EDUCATION_MARRIAGE: "Education & marriage", GROUP_LIFE: "Group life",
  SAVINGS: "Savings", SINGLE_PREMIUM: "Single premium", HEALTH_CASH: "Health cash",
};
const typeLabel = (type: string) => TYPE_LABELS[type] ?? type.toLowerCase().replaceAll("_", " ");

const COLOR_OPTIONS = Object.keys(COLOR_CLASSES);
const INSURANCE_TYPES = [
  "TERM_LIFE",
  "WHOLE_LIFE",
  "ENDOWMENT",
  "CHILD_EDUCATION_MARRIAGE",
  "GROUP_LIFE",
  "SAVINGS",
  "SINGLE_PREMIUM",
  "HEALTH_CASH",
] as const;
const PRODUCT_CATEGORIES = ["Conventional", "Takaful", "Bancassurance"] as const;
const PRODUCT_CATEGORY_BADGE: Record<string, string> = {
  Conventional: "bg-slate-100 text-slate-700 border-slate-200",
  Takaful: "bg-blue-50 text-blue-700 border-blue-200",
  Bancassurance: "bg-blue-50 text-blue-700 border-blue-200",
};
const STATUSES = ["Draft", "Active", "Archived"] as const;

const STATUS_BADGE: Record<string, string> = {
  Active: "bg-blue-50 text-blue-700 border-blue-200",
  Draft: "bg-slate-100 text-slate-600 border-slate-200",
  Archived: "bg-red-50 text-red-600 border-red-200",
};

function emptyForm(): InsurancePlanCreate {
  return {
    code: "",
    label: "",
    insurance_type: "TERM_LIFE",
    category: "Individual",
    product_category: "Conventional",
    partner_bank: null,
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
    base_premium_rate: 0,
    smoker_factor: 1,
    rate_version: "v1",
    min_group_size: null,
    underwriting_basis: null,
    medical_exam_tiers: [{ minSumAssured: 0, tier: "No medical exam required" }],
    required_documents: [],
  };
}

const ALL = "All";

function PlanCatalog() {
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

  const [viewingPlan, setViewingPlan] = useState<InsurancePlan | null>(null);
  const [search, setSearch] = useState("");
  const [productCategoryFilter, setProductCategoryFilter] = useState<string>(ALL);
  const [insuranceTypeFilter, setInsuranceTypeFilter] = useState<string>(ALL);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);

  useEffect(() => {
    setIsAdmin(localStorage.getItem("user_role") === "Admin");
    const tid = localStorage.getItem("tenant_id");
    setTenantId(tid);
    if (!tid) {
      setError(tx("No active tenant found. Please log in again."));
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
      setError(err.message ?? tx("Failed to load insurance plans."));
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
      product_category: plan.product_category,
      partner_bank: plan.partner_bank,
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
      base_premium_rate: plan.base_premium_rate,
      smoker_factor: plan.smoker_factor,
      rate_version: plan.rate_version,
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
      setError(err.message ?? tx("Failed to seed default plans."));
      setLoading(false);
    }
  }

  async function handleDelete(plan: InsurancePlan) {
    if (!tenantId) return;
    if (!window.confirm(tx("Delete plan \"{0}\"? This cannot be undone.", { 0: plan.label }))) return;
    try {
      await deleteInsurancePlan(tenantId, plan.id);
      await fetchPlans(tenantId);
    } catch (err: any) {
      setError(err.message ?? tx("Failed to delete plan."));
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
      setFormError(err.message ?? tx("Failed to save plan."));
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

  const q = search.trim().toLowerCase();
  const filteredPlans = plans
    .filter((p) => productCategoryFilter === ALL || p.product_category === productCategoryFilter)
    .filter((p) => insuranceTypeFilter === ALL || p.insurance_type === insuranceTypeFilter)
    .filter((p) => categoryFilter === ALL || p.category === categoryFilter)
    .filter((p) => statusFilter === ALL || p.status === statusFilter)
    .filter(
      (p) =>
        !q ||
        p.label.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.partner_bank ?? "").toLowerCase().includes(q),
    )
    .sort((a, b) => a.product_category.localeCompare(b.product_category) || a.label.localeCompare(b.label));

  const hasActiveFilters =
    !!q || productCategoryFilter !== ALL || insuranceTypeFilter !== ALL || categoryFilter !== ALL || statusFilter !== ALL;

  function clearFilters() {
    setSearch("");
    setProductCategoryFilter(ALL);
    setInsuranceTypeFilter(ALL);
    setCategoryFilter(ALL);
    setStatusFilter(ALL);
  }

  const { pageItems: pagedPlans, pagination: planPagination } = usePagination(filteredPlans);

  return (
    <div className="px-5 py-6 sm:px-8 space-y-6 max-w-screen-2xl mx-auto w-full font-sans">
      {/* Header */}
      <div className="relative flex flex-wrap items-center justify-between gap-5 overflow-hidden rounded-2xl border border-blue-100 bg-blue-50/70 px-6 py-7 sm:px-8">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{tx("Product catalog")}</p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-slate-900 tracking-tight">{tx("Insurance Plans")}</h1>
          <p className="text-sm text-slate-500 mt-2 max-w-xl leading-6">
            {tx("Explore coverage options, eligibility and early-exit terms in one place.")}
          </p>
          {!loading && <div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="rounded-lg border border-blue-100 bg-white/80 px-3 py-1.5 text-slate-600">{plans.length} {tx("plans")}</span><span className="flex items-center gap-2 rounded-lg border border-blue-100 bg-white/80 px-3 py-1.5 text-slate-600"><span className="h-1.5 w-1.5 rounded-full bg-blue-400" />{plans.filter(p => p.status === "Active").length} {tx("active")}</span></div>}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            {plans.length === 0 && !loading && (
              <button
                onClick={handleSeedDefaults}
                className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                {tx("Load default catalog")}
              </button>
            )}
            <button
              onClick={openCreate}
              className="text-sm font-semibold px-4 py-3 rounded-xl border border-blue-200 bg-white/90 text-slate-700 hover:bg-blue-100 shadow-sm"
            >
              {tx("+ New Plan")}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500 py-10 text-center">{tx("Loading plans…")}</div>
      ) : plans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
          <p className="text-sm text-slate-600 font-medium">{tx("No insurance plans defined yet.")}</p>
          {isAdmin ? (
            <p className="text-xs text-slate-500 mt-1">
              {tx("Use")}{" "}<span className="font-semibold">{tx("Load default catalog")}</span>{" "}{tx("to start from the standard plans, or")}{" "}
              <span className="font-semibold">{tx("+ New Plan")}</span>{" "}{tx("to define your own.")}
            </p>
          ) : (
            <p className="text-xs text-slate-500 mt-1">{tx("Ask your administrator to configure the plan catalog.")}</p>
          )}
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={tx("Plan filters")}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
              <div role="group" aria-label={tx("Distribution channel")} className="flex flex-wrap gap-1">{[ALL,...PRODUCT_CATEGORIES].map(channel => <button key={channel} type="button" aria-pressed={productCategoryFilter === channel} onClick={() => setProductCategoryFilter(channel)} className={`rounded-lg px-3 py-2 text-xs font-medium transition ${productCategoryFilter === channel ? "border border-blue-100 bg-blue-50 text-slate-700" : "border border-transparent text-slate-400 hover:bg-slate-50 hover:text-slate-600"}`}>{tx(channel === ALL ? "All channels" : channel)}</button>)}</div>
              <span className="text-xs text-slate-400">{filteredPlans.length} {tx("matching plans")}</span>
            </div>
            <div className="grid items-center gap-3 p-4 sm:px-5 lg:grid-cols-[minmax(240px,1fr)_auto_auto_auto_auto]">
              <div className="relative"><svg className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input aria-label={tx("Search insurance plans")} value={search} onChange={e => setSearch(e.target.value)} placeholder={tx("Find a plan or partner bank…")} className="w-full rounded-xl border border-slate-200 bg-slate-50/60 py-2.5 pl-10 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100" /></div>
              <FilterSelect value={insuranceTypeFilter} onChange={setInsuranceTypeFilter} label={tx("Coverage")} options={INSURANCE_TYPES} />
              <FilterSelect value={categoryFilter} onChange={setCategoryFilter} label={tx("Customer")} options={["Individual","Group"]} />
              <FilterSelect value={statusFilter} onChange={setStatusFilter} label={tx("Status")} options={STATUSES} />
              {hasActiveFilters && <button onClick={clearFilters} className="px-2 py-2 text-xs font-medium text-slate-500 hover:text-slate-800">{tx("Reset filters")}</button>}
            </div>
          </section>

          {filteredPlans.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center text-sm text-slate-500">
              {tx("No plans match your search/filters.")}
            </div>
          ) : (
            <>
              <PlansTable plans={pagedPlans} onView={setViewingPlan} />
              <Pagination pagination={planPagination} noun={tx("plans")} />
            </>
          )}
        </>
      )}

      {viewingPlan && (
        <PlanDetailDrawer
          plan={viewingPlan}
          isAdmin={isAdmin}
          onClose={() => setViewingPlan(null)}
          onEdit={(p) => {
            setViewingPlan(null);
            openEdit(p);
          }}
          onDelete={(p) => {
            setViewingPlan(null);
            void handleDelete(p);
          }}
        />
      )}

      {showModal && (
        <PlanFormModal
          form={form}
          editingId={editingId}
          docInput={docInput}
          wording={
            editingId
              ? {
                  filename: plans.find((p) => p.id === editingId)?.policy_wording_filename ?? null,
                  onUpload: async (file: File) => {
                    const updated = await uploadPolicyWording(tenantId!, editingId, file);
                    setPlans((all) => all.map((p) => (p.id === updated.id ? updated : p)));
                  },
                  onRemove: async () => {
                    const updated = await removePolicyWording(tenantId!, editingId);
                    setPlans((all) => all.map((p) => (p.id === updated.id ? updated : p)));
                  },
                }
              : null
          }
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

// ── Filter select ────────────────────────────────────────────────────────────

function FilterSelect({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: readonly string[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`text-xs rounded-xl border px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 ${
        value === ALL ? "border-slate-200 text-slate-500" : "border-blue-200 text-slate-700 bg-blue-50/50 font-medium"
      }`}
    >
      <option value={ALL}>{label}{tx(": All")}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {tx(TYPE_LABELS[o] ?? o)}
        </option>
      ))}
    </select>
  );
}

// ── Plans table ───────────────────────────────────────────────────────────────

const TIER_SHORT_LABELS: Record<string, string> = {
  "No medical exam required": "None",
  "Paramedical exam required": "Paramedical",
  "Full medical exam + financial underwriting required": "Full medical",
  "No medical exam required — guaranteed issue": "Guaranteed issue",
};

function shortTierLabel(tier: string): string {
  return TIER_SHORT_LABELS[tier] ?? tier;
}

function formatPKRCompact(n: number): string {
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${n % 1_000 === 0 ? n / 1_000 : (n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function PlansTable({ plans, onView }: { plans: InsurancePlan[]; onView: (p: InsurancePlan) => void }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={tx("Insurance plan catalog")}>
    <div className="overflow-x-auto"><table className="w-full min-w-[1040px] text-left text-sm">
      <thead><tr className="border-b border-slate-100 bg-slate-50/60 text-[10px] font-medium uppercase tracking-widest text-slate-400">{["Plan & coverage","Distribution","Eligibility","Medical requirements","Early exit","Status",""].map((label,i) => <th key={i} className="px-5 py-4 font-medium">{tx(label)}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100">{plans.map(plan => {
        const tiers = [...plan.medical_exam_tiers].sort((a,b) => a.minSumAssured-b.minSumAssured);
        return <tr key={plan.id} className="group cursor-pointer transition-colors hover:bg-blue-50/40" onClick={() => onView(plan)}>
          <td className="max-w-[330px] px-5 py-5"><div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-blue-50 text-blue-400"><svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z" /><path d="m8 12 3 3 5-6" /></svg></span><div><button onClick={e => {e.stopPropagation();onView(plan);}} className="text-left font-semibold leading-5 text-slate-800 hover:underline focus-visible:outline-blue-400">{plan.label}</button><p className="mt-1 text-xs text-slate-400">{tx(typeLabel(plan.insurance_type))}</p></div></div></td>
          <td className="px-5 py-5"><p className="text-xs font-medium text-slate-600">{tx(plan.product_category)}</p><p className="mt-1 text-xs text-slate-400">{plan.partner_bank || tx(plan.product_category === "Bancassurance" ? "Bank partner not specified" : "Direct distribution")}</p></td>
          <td className="px-5 py-5 text-xs"><p className="font-medium text-slate-600">{plan.entry_age_min}–{plan.entry_age_max} {tx("years old")}</p><p className="mt-1 text-slate-400">{plan.term_min_years}–{plan.term_max_years} {tx("year term")} · {tx(plan.category)}</p></td>
          <td className="px-5 py-5">{tiers.length ? <ul className="space-y-1.5 text-xs text-slate-500">{tiers.map((tier,i) => <li key={i}><span className="mr-1.5 inline-block h-1 w-1 rounded-full bg-blue-300" />{tier.minSumAssured > 0 ? `PKR ${formatPKRCompact(tier.minSumAssured)}+ · ` : ""}{tx(shortTierLabel(tier.tier) === "None" ? "No examination" : shortTierLabel(tier.tier))}</li>)}</ul> : <span className="text-xs text-slate-400">{tx("Not specified")}</span>}</td>
          <td className="max-w-[170px] px-5 py-5 text-xs leading-5 text-slate-500">{surrenderStatus(plan.surrender_terms)}</td>
          <td className="px-5 py-5"><span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-100 bg-blue-50/80 px-2.5 py-1 text-[11px] font-medium text-slate-600"><span className={`h-1.5 w-1.5 rounded-full ${plan.status === "Active" ? "bg-blue-400" : "bg-slate-300"}`} />{tx(plan.status)}</span></td>
          <td className="px-4 py-5"><button onClick={e => {e.stopPropagation();onView(plan);}} aria-label={tx("View {0}",{0:plan.label})} className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-slate-400 transition group-hover:border-blue-100 group-hover:bg-blue-50 group-hover:text-slate-600 focus-visible:outline-blue-400">→</button></td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

// ── Plan detail drawer ───────────────────────────────────────────────────────

function PlanDetailDrawer({
  plan,
  isAdmin,
  onClose,
  onEdit,
  onDelete,
}: {
  plan: InsurancePlan;
  isAdmin: boolean;
  onClose: () => void;
  onEdit: (p: InsurancePlan) => void;
  onDelete: (p: InsurancePlan) => void;
}) {
  const colors = COLOR_CLASSES[plan.color] ?? COLOR_CLASSES.blue;
  const tiers = [...plan.medical_exam_tiers].sort((a, b) => a.minSumAssured - b.minSumAssured);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-5xl max-h-[90vh] bg-white rounded-xl shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`border-t-4 ${colors.accent} p-6 space-y-4`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-slate-900">{plan.label}</h2>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS_BADGE[plan.status] ?? ""}`}>
                {plan.status}
              </span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${PRODUCT_CATEGORY_BADGE[plan.product_category] ?? ""}`}
              >
                {plan.product_category}
              </span>
              {plan.partner_bank && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-50 text-slate-600 border-slate-200">
                  {plan.partner_bank}
                </span>
              )}
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none shrink-0">
              ×
            </button>
          </div>

          <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${colors.badge}`}>
            {plan.code}
          </span>

          <p className="text-sm text-slate-600 leading-relaxed">{plan.description}</p>

          {/* Two columns on wide screens so the long surrender terms don't push everything into a scroll. */}
          <div className="grid items-start gap-x-8 gap-y-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
          <div className="pt-2 border-t border-slate-100">
            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              {tx("Plan Details")}
            </span>
            <table className="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
              <tbody>
                <PlanDetailRow label={tx("{0} Entry Age", { 0: plan.entry_age_label })} value={`${plan.entry_age_min}–${plan.entry_age_max} years`} />
                <PlanDetailRow label={tx("Policy Term")} value={`${plan.term_min_years}–${plan.term_max_years} years`} />
                <PlanDetailRow label={tx("Max Maturity Age")} value={`${plan.max_maturity_age} years`} />
                <PlanDetailRow label={tx("Max Coverage")} value={`${plan.max_income_multiple}× annual income`} />
                <PlanDetailRow
                  label={tx("Base Premium Rate")}
                  value={`PKR ${plan.base_premium_rate} / 1,000 sum assured / yr (rate ${plan.rate_version})`}
                />
                <PlanDetailRow label={tx("Smoker Factor")} value={`${plan.smoker_factor}x`} />
                {plan.dependent_age_min != null && plan.dependent_age_max != null && (
                  <PlanDetailRow
                    label={tx("Dependent Age (at entry)")}
                    value={`${plan.dependent_age_min}–${plan.dependent_age_max} years`}
                  />
                )}
                {plan.min_group_size != null && (
                  <PlanDetailRow label={tx("Minimum Group Size")} value={`${plan.min_group_size} employees`} />
                )}
                {plan.underwriting_basis && <PlanDetailRow label={tx("Underwriting Basis")} value={plan.underwriting_basis} />}
              </tbody>
            </table>
          </div>

          {tiers.length > 0 && (
            <div className="pt-2 border-t border-slate-100">
              <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                {tx("Medical Exam Thresholds (PKR)")}
              </span>
              <table className="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                <thead>
                  <tr className="bg-slate-50 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <th className="px-3 py-1.5 border-b border-slate-200">{tx("Sum Assured Range")}</th>
                    <th className="px-3 py-1.5 border-b border-slate-200">{tx("Requirement")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((t, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">
                        {i === tiers.length - 1
                          ? tx("≥ PKR {0}", { 0: t.minSumAssured.toLocaleString() })
                          : tx("PKR {0} – {1}", { 0: t.minSumAssured.toLocaleString(), 1: (tiers[i + 1].minSumAssured - 1).toLocaleString() })}
                      </td>
                      <td className="px-3 py-1.5 font-semibold text-slate-700">{t.tier}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {plan.required_documents.length > 0 && (
            <div className="pt-2 border-t border-slate-100">
              <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                {tx("Required Documents (Underwriting)")}
              </span>
              <table className="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                <tbody>
                  {plan.required_documents.map((doc, i) => (
                    <tr key={doc} className={i > 0 ? "border-t border-slate-100" : ""}>
                      <td className="px-3 py-1.5 font-semibold text-slate-700">{doc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          </div>
          <div className="min-w-0">
            <PlanSurrenderDetails terms={plan.surrender_terms} />
            <PlanClaimsDetails terms={plan.claims_terms} />
          </div>
          </div>

          {isAdmin && (
            <div className="pt-3 border-t border-slate-100 flex items-center gap-2">
              <button
                onClick={() => onEdit(plan)}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                {tx("Edit")}
              </button>
              <button
                onClick={() => onDelete(plan)}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
              >
                {tx("Delete")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <th scope="row" className="px-3 py-1.5 w-1/2 text-left font-semibold text-slate-500 bg-slate-50">
        {label}
      </th>
      <td className="px-3 py-1.5 font-semibold text-slate-800">{value}</td>
    </tr>
  );
}

// ── Policy wording (PDF) ──────────────────────────────────────────────────────

function PolicyWordingField({
  wording,
}: {
  wording: { filename: string | null; onUpload: (file: File) => Promise<void>; onRemove: () => Promise<void> };
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await action();
    } catch (e: any) {
      setErr(e?.message ?? tx("Something went wrong. Please try again."));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <label className="block text-xs font-semibold text-slate-600">{tx("Policy wording (PDF)")}</label>
      <p className="mt-0.5 text-[11px] text-slate-500">
        {tx("Added to every policy's application dossier for this plan.")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {wording.filename ? (
          <span className="max-w-full truncate rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
            {wording.filename}
          </span>
        ) : (
          <span className="text-xs text-slate-500">{tx("No wording uploaded yet")}</span>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void run(() => wording.onUpload(file));
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="rounded-lg border border-blue-600 px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-40"
        >
          {busy ? tx("Uploading…") : wording.filename ? tx("Replace") : tx("Upload PDF")}
        </button>
        {wording.filename && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(wording.onRemove)}
            className="px-2 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-40"
          >
            {tx("Remove")}
          </button>
        )}
      </div>
      {err && <p role="alert" className="mt-2 text-xs text-slate-800">{err}</p>}
    </div>
  );
}

// ── Form modal ────────────────────────────────────────────────────────────────

function PlanFormModal({
  form,
  editingId,
  docInput,
  wording,
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
  wording: { filename: string | null; onUpload: (file: File) => Promise<void>; onRemove: () => Promise<void> } | null;
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
            <h2 className="text-lg font-bold text-slate-900">{editingId ? tx("Edit Plan") : tx("New Insurance Plan")}</h2>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
              ×
            </button>
          </div>

          {formError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{tx("Code")}{" "}{editingId && <span className="text-slate-400">{tx("(immutable)")}</span>}</label>
              <input
                className={inputCls}
                value={form.code}
                disabled={!!editingId}
                onChange={(e) => setField("code", e.target.value)}
                placeholder={tx("TERM_LIFE")}
                required
              />
            </div>
            <div>
              <label className={labelCls}>{tx("Label")}</label>
              <input className={inputCls} value={form.label} onChange={(e) => setField("label", e.target.value)} placeholder={tx("Term Life")} required />
            </div>
            <div>
              <label className={labelCls}>{tx("Insurance Type")}</label>
              <select className={inputCls} value={form.insurance_type} onChange={(e) => setField("insurance_type", e.target.value as any)}>
                {INSURANCE_TYPES.map((t) => (
                  <option key={t} value={t}>{tx(typeLabel(t))}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{tx("Category")}</label>
              <select className={inputCls} value={form.category} onChange={(e) => setField("category", e.target.value as any)}>
                <option value="Individual">{tx("Individual")}</option>
                <option value="Group">{tx("Group")}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{tx("Product Category")}</label>
              <select
                className={inputCls}
                value={form.product_category}
                onChange={(e) => setField("product_category", e.target.value as any)}
              >
                {PRODUCT_CATEGORIES.map((pc) => (
                  <option key={pc} value={pc}>{pc}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{tx("Partner Bank (Bancassurance only)")}</label>
              <input
                className={inputCls}
                value={form.partner_bank ?? ""}
                onChange={(e) => setField("partner_bank", e.target.value || null)}
                placeholder={tx("e.g. MCB Bank")}
              />
            </div>
            <div>
              <label className={labelCls}>{tx("Status")}</label>
              <select className={inputCls} value={form.status} onChange={(e) => setField("status", e.target.value as any)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{tx("Accent Colour")}</label>
              <select className={inputCls} value={form.color} onChange={(e) => setField("color", e.target.value)}>
                {COLOR_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>{tx("Description")}</label>
            <textarea className={inputCls} rows={3} value={form.description} onChange={(e) => setField("description", e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <NumField label={tx("Entry Age Min")} value={form.entry_age_min} onChange={(v) => setField("entry_age_min", v)} />
            <NumField label={tx("Entry Age Max")} value={form.entry_age_max} onChange={(v) => setField("entry_age_max", v)} />
            <div>
              <label className={labelCls}>{tx("Entry Age Label")}</label>
              <input className={inputCls} value={form.entry_age_label} onChange={(e) => setField("entry_age_label", e.target.value)} />
            </div>
            <NumField label={tx("Term Min (yrs)")} value={form.term_min_years} onChange={(v) => setField("term_min_years", v)} />
            <NumField label={tx("Term Max (yrs)")} value={form.term_max_years} onChange={(v) => setField("term_max_years", v)} />
            <NumField label={tx("Max Maturity Age")} value={form.max_maturity_age} onChange={(v) => setField("max_maturity_age", v)} />
            <NumField label={tx("Max Income Multiple")} value={form.max_income_multiple} onChange={(v) => setField("max_income_multiple", v)} step="any" />
            <NumField
              label={tx("Base Premium Rate (PKR/1,000 sum assured/yr)")}
              value={form.base_premium_rate}
              onChange={(v) => setField("base_premium_rate", v)}
              step="any"
            />
            <NumField
              label={tx("Smoker Factor (x)")}
              value={form.smoker_factor}
              onChange={(v) => setField("smoker_factor", v)}
              step="any"
            />
            <div>
              <label className={labelCls}>{tx("Rate Version")}</label>
              <input className={inputCls} value={form.rate_version} onChange={(e) => setField("rate_version", e.target.value)} placeholder="v1" />
            </div>
            <NumField
              label={tx("Dependent Age Min")}
              value={form.dependent_age_min}
              nullable
              onChange={(v) => setField("dependent_age_min", v)}
            />
            <NumField
              label={tx("Dependent Age Max")}
              value={form.dependent_age_max}
              nullable
              onChange={(v) => setField("dependent_age_max", v)}
            />
          </div>

          {form.category === "Group" && (
            <div className="grid grid-cols-2 gap-4">
              <NumField label={tx("Min Group Size")} value={form.min_group_size} nullable onChange={(v) => setField("min_group_size", v)} />
              <div>
                <label className={labelCls}>{tx("Underwriting Basis")}</label>
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
              <label className={labelCls + " mb-0"}>{tx("Medical Exam Tiers")}</label>
              <button type="button" onClick={addTier} className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                {tx("+ Add tier")}
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
                    placeholder={tx("Min sum assured")}
                  />
                  <input
                    className={inputCls}
                    value={tier.tier}
                    onChange={(e) => updateTier(i, { tier: e.target.value })}
                    placeholder={tx("Requirement")}
                  />
                  <button type="button" onClick={() => removeTier(i)} className="text-red-500 hover:text-red-700 px-2">
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className={labelCls}>{tx("Required Documents (comma-separated)")}</label>
            <input className={inputCls} value={docInput} onChange={(e) => setDocInput(e.target.value)} placeholder={tx("CNIC, Medical Report, Salary Slip")} />
          </div>

          {wording ? (
            <PolicyWordingField wording={wording} />
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {tx("Save the plan first, then edit it to upload its policy wording.")}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="text-sm font-semibold px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
              {tx("Cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="text-sm font-semibold px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? tx("Saving…") : editingId ? tx("Save changes") : tx("Create plan")}
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

// Insurance Plans — the tenant's plan catalog and its maintenance. Plans are
// chosen for a customer on the Insurance Plan tab of the add-customer forms.
export default function PlansPage() {
  return <PlanCatalog />;
}
