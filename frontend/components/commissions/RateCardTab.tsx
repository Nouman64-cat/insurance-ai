"use client";

import React, { useState } from "react";
import {
  BASIS_LABELS,
  CHANNEL_LABELS,
  COMMISSION_CONFIG,
  COMMISSION_RATE_CARD,
  CommissionRule,
  DistributionChannel,
  PAYEE_TYPE_LABELS,
  PolicySegment,
  PremiumType,
  updateCommissionConfig,
} from "../../app/services/commissions";
import { Card, Field, PayeeTypeBadge, fmtPct, inputClass } from "./shared";

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

const SEGMENTS: PolicySegment[] = ["individual", "group", "family"];
const PREMIUM_TYPES: PremiumType[] = ["FIRST_YEAR", "RENEWAL", "SINGLE_PREMIUM"];

/**
 * The commission schedule for every channel and every payee type, plus the
 * engine settings the ledger is computed against.
 */
export default function RateCardTab({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [channelFilter, setChannelFilter] = useState<DistributionChannel | "all">("all");
  const [showConfig, setShowConfig] = useState(false);

  const rows = COMMISSION_RATE_CARD.filter((r) => channelFilter === "all" || r.channel === channelFilter);
  const grouped = (Object.keys(CHANNEL_LABELS) as DistributionChannel[])
    .map((channel) => ({ channel, rules: rows.filter((r) => r.channel === channel) }))
    .filter((g) => g.rules.length > 0);

  let counter = 101;

  return (
    <div className="space-y-4">
      <Card
        title="Commission Types"
        subtitle="Rules and rates by channel"
        actions={
          <>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as DistributionChannel | "all")}
              className="bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="all">All channels</option>
              {(Object.keys(CHANNEL_LABELS) as DistributionChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="px-3.5 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-xs font-bold"
            >
              {showConfig ? "Hide Settings" : "Tax & Rules"}
            </button>
          </>
        }
      >
        {showConfig && <EngineSettings notify={notify} />}

        <div className="px-5 py-2 bg-amber-50/60 border-b border-amber-100 text-[11px] text-amber-900">
          <span className="font-bold">Note:</span> STATUTORY = Government Rules. CONTRACTUAL = Company Terms.
        </div>

        {grouped.map((group) => (
          <div key={group.channel} className="border-b border-slate-100 last:border-b-0">
            <div className="px-5 py-3 bg-slate-50/70 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{CHANNEL_LABELS[group.channel]}</h3>
              <span className="text-[10px] font-mono text-slate-400">{group.rules.length} rows</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-700">
                <thead>
                  <tr className="bg-white text-slate-500 uppercase text-[10px] tracking-wider border-b border-slate-200 font-semibold">
                    <th className="py-3 px-5">COMM. ID</th>
                    <th className="py-3 px-5">DESCRIPTION</th>
                    <th className="py-3 px-5">PAYEE</th>
                    <th className="py-3 px-5 text-center">COMM. TYPE</th>
                    <th className="py-3 px-5 text-right">RATE</th>
                    <th className="py-3 px-5">TO BE APPLIED WHEN</th>
                    <th className="py-3 px-5">TRIGGERS ON</th>
                    <th className="py-3 px-5">EFF. FROM</th>
                    <th className="py-3 px-5 text-center">COMM. REF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {group.rules.flatMap((rule) => {
                    const events = payableEvents(rule);
                    const info = typeInfo(rule.premiumType);
                    return events.map((event) => {
                      const commissionId = `COM-${counter++}`;
                      return (
                        <tr key={`${rule.id}-${event.code}`} className="hover:bg-slate-50/70">
                          <td className="py-3.5 px-5">
                            <span className="font-mono font-bold text-xs text-blue-900">{commissionId}</span>
                          </td>
                          <td className="py-3.5 px-5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-slate-700 font-medium">{rule.description}</span>
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200 uppercase">
                                {rule.segment}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              {rule.premiumType.replace("_", " ")} · Year {rule.policyYear}
                              {rule.premiumType === "RENEWAL" && rule.policyYear >= 3 ? "+" : ""}
                            </p>
                          </td>
                          <td className="py-3.5 px-5">
                            <PayeeTypeBadge type={rule.payeeType} />
                          </td>
                          <td className="py-3.5 px-5 text-center">
                            <span className={`inline-flex px-2.5 py-0.5 rounded text-[11px] border font-medium ${info.className}`}>
                              {info.label}
                            </span>
                          </td>
                          <td className="py-3.5 px-5 text-right">
                            <span className="font-mono text-sm font-bold text-slate-900 px-2 py-0.5 bg-slate-50 border border-slate-200 rounded">
                              {fmtPct(rule.ratePct)}
                            </span>
                          </td>
                          <td className="py-3.5 px-5">
                            <span className="text-[10px] font-semibold text-slate-700">{BASIS_LABELS[rule.basis]}</span>
                          </td>
                          <td className="py-3.5 px-5">
                            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-50 text-slate-700 border border-slate-200 text-[10px] font-semibold">
                              <span className="text-blue-700 font-mono font-bold">{event.code}</span>
                              <span className="text-slate-300">|</span>
                              <span className="text-slate-600 font-medium">{event.label}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-5">
                            <p className="text-[10px] font-mono text-slate-500">
                              {rule.effectiveFrom} → {rule.effectiveTo ?? "open"}
                            </p>
                            <span
                              className={`text-[10px] font-bold ${rule.active ? "text-emerald-600" : "text-slate-400"}`}
                            >
                              {rule.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="py-3.5 px-5 text-center">
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
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Card>

      <Card
        title="Payout Limits"
        subtitle="Maximum total payout per policy"
      >
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
