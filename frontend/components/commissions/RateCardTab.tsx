"use client";

import React, { useEffect, useState } from "react";
import {
  BASIS_LABELS,
  CHANNEL_LABELS,
  COMMISSION_CONFIG,
  CommissionBasis,
  CommissionRule,
  DistributionChannel,
  PAYEE_TYPE_LABELS,
  PayeeType,
  PolicySegment,
  PremiumType,
  RateRefStatus,
  createCommissionRule,
  deleteCommissionRule,
  listCommissionRules,
  toggleCommissionRuleActive,
  updateCommissionConfig,
  updateCommissionRule,
} from "../../app/services/commissions";
import { DateRangeFilter, resolvePreset, type DatePreset, type DateRange } from "./DateRangeFilter";
import { Card, Field, PayeeTypeBadge, fmtPct, inputClass, selectClass } from "./shared";

/** The event that makes a row payable — what the ledger is waiting on. */
function payableEvents(rule: CommissionRule): { code: string; label: string }[] {
  if (rule.basis === "PRODUCER_COMMISSION") return [{ code: "DSP", label: "Agent Sale" }];
  if (rule.basis === "PARTNER_COMMISSION") return [{ code: "PTP", label: "Partner Sale" }];
  if (rule.premiumType === "RENEWAL") return [{ code: "PRC", label: "Renewal Paid" }];
  if (rule.premiumType === "SINGLE_PREMIUM") return [{ code: "PC", label: "Premium Paid" }];
  if (rule.segment === "group") {
    return [
      { code: "LG", label: "Lead Received" },
      { code: "PLI", label: "Policy Issued" },
    ];
  }
  return [
    { code: "PLI", label: "Policy Issued" },
    { code: "PC", label: "Premium Paid" },
  ];
}

function typeInfo(premiumType: PremiumType) {
  if (premiumType === "FIRST_YEAR" || premiumType === "SINGLE_PREMIUM") {
    return { label: "One-Time", className: "bg-slate-100 text-slate-700 border-slate-200" };
  }
  return { label: "Recurring", className: "bg-blue-50 text-blue-700 border-blue-200" };
}

interface RateCardTabProps {
  datePreset?: DatePreset;
  dateRange?: DateRange;
  onDateChange?: (preset: DatePreset, range: DateRange) => void;
  notify: (msg: string, ok?: boolean) => void;
}

const SEGMENTS: PolicySegment[] = ["individual", "group", "family"];
const PREMIUM_TYPES: PremiumType[] = ["FIRST_YEAR", "RENEWAL", "SINGLE_PREMIUM"];
const PAYEE_TYPES = Object.keys(PAYEE_TYPE_LABELS) as PayeeType[];
const CHANNELS = Object.keys(CHANNEL_LABELS) as DistributionChannel[];

