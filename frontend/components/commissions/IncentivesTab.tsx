"use client";

import React, { useState } from "react";
import {
  INCENTIVE_SCHEMES,
  IncentiveQualification,
  IncentiveScheme,
  PAYEE_TYPE_LABELS,
  PayeeType,
  awardIncentive,
  createIncentiveScheme,
  deleteIncentiveScheme,
  toggleIncentiveSchemeActive,
  updateIncentiveScheme,
} from "../../app/services/commissions";
import { DateRangeFilter, resolvePreset, type DatePreset, type DateRange } from "./DateRangeFilter";
import { Card, EmptyState, Field, PayeeTypeBadge, fmtPKR, inputClass, selectClass } from "./shared";

type IncentiveSubTab = "schemes" | "qualified" | "shortfall";
const PAYEE_TYPES = Object.keys(PAYEE_TYPE_LABELS) as PayeeType[];

interface IncentivesTabProps {
  qualifications: IncentiveQualification[];
  datePreset?: DatePreset;
  dateRange?: DateRange;
  onDateChange?: (preset: DatePreset, range: DateRange) => void;
  onChanged: () => void;
  notify: (msg: string, ok?: boolean) => void;
}

/**
 * Performance bonuses & policy retention rewards evaluated on book volume
 */
export default function IncentivesTab({
  qualifications,
  datePreset: propPreset,
  dateRange: propRange,
  onDateChange,
  onChanged,
  notify,
}: IncentivesTabProps) {
  const [internalPreset, setInternalPreset] = useState<DatePreset>("all");
  const [internalRange, setInternalRange] = useState<DateRange>(() => resolvePreset("all"));

  const datePreset = propPreset ?? internalPreset;
  const dateRange = propRange ?? internalRange;
  const handleDateChange = onDateChange ?? ((p: DatePreset, r: DateRange) => {
    setInternalPreset(p);
    setInternalRange(r);
  });
  const [subTab, setSubTab] = useState<IncentiveSubTab>("schemes");
  const [search, setSearch] = useState("");

  // Modal States
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [targetScheme, setTargetScheme] = useState<IncentiveScheme | null>(null);
  const [deletingScheme, setDeletingScheme] = useState<IncentiveScheme | null>(null);

  const qualified = qualifications.filter((q) => q.qualifies && q.awardAmount > 0);
  const shortfall = qualifications.filter((q) => !q.qualifies);

  const award = async (q: IncentiveQualification) => {
    try {
      await awardIncentive(q);
      notify(`${q.scheme.name} bonus of ${fmtPKR(q.awardAmount)} added to ${q.payee.name}'s payout ledger.`);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not process bonus payout", false);
    }
  };

  const handleToggleActive = async (scheme: IncentiveScheme) => {
    try {
      const updated = await toggleIncentiveSchemeActive(scheme.id);
      notify(`Bonus plan '${scheme.name}' is now ${updated.active ? "Active" : "Inactive"}.`);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not toggle plan status", false);
    }
  };

  const filteredSchemes = INCENTIVE_SCHEMES.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.metric.toLowerCase().includes(q)
    );
  });

  const filteredQualified = qualified.filter((q) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      q.payee.name.toLowerCase().includes(query) ||
      q.payee.code.toLowerCase().includes(query) ||
      q.scheme.name.toLowerCase().includes(query)
    );
  });

  const filteredShortfall = shortfall.filter((q) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      q.payee.name.toLowerCase().includes(query) ||
      q.payee.code.toLowerCase().includes(query) ||
      q.scheme.name.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-4">
      {/* 3-Category Control Bar */}
      <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex p-0.5 rounded-xl bg-slate-100 border border-slate-200/60">
            {(
              [
                ["schemes", "Bonus Plans & Rules"],
                ["qualified", `Earned Bonuses (${qualified.length})`],
                ["shortfall", `In-Progress Goals (${shortfall.length})`],
              ] as [IncentiveSubTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSubTab(key)}
                className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  subTab === key
                    ? "bg-blue-600 text-white shadow-xs"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-lg justify-end">
            <div className="relative flex-1">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agent, payee, or bonus plan..."
                className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-hidden focus:border-blue-500 text-slate-800 placeholder-slate-400"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1.5 text-xs text-slate-400 hover:text-slate-600 font-bold px-1"
                >
                  ✕
                </button>
              )}
            </div>

            <DateRangeFilter
              preset={datePreset}
              range={dateRange}
              onPresetChange={handleDateChange}
              size="sm"
              align="left"
            />

            {subTab === "schemes" && (
              <button
                onClick={() => {
                  setTargetScheme(null);
                  setModalMode("add");
                }}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold shrink-0 transition-colors"
              >
                + Add Bonus Plan
              </button>
            )}
          </div>
        </div>
      </div>

      {subTab === "schemes" && (
        <Card
          title="Bonus Plans & Rules"
          actions={
            <button
              onClick={() => {
                setTargetScheme(null);
                setModalMode("add");
              }}
              className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5"
            >
              + Create Bonus Plan
            </button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">Bonus Plan</th>
                  <th className="p-3">Eligible Roles</th>
                  <th className="p-3">Target Metric</th>
                  <th className="p-3">Required Goal</th>
                  <th className="p-3">Bonus Reward</th>
                  <th className="p-3">Evaluation Period</th>
                  <th className="p-3 text-center">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSchemes.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="p-3">
                      <p className="font-bold text-slate-900">{s.name}</p>
                      <p className="font-mono text-[10px] text-slate-400">{s.code}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5 max-w-md">{s.description}</p>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {s.payeeTypes.map((t) => (
                          <PayeeTypeBadge key={t} type={t} />
                        ))}
                      </div>
                    </td>
                    <td className="p-3 text-slate-700 font-semibold">{s.metric}</td>
                    <td className="p-3 font-semibold tabular-nums text-slate-900">{s.thresholdLabel}</td>
                    <td className="p-3 font-mono font-bold text-blue-700">
                      {s.rewardAmount !== null ? fmtPKR(s.rewardAmount) : `${s.rewardPct}% of 1st-Year Earnings`}
                    </td>
                    <td className="p-3 text-[10px] text-slate-500">{s.measuredAt}</td>
                    <td className="p-3 text-center">
                      <button
                        onClick={() => handleToggleActive(s)}
                        title="Click to toggle Active/Inactive"
                        className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors ${
                          s.active
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                            : "bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200"
                        }`}
                      >
                        {s.active ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setTargetScheme(s);
                            setModalMode("edit");
                          }}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-200 transition-colors"
                          title="Edit bonus plan"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={() => setDeletingScheme(s)}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-rose-600 hover:bg-rose-50 hover:border-rose-200 transition-colors"
                          title="Delete bonus plan"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {subTab === "qualified" && (
        <Card title="Earned Bonuses (Ready to Pay)">
          {filteredQualified.length === 0 ? (
            <EmptyState message="No agents currently qualify for an uncollected bonus." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="p-3">Payee</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Bonus Plan</th>
                    <th className="p-3 text-right">Achieved Value</th>
                    <th className="p-3 text-right">Required Goal</th>
                    <th className="p-3 text-right">Bonus Reward</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredQualified.map((q) => (
                    <tr key={`${q.payee.id}-${q.scheme.id}`} className="hover:bg-slate-50/70">
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{q.payee.name}</p>
                        <p className="text-[10px] font-mono text-slate-400">{q.payee.code}</p>
                      </td>
                      <td className="p-3">
                        <PayeeTypeBadge type={q.payee.type} />
                      </td>
                      <td className="p-3">
                        <p className="font-semibold text-slate-800">{q.scheme.name}</p>
                        <p className="text-[10px] text-slate-400">{q.scheme.metric}</p>
                      </td>
                      <td className="p-3 text-right font-mono font-bold text-emerald-700">
                        {q.scheme.kind === "PERSISTENCY_BONUS" ? `${q.metricValue}%` : fmtPKR(q.metricValue)}
                      </td>
                      <td className="p-3 text-right font-mono text-slate-500">{q.scheme.thresholdLabel}</td>
                      <td className="p-3 text-right font-semibold tabular-nums text-blue-700">{fmtPKR(q.awardAmount)}</td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => award(q)}
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-[10px] rounded-lg shadow-xs transition-colors"
                        >
                          Add to Earnings →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {subTab === "shortfall" && (
        <Card title="In-Progress Sales & Retention Goals">
          {filteredShortfall.length === 0 ? (
            <EmptyState message="All active agents have reached their bonus targets." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="p-3">Payee</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Bonus Plan</th>
                    <th className="p-3 text-right">Current Achievement</th>
                    <th className="p-3 text-right">Required Goal</th>
                    <th className="p-3">Completion Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredShortfall.map((q) => {
                    const pct = q.scheme.threshold > 0 ? Math.min(100, (q.metricValue / q.scheme.threshold) * 100) : 0;
                    const isPersistency = q.scheme.kind === "PERSISTENCY_BONUS";
                    return (
                      <tr key={`${q.payee.id}-${q.scheme.id}`} className="hover:bg-slate-50/70">
                        <td className="p-3">
                          <p className="font-bold text-slate-900">{q.payee.name}</p>
                          <p className="text-[10px] font-mono text-slate-400">{q.payee.code}</p>
                        </td>
                        <td className="p-3">
                          <PayeeTypeBadge type={q.payee.type} />
                        </td>
                        <td className="p-3 font-semibold text-slate-800">{q.scheme.name}</td>
                        <td className="p-3 text-right font-mono text-slate-700">
                          {isPersistency ? `${q.metricValue}%` : fmtPKR(q.metricValue)}
                        </td>
                        <td className="p-3 text-right font-mono text-slate-500">{q.scheme.thresholdLabel}</td>
                        <td className="p-3 w-40">
                          <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                          </div>
                          <p className="text-[10px] text-slate-400 mt-1">{pct.toFixed(0)}% reached</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Add / Edit Bonus Plan Modal */}
      {modalMode && (
        <AddEditSchemeModal
          mode={modalMode}
          scheme={targetScheme}
          onClose={() => {
            setModalMode(null);
            setTargetScheme(null);
          }}
          onSaved={(name) => {
            setModalMode(null);
            setTargetScheme(null);
            notify(`Bonus plan '${name}' saved.`);
            onChanged();
          }}
          notify={notify}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deletingScheme && (
        <DeleteSchemeModal
          scheme={deletingScheme}
          onClose={() => setDeletingScheme(null)}
          onDeleted={() => {
            const name = deletingScheme.name;
            setDeletingScheme(null);
            notify(`Bonus plan '${name}' deleted.`);
            onChanged();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function AddEditSchemeModal({
  mode,
  scheme,
  onClose,
  onSaved,
  notify,
}: {
  mode: "add" | "edit";
  scheme: IncentiveScheme | null;
  onClose: () => void;
  onSaved: (name: string) => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [form, setForm] = useState({
    id: scheme?.id ?? "",
    code: scheme?.code ?? "",
    name: scheme?.name ?? "",
    kind: scheme?.kind ?? ("PERSISTENCY_BONUS" as IncentiveScheme["kind"]),
    payeeTypes: scheme?.payeeTypes ?? (["AGENT", "SALES_MANAGER"] as PayeeType[]),
    description: scheme?.description ?? "",
    metric: scheme?.metric ?? "1-Year Policy Retention",
    thresholdLabel: scheme?.thresholdLabel ?? "≥ 85% Active",
    threshold: scheme?.threshold ?? 85,
    rewardType: scheme?.rewardAmount !== null ? "flat" : "percentage",
    rewardPct: scheme?.rewardPct ?? 5,
    rewardAmount: scheme?.rewardAmount ?? 100_000,
    measuredAt: scheme?.measuredAt ?? "After 13 Months",
    active: scheme?.active ?? true,
  });

  const togglePayeeType = (pt: PayeeType) => {
    if (form.payeeTypes.includes(pt)) {
      setForm({ ...form, payeeTypes: form.payeeTypes.filter((t) => t !== pt) });
    } else {
      setForm({ ...form, payeeTypes: [...form.payeeTypes, pt] });
    }
  };

  const save = async () => {
    if (!form.name.trim() || !form.code.trim()) {
      notify("Plan Name and Code are required.", false);
      return;
    }
    if (form.payeeTypes.length === 0) {
      notify("Select at least one eligible role.", false);
      return;
    }

    try {
      const isFlat = form.rewardType === "flat";
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        kind: form.kind,
        payeeTypes: form.payeeTypes,
        description: form.description.trim(),
        metric: form.metric.trim(),
        thresholdLabel: form.thresholdLabel.trim(),
        threshold: Number(form.threshold),
        rewardPct: isFlat ? null : Number(form.rewardPct),
        rewardAmount: isFlat ? Number(form.rewardAmount) : null,
        measuredAt: form.measuredAt.trim(),
        active: form.active,
      };

      if (mode === "add") {
        await createIncentiveScheme({
          ...payload,
          id: form.id.trim() || undefined,
        });
      } else if (scheme) {
        await updateIncentiveScheme(scheme.id, payload);
      }
      onSaved(form.name.trim());
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not save bonus plan", false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs px-4 py-8 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between text-slate-900">
          <div>
            <h3 className="font-bold text-sm text-slate-900">
              {mode === "add" ? "Create New Bonus Plan" : `Edit Bonus Plan: ${scheme?.name}`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Define production thresholds, retention goals, and reward payout terms.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">
            ✕
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Plan Code">
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. BONUS-RET-13M"
              className={`${inputClass} font-mono`}
            />
          </Field>

          <Field label="Plan Name">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. 1-Year Policy Retention Bonus"
              className={inputClass}
            />
          </Field>

          <Field label="Bonus Category">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as IncentiveScheme["kind"] })}
              className={selectClass}
            >
              <option value="PERSISTENCY_BONUS">Persistency &amp; Retention Bonus</option>
              <option value="PRODUCTION_BONUS">Production &amp; Volume Bonus</option>
              <option value="CLUB_QUALIFICATION">Club &amp; Leadership Qualification</option>
            </select>
          </Field>

          <Field label="Evaluation Metric">
            <input
              value={form.metric}
              onChange={(e) => setForm({ ...form, metric: e.target.value })}
              placeholder="e.g. 1-Year Policy Retention"
              className={inputClass}
            />
          </Field>

          <Field label="Goal Threshold Label">
            <input
              value={form.thresholdLabel}
              onChange={(e) => setForm({ ...form, thresholdLabel: e.target.value })}
              placeholder="e.g. ≥ 85% Active"
              className={inputClass}
            />
          </Field>

          <Field label="Threshold Numeric Value">
            <input
              type="number"
              value={form.threshold}
              onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
              className={`${inputClass} font-mono font-bold text-slate-900`}
            />
          </Field>

          <Field label="Reward Model">
            <select
              value={form.rewardType}
              onChange={(e) => setForm({ ...form, rewardType: e.target.value })}
              className={selectClass}
            >
              <option value="percentage">Percentage (% of 1st-Year Earnings)</option>
              <option value="flat">Flat Cash Amount (PKR)</option>
            </select>
          </Field>

          {form.rewardType === "percentage" ? (
            <Field label="Bonus Reward (%)">
              <input
                type="number"
                step="0.5"
                value={form.rewardPct}
                onChange={(e) => setForm({ ...form, rewardPct: Number(e.target.value) })}
                className={`${inputClass} font-mono font-bold text-blue-700`}
              />
            </Field>
          ) : (
            <Field label="Flat Cash Reward (PKR)">
              <input
                type="number"
                value={form.rewardAmount}
                onChange={(e) => setForm({ ...form, rewardAmount: Number(e.target.value) })}
                className={`${inputClass} font-mono font-bold text-blue-700`}
              />
            </Field>
          )}

          <Field label="Evaluation Timing">
            <input
              value={form.measuredAt}
              onChange={(e) => setForm({ ...form, measuredAt: e.target.value })}
              placeholder="e.g. End of Quarter, After 13 Months"
              className={inputClass}
            />
          </Field>

          <div className="md:col-span-2">
            <Field label="Description">
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Details on qualification requirements and payout conditions"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-2">
              Eligible Payee Roles
            </label>
            <div className="flex flex-wrap gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl">
              {PAYEE_TYPES.map((pt) => {
                const checked = form.payeeTypes.includes(pt);
                return (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => togglePayeeType(pt)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                      checked
                        ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    {checked ? "✓ " : "+ "}
                    {PAYEE_TYPE_LABELS[pt]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="md:col-span-2 pt-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              Plan Active &amp; Evaluated for Agent Qualifications
            </label>
          </div>
        </div>

        <div className="border-t border-slate-200 px-6 py-3 flex justify-end gap-2 bg-slate-50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white border border-slate-300 font-bold rounded-xl text-slate-700 text-xs hover:bg-slate-100"
          >
            Cancel
          </button>
          <button onClick={save} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs shadow-md">
            {mode === "add" ? "Create Bonus Plan" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteSchemeModal({
  scheme,
  onClose,
  onDeleted,
  notify,
}: {
  scheme: IncentiveScheme;
  onClose: () => void;
  onDeleted: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const confirmDelete = async () => {
    try {
      await deleteIncentiveScheme(scheme.id);
      onDeleted();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete bonus plan", false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs px-4 py-8">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
        <div className="bg-rose-50 px-6 py-4 border-b border-rose-100 flex items-center justify-between text-rose-900">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-rose-200 text-rose-700 flex items-center justify-center text-xs font-bold">
              !
            </span>
            <h3 className="font-bold text-sm text-rose-900">Delete Bonus Plan</h3>
          </div>
          <button onClick={onClose} className="text-rose-400 hover:text-rose-600 text-lg font-bold">
            ✕
          </button>
        </div>

        <div className="p-6 space-y-3">
          <p className="text-xs text-slate-700 leading-relaxed">
            Are you sure you want to delete bonus plan{" "}
            <span className="font-bold text-slate-900">{scheme.name}</span> (
            <span className="font-mono text-slate-600">{scheme.code}</span>)?
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900 space-y-1">
            <p className="font-bold">Impact Notice:</p>
            <p>
              Deleting this bonus plan will prevent agents from qualifying for this reward in future incentive evaluation cycles.
            </p>
          </div>
        </div>

        <div className="border-t border-slate-200 px-6 py-3 flex justify-end gap-2 bg-slate-50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white border border-slate-300 font-bold rounded-xl text-slate-700 text-xs hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={confirmDelete}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-xs shadow-md"
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </div>
  );
}
