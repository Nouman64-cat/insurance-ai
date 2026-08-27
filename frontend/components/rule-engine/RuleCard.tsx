"use client";

import React, { useState } from "react";
import { RuleDetail, RuleCriteriaDraft } from "@/app/services/ruleEngine";
import { IMPACT_TYPE_CONFIG, criterionSentence, detectOverlap } from "./constants";

interface Props {
  rule: RuleDetail;
  allRules: RuleDetail[];
  isLocked?: boolean;
  isDraft?: boolean;
  authoredBy?: string;
  onEdit: (rule: RuleDetail) => void;
  onDelete: (ruleId: string) => void;
  onDragStart?: (e: React.DragEvent, ruleId: string) => void;
  onDragOver?: (e: React.DragEvent, ruleId: string) => void;
  onDrop?: (e: React.DragEvent, ruleId: string) => void;
}

const FRIENDLY_IMPACT_LABELS: Record<string, string> = {
  extra_mortality_pct: "Extra Mortality",
  flat_extra_per_thousand: "Flat Extra",
  hlv_max_multiple: "HLV Max Multiple",
  reinsurance_retention_limit: "Reinsurance Limit",
  underwriter_authority_level: "Authority Level",
  commission_pct: "Commission Rate",
  withholding_tax_pct: "Withholding Tax",
  medical_profile_codes: "Medical Profile",
  exclusion_riders: "Exclusions",
};

function formatValue(key: string, value: any): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") {
    if (key.includes("pct")) return `${value}%`;
    if (key.includes("limit") || key.includes("flat_extra")) return `${value.toLocaleString()} PKR`;
    if (key.includes("multiple")) return `${value}×`;
  }
  return String(value);
}

function buildConditionsSummary(criteria: RuleCriteriaDraft[]): string {
  if (criteria.length === 0) return "Always applies";
  const groupIds = Array.from(new Set(criteria.map((c) => c.group_id))).sort();
  const groups = groupIds.map((gid) => {
    const group = criteria.filter((c) => c.group_id === gid);
    return group.map((c) => criterionSentence(c)).join(" AND ");
  });
  const full = groups.join(" OR ");
  return full.length > 130 ? full.slice(0, 127) + "…" : full;
}