export default function RateCardTab({
  datePreset: propPreset,
  dateRange: propRange,
  onDateChange,
  notify,
}: RateCardTabProps) {
  const [internalPreset, setInternalPreset] = useState<DatePreset>("all");
  const [internalRange, setInternalRange] = useState<DateRange>(() => resolvePreset("all"));

  const datePreset = propPreset ?? internalPreset;
  const dateRange = propRange ?? internalRange;
  const handleDateChange = onDateChange ?? ((p: DatePreset, r: DateRange) => {
    setInternalPreset(p);
    setInternalRange(r);
  });
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<DistributionChannel | "all">("all");
  const [segmentFilter, setSegmentFilter] = useState<PolicySegment | "all">("all");
  const [payeeFilter, setPayeeFilter] = useState<PayeeType | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [showConfig, setShowConfig] = useState(false);

  // Modal States
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [targetRule, setTargetRule] = useState<CommissionRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<CommissionRule | null>(null);

  const loadRules = async () => {
    try {
      const data = await listCommissionRules();
      setRules([...data]);
    } catch (err) {
      console.error(err);
      notify("Failed to load commission rules.", false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRules();
  }, []);

  const handleToggleActive = async (rule: CommissionRule) => {
    try {
      const updated = await toggleCommissionRuleActive(rule.id);
      notify(`Commission rule ${rule.id} is now ${updated.active ? "Active" : "Inactive"}.`);
      await loadRules();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not toggle rule status", false);
    }
  };

  const filteredRules = rules.filter((r) => {
    if (channelFilter !== "all" && r.channel !== channelFilter) return false;
    if (segmentFilter !== "all" && r.segment !== segmentFilter) return false;
    if (payeeFilter !== "all" && r.payeeType !== payeeFilter) return false;
    if (statusFilter === "active" && !r.active) return false;
    if (statusFilter === "inactive" && r.active) return false;

    if (dateRange.from && r.effectiveFrom > dateRange.to) return false;
    if (dateRange.to && r.effectiveTo && r.effectiveTo < dateRange.from) return false;

    if (search.trim()) {
      const q = search.toLowerCase();
      const matchId = r.id.toLowerCase().includes(q);
      const matchDesc = r.description.toLowerCase().includes(q);
      const matchName = (r.name ?? "").toLowerCase().includes(q);
      const matchSecp = (r.secpRef ?? "").toLowerCase().includes(q);
      return matchId || matchDesc || matchName || matchSecp;
    }
    return true;
  });

  const grouped = CHANNELS.map((channel) => ({
    channel,
    rules: filteredRules.filter((r) => r.channel === channel),
  })).filter((g) => g.rules.length > 0);

  return (
    <div className="space-y-4">
      <Card
        title="Commission Types & Rate Cards"
        actions={
          <>
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="px-3.5 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-xs font-bold transition-colors"
            >
              {showConfig ? "Hide Settings" : "Tax & Engine Rules"}
            </button>
            <button
              onClick={() => {
                setTargetRule(null);
                setModalMode("add");
              }}
              className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5"
            >
              <span>+ Add Commission Type</span>
            </button>
          </>
        }
      >
        {showConfig && <EngineSettings notify={notify} />}

        {/* Filter Controls Bar */}
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center gap-2.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by ID, description, or SECP citation…"
            className="flex-1 min-w-[220px] bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-hidden focus:border-blue-500"
          />
          <DateRangeFilter
            preset={datePreset}
            range={dateRange}
            onPresetChange={handleDateChange}
            size="sm"
            align="left"
          />
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value as DistributionChannel | "all")}
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-hidden"
          >
            <option value="all">All Channels</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
          <select
            value={segmentFilter}
            onChange={(e) => setSegmentFilter(e.target.value as PolicySegment | "all")}
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 capitalize focus:outline-hidden"
          >
            <option value="all">All Segments</option>
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {s} Segment
              </option>
            ))}
          </select>
          <select
            value={payeeFilter}
            onChange={(e) => setPayeeFilter(e.target.value as PayeeType | "all")}
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-hidden"
          >
            <option value="all">All Roles</option>
            {PAYEE_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {PAYEE_TYPE_LABELS[pt]}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")}
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-hidden"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
          </select>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs text-slate-400">Loading commission types…</div>
        ) : grouped.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">No commission rules match your search criteria.</div>
        ) : (
          grouped.map((group) => (
            <div key={group.channel} className="border-b border-slate-100 last:border-b-0">
              <div className="px-5 py-3 bg-slate-50/70 flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  {CHANNEL_LABELS[group.channel]}
                </h3>
                <span className="text-[10px] font-mono text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">
                  {group.rules.length} {group.rules.length === 1 ? "rule" : "rules"}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-slate-700">
                  <thead>
                    <tr className="bg-white text-slate-500 uppercase text-[10px] tracking-wider border-b border-slate-200 font-semibold">
                      <th className="py-3 px-4">COMM. ID</th>
                      <th className="py-3 px-4">DESCRIPTION</th>
                      <th className="py-3 px-4">ROLE</th>
                      <th className="py-3 px-4 text-center">TYPE</th>
                      <th className="py-3 px-4 text-right">RATE</th>
                      <th className="py-3 px-4">BASIS</th>
                      <th className="py-3 px-4">TRIGGERS</th>
                      <th className="py-3 px-4">EFFECTIVE</th>
                      <th className="py-3 px-4 text-center">REF</th>
                      <th className="py-3 px-4 text-center">STATUS</th>
                      <th className="py-3 px-4 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {group.rules.map((rule) => {
                      const events = payableEvents(rule);
                      const info = typeInfo(rule.premiumType);
                      return (
                        <tr key={rule.id} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-3 px-4">
                            <span className="font-mono font-bold text-xs text-blue-900">{rule.id}</span>
                            {rule.name && <p className="text-[10px] text-slate-400 font-medium truncate max-w-[120px]">{rule.name}</p>}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-slate-800 font-semibold">{rule.description}</span>
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200 uppercase">
                                {rule.segment}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              {rule.premiumType.replace("_", " ")} · Policy Year {rule.policyYear}
                              {rule.premiumType === "RENEWAL" && rule.policyYear >= 3 ? "+" : ""}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <PayeeTypeBadge type={rule.payeeType} />
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] border font-medium ${info.className}`}>
                              {info.label}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="font-mono text-xs font-bold text-slate-900 px-2 py-0.5 bg-slate-50 border border-slate-200 rounded">
                              {fmtPct(rule.ratePct)}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-[10px] font-semibold text-slate-700">{BASIS_LABELS[rule.basis]}</span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-col gap-1">
                              {events.map((event) => (
                                <div
                                  key={event.code}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-50 text-slate-700 border border-slate-200 text-[10px] font-semibold w-fit"
                                >
                                  <span className="text-blue-700 font-mono font-bold">{event.code}</span>
                                  <span className="text-slate-300">|</span>
                                  <span className="text-slate-600 font-medium">{event.label}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-[10px] font-mono text-slate-500 whitespace-nowrap">
                              {rule.effectiveFrom} → {rule.effectiveTo ?? "open"}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span
                              title={rule.secpRef}
                              className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border cursor-help ${
                                rule.refStatus === "STATUTORY"
                                  ? "bg-amber-50 text-amber-800 border-amber-200"
                                  : "bg-slate-50 text-slate-600 border-slate-200"
                              }`}
                            >
                              {rule.refStatus}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <button
                              onClick={() => handleToggleActive(rule)}
                              title="Click to toggle Active/Inactive"
                              className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors ${
                                rule.active
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                                  : "bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200"
                              }`}
                            >
                              {rule.active ? "Active" : "Inactive"}
                            </button>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => {
                                  setTargetRule(rule);
                                  setModalMode("edit");
                                }}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-200 transition-colors"
                                title="Edit rule"
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
                                onClick={() => setDeletingRule(rule)}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-rose-600 hover:bg-rose-50 hover:border-rose-200 transition-colors"
                                title="Delete rule"
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card title="Payout Limits" subtitle="Maximum total payout per policy">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
              <tr>
                <th className="p-3">Segment</th>
                {PREMIUM_TYPES.map((pt) => (
                  <th key={pt} className="p-3 text-right">
                    {pt.replace("_", " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {SEGMENTS.map((segment) => (
                <tr key={segment}>
                  <td className="p-3 font-bold text-slate-800 capitalize">{segment}</td>
                  {PREMIUM_TYPES.map((pt) => (
                    <td key={pt} className="p-3 text-right font-semibold tabular-nums text-slate-900">
                      {fmtPct(COMMISSION_CONFIG.payoutCeilingPct[segment][pt])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add / Edit Modal */}
      {modalMode && (
        <AddEditRuleModal
          mode={modalMode}
          rule={targetRule}
          onClose={() => {
            setModalMode(null);
            setTargetRule(null);
          }}
          onSaved={async (id) => {
            setModalMode(null);
            setTargetRule(null);
            notify(`Commission rule ${id} saved successfully.`);
            await loadRules();
          }}
          notify={notify}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deletingRule && (
        <DeleteRuleModal
          rule={deletingRule}
          onClose={() => setDeletingRule(null)}
          onDeleted={async () => {
            const id = deletingRule.id;
            setDeletingRule(null);
            notify(`Commission rule ${id} deleted.`);
            await loadRules();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

/** The engine settings that decide gating and deductions. */
function EngineSettings({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [draft, setDraft] = useState({
    freeLookDays: COMMISSION_CONFIG.freeLookDays,
    minPayoutThreshold: COMMISSION_CONFIG.minPayoutThreshold,
    salesTaxOnServicesPct: COMMISSION_CONFIG.salesTaxOnServicesPct,
    whtLifeAgentLowBandFiler: COMMISSION_CONFIG.whtLifeAgentLowBandFiler,
    whtLifeAgentLowBandNonFiler: COMMISSION_CONFIG.whtLifeAgentLowBandNonFiler,
    whtStandardFiler: COMMISSION_CONFIG.whtStandardFiler,
    whtStandardNonFiler: COMMISSION_CONFIG.whtStandardNonFiler,
    lifeAgentLowBandAnnualLimit: COMMISSION_CONFIG.lifeAgentLowBandAnnualLimit,
  });

  const apply = () => {
    updateCommissionConfig(draft);
    notify("Engine settings applied — the ledger has been recomputed.");
  };

  const numField = (label: string, key: keyof typeof draft, hint?: string) => (
    <Field label={label}>
      <input
        type="number"
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        className={`${inputClass} font-mono`}
      />
      {hint && <p className="text-[10px] text-slate-400 mt-1">{hint}</p>}
    </Field>
  );

  return (
    <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/60 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {numField("Cooling Period (Days)", "freeLookDays", "Days before payout")}
        {numField("Min. Payout (PKR)", "minPayoutThreshold", "Minimum amount to release")}
        {numField("Sales Tax %", "salesTaxOnServicesPct", "For corporate partners")}
        {numField("Low-Tax Limit (PKR)", "lifeAgentLowBandAnnualLimit", "Annual limit")}
        {numField("Agent Tax (Filer %)", "whtLifeAgentLowBandFiler")}
        {numField("Agent Tax (Non-Filer %)", "whtLifeAgentLowBandNonFiler")}
        {numField("Standard Tax (Filer %)", "whtStandardFiler")}
        {numField("Standard Tax (Non-Filer %)", "whtStandardNonFiler")}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] text-slate-500">
          Filers get lower tax rates; non-filers are charged standard rates.
        </p>
        <button onClick={apply} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs shrink-0">
          Save Settings
        </button>
      </div>
    </div>
  );
}

function AddEditRuleModal({
  mode,
  rule,
  onClose,
  onSaved,
  notify,
}: {
  mode: "add" | "edit";
  rule: CommissionRule | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [form, setForm] = useState({
    id: rule?.id ?? "",
    name: rule?.name ?? "",
    channel: rule?.channel ?? ("DIRECT_AGENCY" as DistributionChannel),
    payeeType: rule?.payeeType ?? ("AGENT" as PayeeType),
    segment: rule?.segment ?? ("individual" as PolicySegment),
    premiumType: rule?.premiumType ?? ("FIRST_YEAR" as PremiumType),
    policyYear: rule?.policyYear ?? 1,
    ratePct: rule?.ratePct ?? 10.0,
    basis: rule?.basis ?? ("PREMIUM" as CommissionBasis),
    description: rule?.description ?? "",
    secpRef: rule?.secpRef ?? "Contractual Agreement",
    refStatus: rule?.refStatus ?? ("CONTRACTUAL" as RateRefStatus),
    effectiveFrom: rule?.effectiveFrom ?? new Date().toISOString().slice(0, 10),
    effectiveTo: rule?.effectiveTo ?? "",
    active: rule?.active ?? true,
  });

  const save = async () => {
    if (!form.description.trim()) {
      notify("Description is required.", false);
      return;
    }
    if (mode === "add" && form.id.trim() === "") {
      notify("Commission Rule ID is required.", false);
      return;
    }

    try {
      if (mode === "add") {
        await createCommissionRule({
          id: form.id.trim(),
          name: form.name.trim() || undefined,
          channel: form.channel,
          payeeType: form.payeeType,
          segment: form.segment,
          premiumType: form.premiumType,
          policyYear: Number(form.policyYear),
          ratePct: Number(form.ratePct),
          basis: form.basis,
          description: form.description.trim(),
          secpRef: form.secpRef.trim(),
          refStatus: form.refStatus,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo ? form.effectiveTo : null,
          active: form.active,
        });
        onSaved(form.id.trim());
      } else if (rule) {
        await updateCommissionRule(rule.id, {
          name: form.name.trim() || undefined,
          channel: form.channel,
          payeeType: form.payeeType,
          segment: form.segment,
          premiumType: form.premiumType,
          policyYear: Number(form.policyYear),
          ratePct: Number(form.ratePct),
          basis: form.basis,
          description: form.description.trim(),
          secpRef: form.secpRef.trim(),
          refStatus: form.refStatus,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo ? form.effectiveTo : null,
          active: form.active,
        });
        onSaved(rule.id);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not save the commission rule", false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs px-4 py-8 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between text-slate-900">
          <div>
            <h3 className="font-bold text-sm text-slate-900">
              {mode === "add" ? "Create New Commission Type" : `Edit Commission Type: ${rule?.id}`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Define distribution channel rates, roles, policy segment, and regulatory citations.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">
            ✕
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Rule ID">
            <input
              value={form.id}
              disabled={mode === "edit"}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="e.g. COM-101 or R10"
              className={`${inputClass} font-mono ${mode === "edit" ? "bg-slate-100 text-slate-500" : ""}`}
            />
          </Field>

          <Field label="Rule Title / Name">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Individual FYP Acquisition"
              className={inputClass}
            />
          </Field>

          <Field label="Distribution Channel">
            <select
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value as DistributionChannel })}
              className={selectClass}
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Target Role / Payee Type">
            <select
              value={form.payeeType}
              onChange={(e) => setForm({ ...form, payeeType: e.target.value as PayeeType })}
              className={selectClass}
            >
              {PAYEE_TYPES.map((pt) => (
                <option key={pt} value={pt}>
                  {PAYEE_TYPE_LABELS[pt]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Policy Segment">
            <select
              value={form.segment}
              onChange={(e) => setForm({ ...form, segment: e.target.value as PolicySegment })}
              className={selectClass}
            >
              <option value="individual">Individual Life</option>
              <option value="group">Group Corporate</option>
              <option value="family">Family Takaful</option>
            </select>
          </Field>

          <Field label="Premium Type">
            <select
              value={form.premiumType}
              onChange={(e) => setForm({ ...form, premiumType: e.target.value as PremiumType })}
              className={selectClass}
            >
              <option value="FIRST_YEAR">First Year Premium (FYP)</option>
              <option value="RENEWAL">Renewal Premium (RYP)</option>
              <option value="SINGLE_PREMIUM">Single Premium (SP)</option>
            </select>
          </Field>

          <Field label="Policy Year Band">
            <input
              type="number"
              min={1}
              max={30}
              value={form.policyYear}
              onChange={(e) => setForm({ ...form, policyYear: Number(e.target.value) })}
              className={`${inputClass} font-mono`}
            />
          </Field>

          <Field label="Commission Rate (%)">
            <input
              type="number"
              step="0.1"
              min={0}
              max={100}
              value={form.ratePct}
              onChange={(e) => setForm({ ...form, ratePct: Number(e.target.value) })}
              className={`${inputClass} font-mono font-bold text-slate-900`}
            />
          </Field>

          <Field label="Commission Calculation Basis">
            <select
              value={form.basis}
              onChange={(e) => setForm({ ...form, basis: e.target.value as CommissionBasis })}
              className={selectClass}
            >
              <option value="PREMIUM">Collected Premium (% of Premium)</option>
              <option value="PRODUCER_COMMISSION">Producer Commission (% of Gross Agent Comm.)</option>
              <option value="PARTNER_COMMISSION">Partner Commission (% of Gross Partner Fee)</option>
            </select>
          </Field>

          <Field label="Regulatory Reference Status">
            <select
              value={form.refStatus}
              onChange={(e) => setForm({ ...form, refStatus: e.target.value as RateRefStatus })}
              className={selectClass}
            >
              <option value="STATUTORY">STATUTORY (SECP Cap / Form Rules)</option>
              <option value="CONTRACTUAL">CONTRACTUAL (Insurer Negotiated)</option>
            </select>
          </Field>

          <div className="md:col-span-2">
            <Field label="Description">
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Detailed description of commission type and application terms"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field label="SECP / Citation Reference">
              <input
                value={form.secpRef}
                onChange={(e) => setForm({ ...form, secpRef: e.target.value })}
                placeholder="e.g. SECP Rules 2017 Rule 24"
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Effective From Date">
            <input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              className={inputClass}
            />
          </Field>

          <Field label="Effective To Date (Optional)">
            <input
              type="date"
              value={form.effectiveTo}
              onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
              placeholder="Leave empty for open-ended"
              className={inputClass}
            />
          </Field>

          <div className="md:col-span-2 pt-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              Rule Active &amp; Available in Ledger Waterfall
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
            {mode === "add" ? "Create Type" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteRuleModal({
  rule,
  onClose,
  onDeleted,
  notify,
}: {
  rule: CommissionRule;
  onClose: () => void;
  onDeleted: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const confirmDelete = async () => {
    try {
      await deleteCommissionRule(rule.id);
      onDeleted();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete rule", false);
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
            <h3 className="font-bold text-sm text-rose-900">Delete Commission Type</h3>
          </div>
          <button onClick={onClose} className="text-rose-400 hover:text-rose-600 text-lg font-bold">
            ✕
          </button>
        </div>

        <div className="p-6 space-y-3">
          <p className="text-xs text-slate-700 leading-relaxed">
            Are you sure you want to delete commission rule{" "}
            <span className="font-bold font-mono text-slate-900">{rule.id}</span> (
            <span className="font-semibold">{rule.description}</span>)?
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900 space-y-1">
            <p className="font-bold">Impact Notice:</p>
            <p>
              Deleting this rule removes it from future ledger waterfall evaluations. Any policies depending on this rate card row will recompute.
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
