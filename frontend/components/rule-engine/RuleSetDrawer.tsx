"use client";

import { useEffect } from "react";
import { RuleSetDetail, RuleDetail, RuleDraft } from "@/app/services/ruleEngine";
import VersionBar from "./VersionBar";
import RuleCard from "./RuleCard";
import CriteriaGroupBuilder from "./CriteriaGroupBuilder";
import ImpactForm from "./ImpactForm";

interface Props {
  detail: RuleSetDetail | null;
  loadingDetail: boolean;
  selectedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  onClose: () => void;
  onCreateVersion: () => void;
  onDeployVersion: (id: string) => void;
  isDeploying?: boolean;
  onAddRule: () => void;
  onEditRule: (rule: RuleDetail) => void;
  onDeleteRule: (id: string) => void;
  onReorderRules?: (orderedIds: string[]) => void;
  // Edit mode
  isEditMode: boolean;
  editingRule: RuleDetail | null;
  ruleDraft: RuleDraft;
  setRuleDraft: React.Dispatch<React.SetStateAction<RuleDraft>>;
  onSaveRule: (draft: RuleDraft) => void;
  onCancelEdit: () => void;
}

export default function RuleSetDrawer({
  detail,
  loadingDetail,
  selectedVersionId,
  onSelectVersion,
  onClose,
  onCreateVersion,
  onDeployVersion,
  isDeploying = false,
  onAddRule,
  onEditRule,
  onDeleteRule,
  onReorderRules,
  isEditMode,
  editingRule,
  ruleDraft,
  setRuleDraft,
  onSaveRule,
  onCancelEdit,
}: Props) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditMode) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, isEditMode]);

  if (loadingDetail) {
    return (
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[680px] bg-white border-l border-slate-200 shadow-2xl p-6 flex flex-col justify-center items-center">
        <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-xs text-slate-500 font-medium">Loading details...</p>
      </div>
    );
  }

  if (!detail) return null;

  const currentVersion = detail.versions.find((v) => v.id === selectedVersionId);
  const isLocked = currentVersion?.status === "ACTIVE" || currentVersion?.status === "ARCHIVED";
  const rules = currentVersion?.rules || [];

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-full max-w-[680px] bg-white border-l border-slate-200 shadow-2xl transition-all flex flex-col"
      role="dialog"
      aria-modal="true"
    >
      {/* Drawer Header */}
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/70 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-bold text-slate-900 truncate">{detail.name}</h2>
          <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 shrink-0">
            {detail.rule_code}
          </span>
          {isLocked && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded shrink-0">
              Locked
            </span>
          )}
        </div>

        <button
          onClick={onClose}
          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition shrink-0"
          title="Close (Esc)"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Main Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Version Bar */}
        <VersionBar
          versions={detail.versions}
          selectedVersionId={selectedVersionId}
          onSelectVersion={onSelectVersion}
          onCreateVersion={onCreateVersion}
          onDeployVersion={onDeployVersion}
          isDeploying={isDeploying}
        />

        {/* Edit Rule Form Mode */}
        {isEditMode ? (
          <div className="space-y-4 py-1">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-sm font-bold text-slate-900">
                {editingRule ? `Edit: ${editingRule.name}` : "New Decision Rule"}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => onSaveRule(ruleDraft)}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm transition"
                >
                  Save Rule
                </button>
              </div>
            </div>

            {/* Basic Info Inputs */}
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-6">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Rule Name *</label>
                <input
                  type="text"
                  value={ruleDraft.name}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })}
                  placeholder="e.g. Moderate BMI Loading"
                  className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="col-span-4">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Rule Code *</label>
                <input
                  type="text"
                  value={ruleDraft.rule_code}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, rule_code: e.target.value })}
                  placeholder="e.g. bmi_30_35"
                  className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Priority *</label>
                <input
                  type="number"
                  value={ruleDraft.priority}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, priority: parseInt(e.target.value) || 10 })}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono font-bold text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Matching Criteria */}
            <div className="pt-1">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Matching Criteria
              </h4>
              <CriteriaGroupBuilder
                criteria={ruleDraft.criteria}
                onChange={(newCriteria) => setRuleDraft({ ...ruleDraft, criteria: newCriteria })}
              />
            </div>

            {/* Impact Form */}
            <div className="pt-1">
              <ImpactForm
                impactType={ruleDraft.impact_type}
                impactData={ruleDraft.impact_data}
                onChange={(impact_type, impact_data) => setRuleDraft({ ...ruleDraft, impact_type, impact_data })}
              />
            </div>
          </div>
        ) : (
          /* Browse Rules Mode */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Decision Rules ({rules.length})
              </h3>
              {!isLocked && (
                <button
                  type="button"
                  onClick={onAddRule}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm transition cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Rule
                </button>
              )}
            </div>

            {rules.length === 0 ? (
              <div className="border border-dashed border-slate-200 rounded-xl p-8 text-center bg-slate-50/50">
                <p className="text-xs text-slate-500 italic">No rules defined in this version.</p>
                {!isLocked && (
                  <button
                    onClick={onAddRule}
                    className="mt-2 text-xs font-bold text-blue-600 hover:underline"
                  >
                    + Add your first rule
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {rules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    allRules={rules}
                    isLocked={isLocked}
                    onEdit={() => onEditRule(rule)}
                    onDelete={() => onDeleteRule(rule.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
