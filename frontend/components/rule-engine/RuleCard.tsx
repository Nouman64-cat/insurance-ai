"use client";

import React from "react";
import { RuleDetail } from "@/app/services/ruleEngine";
import { IMPACT_TYPE_CONFIG, RISK_FACTOR_OPTIONS, criterionParts, detectOverlap } from "./constants";
import { tx } from "@/lib/i18n/tx";

interface Props {
  rule: RuleDetail;
  allRules: RuleDetail[];
  isLocked?: boolean;
  onEdit: (rule: RuleDetail) => void;
  onDelete: (ruleId: string) => void;
}

/** One rule, read as a sentence: "If <condition> → <outcome>", with the reason underneath. */
export default function RuleCard({ rule, allRules, isLocked = false, onEdit, onDelete }: Props) {
  const editable = !isLocked;
  const impact = IMPACT_TYPE_CONFIG[rule.impact_type] || IMPACT_TYPE_CONFIG.AUTO_APPROVE;
  const data = rule.impact_data || ({} as RuleDetail["impact_data"]);
  const groupIds = Array.from(new Set(rule.criteria.map((c) => c.group_id))).sort((a, b) => a - b);
  const overlaps = allRules.filter((r) => r.id !== rule.id && detectOverlap(rule.criteria, r.criteria).length > 0);
  const factor = RISK_FACTOR_OPTIONS.find((o) => o.code === data.risk_factor);

  const chips: { label: string; tone: string }[] = [];
  if (factor) chips.push({ label: tx("{0}: {1}% risk", { 0: tx(factor.label), 1: Math.round((data.risk_level ?? 0) * 100) }), tone: "bg-rose-50 text-rose-700 ring-rose-100" });
  if (data.extra_mortality_pct) chips.push({ label: tx("Loading +{0}%", { 0: data.extra_mortality_pct }), tone: "bg-blue-50 text-blue-700 ring-blue-100" });
  if (data.medical_profile_codes?.length) chips.push({ label: tx("Tests: {0}", { 0: data.medical_profile_codes.join(", ") }), tone: "bg-blue-50 text-blue-700 ring-blue-100" });
  if (data.exclusion_riders?.length) chips.push({ label: tx("Excludes: {0}", { 0: data.exclusion_riders.join(", ").replace(/_/g, " ") }), tone: "bg-amber-50 text-amber-700 ring-amber-100" });
  if (data.hlv_max_multiple) chips.push({ label: tx("Max {0}× income", { 0: data.hlv_max_multiple }), tone: "bg-slate-100 text-slate-600 ring-slate-200" });
  if (data.commission_pct != null) chips.push({ label: tx("Commission {0}%", { 0: data.commission_pct }), tone: "bg-slate-100 text-slate-600 ring-slate-200" });
  if (data.upfront_payment_pct != null) chips.push({ label: tx("{0}% before underwriting · {1}% at issuance", { 0: data.upfront_payment_pct, 1: Math.round((100 - data.upfront_payment_pct) * 100) / 100 }), tone: "bg-emerald-50 text-emerald-700 ring-emerald-100" });
  if (data.is_terminal) chips.push({ label: tx("Stops further checks"), tone: "bg-slate-100 text-slate-600 ring-slate-200" });

  return (
    <div className="group rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm transition hover:border-slate-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-900">{rule.name}</h4>
            {!rule.is_active && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{tx("Off")}</span>}
          </div>

          <div className="mt-2 space-y-1 text-[13px] leading-relaxed text-slate-600">
            {rule.criteria.length === 0 ? (
              <p>{tx("Always applies")}</p>
            ) : (
              groupIds.map((gid, gi) => (
                <p key={gid}>
                  <span className="font-medium text-slate-400">{gi === 0 ? tx("If") : tx("or if")} </span>
                  {rule.criteria.filter((c) => c.group_id === gid).map((c, i) => {
                    const p = criterionParts(c);
                    return (
                      <span key={i}>
                        {i > 0 && <span className="font-medium text-slate-400"> {tx("and")} </span>}
                        <span className="text-slate-800">{tx(p.field)}</span> {tx(p.verb)} <span className="font-semibold text-slate-900">{p.value}</span>
                      </span>
                    );
                  })}
                </p>
              ))
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${impact.badge}`}>
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={impact.iconPath} /></svg>
              {tx(impact.label)}
            </span>
            {chips.map((c) => (
              <span key={c.label} className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${c.tone}`}>{c.label}</span>
            ))}
          </div>

          {data.reason && (
            <p className="mt-2.5 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-700">{tx("Why")}: </span>{data.reason}
            </p>
          )}
          {overlaps.length > 0 && (
            <p className="mt-2 text-[11px] text-orange-700">{tx("Overlaps with: {0}", { 0: overlaps.map((r) => r.name).join(", ") })}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="font-mono text-[10px] text-slate-300 group-hover:text-slate-400" title={tx("Reference code")}>{rule.rule_code}</span>
          {editable && (
            <div className="flex items-center gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
              <button onClick={() => onEdit(rule)} className="rounded-lg p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600" aria-label={tx("Edit rule")} title={tx("Edit")}>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
              </button>
              <button onClick={() => onDelete(rule.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={tx("Delete rule")} title={tx("Delete")}>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