export default function RuleCard({
  rule, allRules, isLocked = false, isDraft = false, authoredBy, onEdit, onDelete, onDragStart, onDragOver, onDrop,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editable = !isLocked;
  const impactCfg = IMPACT_TYPE_CONFIG[rule.impact_type] || IMPACT_TYPE_CONFIG.AUTO_APPROVE;

  const conflictingRules = allRules
    .filter((r) => r.id !== rule.id)
    .filter((r) => {
      const overlaps = detectOverlap(rule.criteria, r.criteria);
      return overlaps.length > 0;
    });
  const hasConflict = conflictingRules.length > 0;

  const groupIds = Array.from(new Set(rule.criteria.map((c) => c.group_id))).sort();
  const conditionSummary = buildConditionsSummary(rule.criteria);

  // Filter meaningful impact data entries (hide 0 values and empty arrays)
  const activeImpactEntries = Object.entries(rule.impact_data).filter(
    ([k, v]) => k !== "is_terminal" && v !== null && v !== 0 && !(Array.isArray(v) && v.length === 0)
  );

  return (
    <div
      className={`group rounded-xl border bg-white transition-all ${
        expanded ? "border-slate-300 shadow-sm" : "border-slate-200 hover:border-slate-300"
      }`}
      draggable={editable}
      onDragStart={editable ? (e) => onDragStart?.(e, rule.id) : undefined}
      onDragOver={editable ? (e) => onDragOver?.(e, rule.id) : undefined}
      onDrop={editable ? (e) => onDrop?.(e, rule.id) : undefined}
    >
      {/* ── Compact row ─────────────────────────────────────────── */}
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setExpanded((x) => !x)}
      >
        {/* Drag handle */}
        {editable && (
          <div
            className="mt-0.5 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing shrink-0"
            title="Drag to reorder rule priority"
            onClick={(e) => e.stopPropagation()}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M7 2a1 1 0 000 2h6a1 1 0 100-2H7zM7 8a1 1 0 000 2h6a1 1 0 100-2H7zM7 14a1 1 0 000 2h6a1 1 0 100-2H7z" />
            </svg>
          </div>
        )}

        {/* Priority badge */}
        <span className="mt-0.5 inline-block font-mono text-xs font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded shrink-0 min-w-[32px] text-center" title="Evaluation Priority">
          #{rule.priority}
        </span>

        {/* Rule name + code + status */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-slate-900 truncate">
              {rule.name}
            </span>
            <span className="font-mono text-xs text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">
              {rule.rule_code}
            </span>
            {!rule.is_active && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-500 border border-slate-200">
                Inactive
              </span>
            )}
            {rule.impact_data.is_terminal && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-50 text-amber-800 border border-amber-200">
                <svg className="w-3 h-3 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Terminal
              </span>
            )}
            {hasConflict && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-orange-50 text-orange-800 border border-orange-200"
                title={`Overlap with: ${conflictingRules.map((r) => r.name).join(", ")}`}
              >
                <svg className="w-3 h-3 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Overlap
              </span>
            )}
          </div>

          <p className="text-xs text-slate-600 mt-1 leading-relaxed font-mono">
            {conditionSummary}
          </p>
        </div>

        {/* Impact badge */}
        <div className="shrink-0 flex items-center gap-2 mt-0.5">
          <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border uppercase tracking-wider ${impactCfg.badge}`}>
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={impactCfg.iconPath} />
            </svg>
            {impactCfg.label}
          </span>

          <svg
            className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* ── Expanded detail ──────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3 bg-slate-50/50">
          {/* Conditions breakdown */}
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Conditions</h4>
            {rule.criteria.length === 0 ? (
              <p className="text-xs italic text-slate-500">No conditions — rule always applies.</p>
            ) : (
              <div className="space-y-1.5">
                {groupIds.map((gid, idx) => {
                  const group = rule.criteria.filter((c) => c.group_id === gid);
                  return (
                    <div key={gid}>
                      {idx > 0 && (
                        <div className="flex items-center gap-2 my-1">
                          <div className="flex-1 h-px bg-slate-200" />
                          <span className="text-[10px] font-bold text-blue-600 uppercase">OR</span>
                          <div className="flex-1 h-px bg-slate-200" />
                        </div>
                      )}
                      <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-1.5 space-y-0.5">
                        {group.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="font-bold text-blue-600 uppercase w-7 text-right shrink-0">
                              {i === 0 ? "IF" : "AND"}
                            </span>
                            <code className="text-xs text-slate-800 font-mono">
                              {criterionSentence(c)}
                            </code>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Ultra-compact Impact Details pills */}
          {(activeImpactEntries.length > 0 || (rule.action_outcome && rule.action_outcome !== rule.impact_type)) && (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Impact Details</h4>
              <div className="flex items-center gap-2 flex-wrap">
                {rule.action_outcome && rule.action_outcome !== rule.impact_type && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-slate-200 text-xs font-medium text-slate-700">
                    <span className="text-slate-400">Outcome:</span>
                    <span className="font-bold font-mono text-slate-900">{rule.action_outcome}</span>
                  </span>
                )}
                {activeImpactEntries.map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-slate-200 text-xs font-medium text-slate-700">
                    <span className="text-slate-500">{FRIENDLY_IMPACT_LABELS[k] || k}:</span>
                    <span className="font-bold text-slate-900">{formatValue(k, v)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Overlap alert */}
          {hasConflict && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-50 border border-orange-200 rounded-lg">
              <svg className="w-3.5 h-3.5 text-orange-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-xs text-orange-900 font-medium">
                Overlap with: <span className="font-bold">{conflictingRules.map((r) => r.name).join(", ")}</span>
              </p>
            </div>
          )}

          {/* Actions */}
          {editable && (
            <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-700 font-medium">Delete rule?</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(rule.id); }}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg shadow-sm"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                    className="px-3 py-1 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                    className="flex items-center gap-1 px-3 py-1 text-xs font-semibold text-slate-600 hover:text-red-600 hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded-lg transition"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Delete
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onEdit(rule); }}
                    className="flex items-center gap-1 px-3 py-1 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                    Edit Rule
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
