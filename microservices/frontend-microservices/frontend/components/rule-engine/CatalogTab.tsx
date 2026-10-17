"use client";

import React, { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { RULE_CODE_REGEX } from "./constants";
import HierarchyTree from "./HierarchyTree";
import RuleSetList from "./RuleSetList";
import ScrollChips from "./ScrollChips";
import RuleSetDrawer from "./RuleSetDrawer";
import { useRuleSets } from "./useRuleSets";
import { tx } from "@/lib/i18n/tx";

export default function CatalogTab({ tenantId }: { tenantId: string }) {
  const {
    // Catalog
    categories, allRuleSets, ruleSets, filter, loading,
    handleFilterChange, clearFilter, load,
    // Drawer
    selectedRuleSetId, detail, loadingDetail, selectedVersionId, setSelectedVersionId,
    isDeploying, openDetail, closeDetail,
    // Edit mode
    isEditMode, editingRule, ruleDraft, setRuleDraft,
    openAddRule, openEditRule, cancelEditMode, handleSaveRule, handleDeleteRule,
    handleReorderRules,
    // Versions
    handleCreateVersion, handleDeployVersion,
    // Create rule set
    showCreateSet, setShowCreateSet,
    newSetScope, setNewSetScope,
    newSetCode, setNewSetCode,
    newSetName, setNewSetName,
    newSetDesc, setNewSetDesc,
    handleCreateRuleSet,
    // Create category
    showCreateCategory, setShowCreateCategory,
    newCatCode, setNewCatCode,
    newCatName, setNewCatName,
    newCatDesc, setNewCatDesc,
    handleCreateCategory,
    // Create subcategory
    showCreateSubCategory, setShowCreateSubCategory,
    newSubCategoryId, setNewSubCategoryId,
    newSubCode, setNewSubCode,
    newSubName, setNewSubName,
    openCreateSubCategoryModal,
    handleCreateSubCategory,
    deletePrompt, setDeletePrompt,
    handleDeleteCategory, handleDeleteSubCategory, handleDeleteRuleSet,
  } = useRuleSets(tenantId);

  const { notify } = useNotify();
  const [codeError, setCodeError] = useState("");
  const [connection, setConnection] = useState<"all" | "connected" | "unconnected">("all");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showManage, setShowManage] = useState(false);

  useEffect(() => {
    load();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global Escape key handler for modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showCreateSet) setShowCreateSet(false);
        if (showCreateCategory) setShowCreateCategory(false);
        if (showCreateSubCategory) setShowCreateSubCategory(false);
        if (showManage) setShowManage(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showCreateSet, showCreateCategory, showCreateSubCategory, showManage]);

  /** "Claims Management & Settlement" → "CLAIMS_MANAGEMENT_SETTLEMENT" */
  const toCode = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  /** Next free RS-<AREA>-NNN code for a new rule set. */
  const suggestSetCode = (name: string) => {
    const area = (name.replace(/[^A-Za-z]/g, "").slice(0, 4) || "GEN").toUpperCase();
    const used = new Set(allRuleSets.map((r) => r.rule_code));
    let n = 1;
    while (used.has(`RS-${area}-${String(n).padStart(3, "0")}`)) n++;
    return `RS-${area}-${String(n).padStart(3, "0")}`;
  };

  const handleCodeChange = (v: string) => {
    setNewSetCode(v);
    if (v && !RULE_CODE_REGEX.test(v)) {
      setCodeError(tx("Use RS-AREA-000 (e.g. RS-MED-005) or lowercase.dotted_code"));
    } else {
      setCodeError("");
    }
  };

  const categoryNames: Record<string, string> = Object.fromEntries(categories.map((c) => [c.code, c.name]));
  const q = search.trim().toLowerCase();
  const visible = allRuleSets.filter((rs) =>
    (connection === "all" || (connection === "connected" ? rs.connected : !rs.connected)) &&
    (!categoryFilter || rs.category_code === categoryFilter) &&
    (!q || [rs.name, rs.description, rs.rule_code, rs.used_by, categoryNames[rs.category_code ?? ""]]
      .some((t) => (t ?? "").toLowerCase().includes(q))));
  const inUse = allRuleSets.filter((r) => r.connected);
  const totalRules = allRuleSets.reduce((n, r) => n + (r.rule_count || 0), 0);
  const categoryCounts = categories
    .map((c) => ({ ...c, count: allRuleSets.filter((r) => r.category_code === c.code).length }))
    .filter((c) => c.count > 0);
  const isFiltered = !!(q || categoryFilter || connection !== "all");
  const clearAll = () => { setSearch(""); setCategoryFilter(null); setConnection("all"); clearFilter(); };

  return (
    <>
      {/* Summary */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button type="button" onClick={() => setConnection("connected")} className="rounded-2xl border border-slate-200/80 bg-white p-4 text-left shadow-sm transition hover:shadow-md">
          <p className="text-xs font-medium text-slate-500">{tx("In use by the app")}</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{inUse.length}</p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{inUse.map((r) => r.name).join(" · ") || "—"}</p>
        </button>
        <button type="button" onClick={() => setConnection("unconnected")} className="rounded-2xl border border-slate-200/80 bg-white p-4 text-left shadow-sm transition hover:shadow-md">
          <p className="text-xs font-medium text-slate-500">{tx("Reference only")}</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{allRuleSets.length - inUse.length}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">{tx("Documented, not yet used in decisions")}</p>
        </button>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">{tx("Rules in total")}</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{totalRules}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">{tx("across {0} rule sets in {1} areas", { 0: allRuleSets.length, 1: categoryCounts.length })}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="sticky top-0 z-10 -mx-1 mb-6 space-y-3 bg-slate-50/80 px-1 pb-3 pt-1 backdrop-blur supports-[backdrop-filter]:bg-slate-50/60">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <svg className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tx("Search rules, e.g. smoking, BMI, knockout…")}
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm" role="tablist" aria-label={tx("Show")}>
            {([["all", tx("All")], ["connected", tx("In use")], ["unconnected", tx("Reference")]] as const).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={connection === key}
                onClick={() => setConnection(key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${connection === key ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowManage(true)}
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            {tx("Manage areas")}
          </button>
          <button
            type="button"
            onClick={() => setShowCreateSet(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            {tx("New rule set")}
          </button>
        </div>
        <ScrollChips>
          <button
            type="button"
            onClick={() => setCategoryFilter(null)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${!categoryFilter ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          >
            {tx("All areas")}
          </button>
          {categoryCounts.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => setCategoryFilter(categoryFilter === c.code ? null : c.code)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${categoryFilter === c.code ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
            >
              {c.name} <span className={categoryFilter === c.code ? "text-slate-300" : "text-slate-400"}>{c.count}</span>
            </button>
          ))}
        </ScrollChips>
      </div>

      <RuleSetList
        ruleSets={visible}
        categoryNames={categoryNames}
        loading={loading}
        selectedId={selectedRuleSetId}
        onSelect={openDetail}
        onCreateNew={() => setShowCreateSet(true)}
        isFiltered={isFiltered}
        onClearFilter={clearAll}
      />

      {/* Manage areas (categories & subcategories) */}
      {showManage && (
        <div
          className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setShowManage(false)}
          role="dialog"
          aria-modal="true"
        >
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-5">
              <div>
                <h2 className="text-base font-semibold text-slate-900">{tx("Manage areas")}</h2>
                <p className="mt-0.5 text-xs text-slate-500">{tx("Areas group rule sets, e.g. Underwriting Risk. Open the ⋯ menu on an item to delete it.")}</p>
              </div>
              <button onClick={() => setShowManage(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={tx("Close")}>
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <HierarchyTree
                categories={categories}
                ruleSets={allRuleSets}
                value={filter}
                onChange={handleFilterChange}
                onSelectRuleSet={(id) => { setShowManage(false); openDetail(id); }}
                selectedRuleSetId={selectedRuleSetId}
                depthLevel={1}
                searchQuery=""
                onAction={(type, _action, id, name) => setDeletePrompt({ type, id, name })}
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4">
              <button onClick={openCreateSubCategoryModal} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                {tx("New sub-area")}
              </button>
              <button onClick={() => setShowCreateCategory(true)} className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800">
                {tx("New area")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RIGHT: Drawer */}
      {selectedRuleSetId && (
        <RuleSetDrawer
          detail={detail}
          loadingDetail={loadingDetail}
          selectedVersionId={selectedVersionId}
          onSelectVersion={setSelectedVersionId}
          onClose={closeDetail}
          onCreateVersion={handleCreateVersion}
          onDeployVersion={handleDeployVersion}
          isDeploying={isDeploying}
          onAddRule={openAddRule}
          onEditRule={openEditRule}
          onDeleteRule={(id, name) => setDeletePrompt({ type: 'rule', id, name })}
          onReorderRules={handleReorderRules}
          isEditMode={isEditMode}
          editingRule={editingRule}
          ruleDraft={ruleDraft}
          setRuleDraft={setRuleDraft}
          onSaveRule={handleSaveRule}
          onCancelEdit={cancelEditMode}
        />
      )}

      {/* Create Rule Set Modal */}
      {showCreateSet && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
          onClick={() => setShowCreateSet(false)}
          role="dialog"
          aria-modal="true"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateRuleSet}
            className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">{tx("New rule set")}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tx("A rule set groups the rules for one decision, e.g. “Smoker loadings”.")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateSet(false)}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {tx("Area")}{" "}<span className="text-red-500">*</span>
                </label>
                <HierarchyTree
                  categories={categories}
                  value={newSetScope}
                  onChange={setNewSetScope}
                  allowGlobalOption
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Reference code")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSetCode}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  placeholder={tx("e.g. RS-MED-005")}
                  className={`w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 transition ${
                    codeError ? "border-red-300 focus:ring-red-400" : "border-slate-200 focus:ring-blue-500 focus:border-blue-400"
                  }`}
                  required
                />
                {codeError ? (
                  <p className="text-[11px] text-red-500 mt-1">{codeError}</p>
                ) : (
                  <p className="text-[11px] text-slate-400 mt-1">{tx("Filled in from the name — change it only if you need a specific code.")}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Name")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSetName}
                  onChange={(e) => {
                    const prev = newSetName;
                    setNewSetName(e.target.value);
                    if (!newSetCode || newSetCode === suggestSetCode(prev)) setNewSetCode(e.target.value ? suggestSetCode(e.target.value) : "");
                  }}
                  placeholder={tx("e.g. Non-Medical Limit Underwriting Grid")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{tx("Description")}</label>
                <textarea
                  value={newSetDesc}
                  onChange={(e) => setNewSetDesc(e.target.value)}
                  rows={2}
                  placeholder={tx("What does this rule set decide?")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition resize-none"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowCreateSet(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition"
              >
                {tx("Cancel")}
              </button>
              <button
                type="submit"
                disabled={!!codeError}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                {tx("Create rule set")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create Category Modal */}
      {showCreateCategory && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
          onClick={() => setShowCreateCategory(false)}
          role="dialog"
          aria-modal="true"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateCategory}
            className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">{tx("New area")}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tx("Areas group related rule sets, e.g. Underwriting or Claims.")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateCategory(false)}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Reference code")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newCatCode}
                  onChange={(e) => setNewCatCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                  placeholder={tx("e.g. CLAIMS_MANAGEMENT")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono uppercase focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">{tx("Filled in from the name.")}</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Area name")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newCatName}
                  onChange={(e) => {
                    if (!newCatCode || newCatCode === toCode(newCatName)) setNewCatCode(toCode(e.target.value));
                    setNewCatName(e.target.value);
                  }}
                  placeholder={tx("e.g. Claims Management & Settlement")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{tx("Description")}</label>
                <textarea
                  value={newCatDesc}
                  onChange={(e) => setNewCatDesc(e.target.value)}
                  rows={2}
                  placeholder={tx("What kind of decisions live here?")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition resize-none"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowCreateCategory(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition"
              >
                {tx("Cancel")}
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                {tx("Create area")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create SubCategory Modal */}
      {showCreateSubCategory && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
          onClick={() => setShowCreateSubCategory(false)}
          role="dialog"
          aria-modal="true"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateSubCategory}
            className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">{tx("New sub-area")}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tx("A smaller group inside an area, e.g. Death claims under Claims.")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateSubCategory(false)}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Inside area")}{" "}<span className="text-red-500">*</span>
                </label>
                <select
                  value={newSubCategoryId}
                  onChange={(e) => setNewSubCategoryId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition bg-white"
                  required
                >
                  <option value="" disabled>{tx("Choose an area…")}</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name} ({cat.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Reference code")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSubCode}
                  onChange={(e) => setNewSubCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                  placeholder={tx("e.g. DEATH_CLAIMS")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono uppercase focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">{tx("Filled in from the name.")}</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Sub-area name")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSubName}
                  onChange={(e) => {
                    if (!newSubCode || newSubCode === toCode(newSubName)) setNewSubCode(toCode(e.target.value));
                    setNewSubName(e.target.value);
                  }}
                  placeholder={tx("e.g. Death Benefit Claims")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowCreateSubCategory(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition"
              >
                {tx("Cancel")}
              </button>
              <button
                type="submit"
                disabled={!newSubCategoryId}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                {tx("Create sub-area")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletePrompt && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
          onClick={() => setDeletePrompt(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full max-w-sm rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">{tx("Confirm Deletion")}</h2>
              <p className="text-xs text-slate-500 mt-2">
                {tx("Delete")}{" "}<strong>{deletePrompt.name}</strong>?
                {deletePrompt.type === 'ruleset' && " " + tx("All its versions and rules are deleted too.")}
                {deletePrompt.type === 'category' && " " + tx("It must not contain any sub-areas.")}
                {deletePrompt.type === 'subcategory' && " " + tx("It must not contain any rule sets.")}
              </p>
              <p className="text-xs text-red-500 mt-1 font-semibold">{tx("This action cannot be undone.")}</p>
            </div>
            <div className="px-6 py-4 flex justify-end gap-2 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setDeletePrompt(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition"
              >
                {tx("Cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (deletePrompt.type === 'category') handleDeleteCategory(deletePrompt.id);
                  else if (deletePrompt.type === 'subcategory') handleDeleteSubCategory(deletePrompt.id);
                  else if (deletePrompt.type === 'ruleset') handleDeleteRuleSet(deletePrompt.id);
                  else if (deletePrompt.type === 'rule') handleDeleteRule(deletePrompt.id);
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                {tx("Delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

