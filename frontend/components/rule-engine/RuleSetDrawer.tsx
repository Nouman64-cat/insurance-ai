"use client";

import { useEffect, useState } from "react";
import { RuleSetDetail, RuleDetail, RuleDraft } from "@/app/services/ruleEngine";
import VersionBar from "./VersionBar";
import RuleCard from "./RuleCard";
import CriteriaGroupBuilder from "./CriteriaGroupBuilder";
import ImpactForm from "./ImpactForm";
import { categoryTone, monogram } from "./constants";
import { tx } from "@/lib/i18n/tx";

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
  onDeleteRule: (id: string, name: string) => void;
  onReorderRules?: (orderedIds: string[]) => void;
  // Edit mode
  isEditMode: boolean;
  editingRule: RuleDetail | null;
  ruleDraft: RuleDraft;
  setRuleDraft: React.Dispatch<React.SetStateAction<RuleDraft>>;
  onSaveRule: (draft: RuleDraft) => void;
  onCancelEdit: () => void;
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">{n}</span>
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Centred dialog for one rule set: its versions, its rules, and the rule editor. */
export default function RuleSetDrawer({
  detail, loadingDetail, selectedVersionId, onSelectVersion, onClose, onCreateVersion, onDeployVersion,
  isDeploying = false, onAddRule, onEditRule, onDeleteRule, isEditMode, editingRule, ruleDraft, setRuleDraft,
  onSaveRule, onCancelEdit,
}: Props) {
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isEditMode) onCancelEdit();
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onCancelEdit, isEditMode]);

  useEffect(() => { setShowAdvanced(false); }, [isEditMode, editingRule]);

  const shell = (body: React.ReactNode) => (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={() => (isEditMode ? undefined : onClose())}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(88vh,900px)] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-2xl animate-in zoom-in-95 duration-200"
      >
        {body}
      </div>
    </div>
  );

  if (loadingDetail || !detail) {
    if (!loadingDetail) return null;
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        <p className="text-xs font-medium text-slate-500">{tx("Loading rules…")}</p>
      </div>,
    );
  }

  const currentVersion = detail.versions.find((v) => v.id === selectedVersionId);
  const isLocked = currentVersion?.status !== "DRAFT";
  const rules = [...(currentVersion?.rules || [])].sort((a, b) => a.priority - b.priority);
  const q = query.trim().toLowerCase();
  const shown = q
    ? rules.filter((r) => [r.name, r.impact_data?.reason, r.rule_code, ...r.criteria.map((c) => c.field_name)]
        .some((t) => String(t ?? "").toLowerCase().replace(/_/g, " ").includes(q)))
    : rules;

  return shell(
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 bg-white px-6 py-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold ring-1 ${categoryTone(detail.category_code)}`}>
            {monogram(detail.name)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-slate-900">{detail.name}</h2>
              {detail.connected ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-100">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{tx("In use")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />{tx("Reference only")}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {detail.connected
                ? tx("Decides: {0}. Publishing a new version changes this decision straight away.", { 0: detail.used_by ?? "" })
                : tx("Not used by the app yet, so changes here don't affect any decision.")}
            </p>
            {detail.description && <p className="mt-1 text-xs text-slate-400 line-clamp-2">{detail.description}</p>}
          </div>
        </div>
        <button onClick={isEditMode ? onCancelEdit : onClose} className="shrink-0 rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" aria-label={tx("Close")}>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {isEditMode ? (
        <>
          {/* Rule editor */}
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <button onClick={onCancelEdit} className="font-medium text-blue-600 hover:underline">{tx("All rules")}</button>
              <span>/</span>
              <span className="font-medium text-slate-700">{editingRule ? editingRule.name : tx("New rule")}</span>
            </div>

            <Step n={1} title={tx("Name this rule")} hint={tx("A short description people will recognise, e.g. “Overweight (BMI 25–29.9)”.")}>
              <input
                type="text"
                autoFocus={!editingRule}
                value={ruleDraft.name}
                onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })}
                placeholder={tx("Rule name")}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </Step>

            <Step n={2} title={tx("When does it apply?")} hint={tx("Add the conditions a profile or application must meet.")}>
              <CriteriaGroupBuilder
                criteria={ruleDraft.criteria}
                onChange={(newCriteria) => setRuleDraft({ ...ruleDraft, criteria: newCriteria })}
              />
            </Step>

            <Step n={3} title={tx("What happens?")} hint={tx("The decision and anything it requires, plus why it matters.")}>
              <ImpactForm
                impactType={ruleDraft.impact_type}
                impactData={ruleDraft.impact_data}
                onChange={(impact_type, impact_data) => setRuleDraft({ ...ruleDraft, impact_type, impact_data })}
              />
            </Step>

            <div className="rounded-2xl border border-slate-200/80 bg-white">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-3.5 text-left text-xs font-semibold text-slate-600"
              >
                {tx("Advanced settings")}
                <svg className={`h-4 w-4 text-slate-400 transition ${showAdvanced ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </button>
              {showAdvanced && (
                <div className="grid grid-cols-1 gap-4 border-t border-slate-100 px-5 py-4 sm:grid-cols-2">
                  <label className="text-xs font-medium text-slate-700">
                    {tx("Reference code")}
                    <input
                      type="text"
                      value={ruleDraft.rule_code ?? ""}
                      onChange={(e) => setRuleDraft({ ...ruleDraft, rule_code: e.target.value })}
                      placeholder={tx("Generated automatically if left blank")}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-700">
                    {tx("Check order")}
                    <input
                      type="number"
                      min={1}
                      value={ruleDraft.priority}
                      onChange={(e) => setRuleDraft({ ...ruleDraft, priority: parseInt(e.target.value) || 10 })}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="mt-1 block text-[11px] font-normal text-slate-400">{tx("Lower numbers are checked first.")}</span>
                  </label>
                  <label className="flex items-start gap-2.5 text-xs text-slate-700 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={!!ruleDraft.impact_data.is_terminal}
                      onChange={(e) => setRuleDraft({ ...ruleDraft, impact_data: { ...ruleDraft.impact_data, is_terminal: e.target.checked } })}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>
                      <span className="font-medium">{tx("Stop checking other rules when this one matches")}</span>
                      <span className="block text-[11px] text-slate-400">{tx("Use for final outcomes such as a decline.")}</span>
                    </span>
                  </label>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200/80 bg-white px-6 py-4">
            <button onClick={onCancelEdit} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              {tx("Cancel")}
            </button>
            <button onClick={() => onSaveRule(ruleDraft)} className="rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700">
              {editingRule ? tx("Save changes") : tx("Add rule")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="border-b border-slate-200/80 bg-white px-6 py-3">
            <VersionBar
              versions={detail.versions}
              selectedVersionId={selectedVersionId}
              onSelectVersion={onSelectVersion}
              onCreateVersion={onCreateVersion}
              onDeployVersion={onDeployVersion}
              isDeploying={isDeploying}
              inUse={!!detail.connected}
            />
          </div>

          {/* Rules */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-semibold text-slate-900">
                {tx("Rules")} <span className="font-normal text-slate-400">{rules.length}</span>
              </h3>
              {rules.length > 4 && (
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tx("Find a rule…")}
                  className="min-w-[180px] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              )}
              {!isLocked && (
                <button
                  type="button"
                  onClick={onAddRule}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                  {tx("Add rule")}
                </button>
              )}
            </div>

            {rules.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center">
                <p className="text-sm font-medium text-slate-700">{tx("No rules in this version yet")}</p>
                {!isLocked && (
                  <button onClick={onAddRule} className="mt-2 text-xs font-semibold text-blue-600 hover:underline">{tx("Add the first rule")}</button>
                )}
              </div>
            ) : shown.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-xs text-slate-500">{tx("No rule matches “{0}”.", { 0: query })}</p>
            ) : (
              <div className="space-y-2.5">
                {shown.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    allRules={rules}
                    isLocked={isLocked}
                    onEdit={() => onEditRule(rule)}
                    onDelete={() => onDeleteRule(rule.id, rule.name)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>,
  );
}
