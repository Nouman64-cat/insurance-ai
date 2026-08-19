"use client";

import React, { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { RULE_CODE_REGEX } from "./constants";
import HierarchyTree from "./HierarchyTree";
import RuleSetList from "./RuleSetList";
import RuleSetDrawer from "./RuleSetDrawer";
import { useRuleSets } from "./useRuleSets";

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
  } = useRuleSets(tenantId);

  const { notify } = useNotify();
  const [codeError, setCodeError] = useState("");
  const [depthLevel, setDepthLevel] = useState<1 | 2 | 3>(1);
  const [navSearch, setNavSearch] = useState("");

  useEffect(() => {
    load();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global Escape key handler for modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showCreateSet) {
        setShowCreateSet(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showCreateSet]);

  const handleCodeChange = (v: string) => {
    setNewSetCode(v);
    if (v && !RULE_CODE_REGEX.test(v)) {
      setCodeError('Format: lowercase.dotted_code (e.g. medical.nml_grid)');
    } else {
      setCodeError("");
    }
  };

  return (
    <>
      {/* Spacious Three-panel layout (4 columns navigation, 8 columns rule list) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-auto lg:h-[calc(100vh-190px)] min-h-[600px]">
        {/* LEFT: Hierarchy nav (4 cols for breathing room) */}
        <div className="lg:col-span-4 flex flex-col overflow-y-auto min-h-0 pr-1">
          {/* Panel header */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">Navigation</h2>
              {(filter.categoryCode || filter.subcategoryCode || navSearch) && (
                <button
                  onClick={() => {
                    clearFilter();
                    setNavSearch("");
                  }}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  Reset Filter
                </button>
              )}
            </div>

            {/* Navigation Search Bar */}
            <div className="relative mb-2">
              <svg className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={navSearch}
                onChange={(e) => setNavSearch(e.target.value)}
                placeholder="Search categories or rule sets..."
                className="w-full pl-8 pr-7 py-1.5 text-xs border border-slate-200 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium"
              />
              {navSearch && (
                <button
                  type="button"
                  onClick={() => setNavSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Clean Segmented Depth Level Switcher */}
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100/90 rounded-xl border border-slate-200/80">
              <button
                type="button"
                onClick={() => {
                  setDepthLevel(1);
                  clearFilter();
                }}
                className={`py-1.5 px-2 text-xs font-bold rounded-lg transition text-center cursor-pointer ${
                  depthLevel === 1 && !filter.categoryCode
                    ? "bg-white text-blue-700 shadow-sm border border-slate-200/80"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Categories
              </button>
              <button
                type="button"
                onClick={() => setDepthLevel(2)}
                className={`py-1.5 px-2 text-xs font-bold rounded-lg transition text-center cursor-pointer ${
                  depthLevel === 2
                    ? "bg-white text-indigo-700 shadow-sm border border-slate-200/80"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Subcategories
              </button>
              <button
                type="button"
                onClick={() => setDepthLevel(3)}
                className={`py-1.5 px-2 text-xs font-bold rounded-lg transition text-center cursor-pointer ${
                  depthLevel === 3
                    ? "bg-white text-slate-900 shadow-sm border border-slate-200/80"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                All Rule Sets
              </button>
            </div>
          </div>

          <HierarchyTree
            categories={categories}
            ruleSets={allRuleSets}
            value={filter}
            onChange={handleFilterChange}
            onSelectRuleSet={openDetail}
            selectedRuleSetId={selectedRuleSetId}
            depthLevel={depthLevel}
            searchQuery={navSearch}
          />
        </div>

        {/* CENTER: Rule set list (8 cols) */}
        <div className="lg:col-span-8 flex flex-col overflow-y-auto min-h-0">
          {/* Breadcrumb context */}
          {(filter.categoryCode || filter.subcategoryCode) && (
            <div className="flex items-center gap-2 mb-3 px-1 py-1 text-xs text-slate-600 bg-slate-50 border border-slate-200/60 rounded-lg w-fit">
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
              <span className="font-bold text-slate-900">
                {categories.find((c) => c.code === filter.categoryCode)?.name || filter.categoryCode}
              </span>
              {filter.subcategoryCode && (
                <>
                  <svg className="w-3.5 h-3.5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="font-semibold text-slate-700">
                    {categories.find((c) => c.code === filter.categoryCode)?.subcategories.find((s) => s.code === filter.subcategoryCode)?.name || filter.subcategoryCode}
                  </span>
                </>
              )}
            </div>
          )}
          <RuleSetList
            ruleSets={ruleSets}
            loading={loading}
            selectedId={selectedRuleSetId}
            onSelect={openDetail}
            onCreateNew={() => setShowCreateSet(true)}
            onClearFilter={() => {
              clearFilter();
              setNavSearch("");
            }}
            isFiltered={!!(filter.categoryCode || filter.subcategoryCode || navSearch)}
          />
        </div>
      </div>

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
          onDeleteRule={handleDeleteRule}
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
                <h2 className="text-base font-bold text-slate-900">New Rule Set</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Group related decision rules under a category scope.
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
                  Category & SubCategory Scope <span className="text-red-500">*</span>
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
                  Rule Set Code <span className="text-red-500">*</span>
                </label>
                <input
                  value={newSetCode}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  placeholder="e.g. medical.nml_grid"
                  className={`w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 transition ${
                    codeError ? "border-red-300 focus:ring-red-400" : "border-slate-200 focus:ring-blue-500 focus:border-blue-400"
                  }`}
                  required
                />
                {codeError ? (
                  <p className="text-[11px] text-red-500 mt-1">{codeError}</p>
                ) : (
                  <p className="text-[11px] text-slate-400 mt-1">Format: lowercase.dotted_code</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  value={newSetName}
                  onChange={(e) => setNewSetName(e.target.value)}
                  placeholder="e.g. Non-Medical Limit Underwriting Grid"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
                <textarea
                  value={newSetDesc}
                  onChange={(e) => setNewSetDesc(e.target.value)}
                  rows={2}
                  placeholder="Brief description of what this rule set governs…"
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
                Cancel
              </button>
              <button
                type="submit"
                disabled={!!codeError}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                Create Rule Set
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
