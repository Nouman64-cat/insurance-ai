"use client";

import React, { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { RULE_CODE_REGEX } from "./constants";
import HierarchyTree from "./HierarchyTree";
import RuleSetList from "./RuleSetList";
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
  const [depthLevel, setDepthLevel] = useState<1 | 2 | 3>(1);
  const [navSearch, setNavSearch] = useState("");

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
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showCreateSet, showCreateCategory, showCreateSubCategory]);

  const handleCodeChange = (v: string) => {
    setNewSetCode(v);
    if (v && !RULE_CODE_REGEX.test(v)) {
      setCodeError(tx("Format: lowercase.dotted_code (e.g. medical.nml_grid)"));
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
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">{tx("Navigation")}</h2>
              {(filter.categoryCode || filter.subcategoryCode || navSearch) && (
                <button
                  onClick={() => {
                    clearFilter();
                    setNavSearch("");
                  }}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  {tx("Reset Filter")}
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
                placeholder={tx("Search categories or rule sets...")}
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
                {tx("Categories")}
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
                {tx("Subcategories")}
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
                {tx("All Rule Sets")}
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
            onAction={(type, action, id, name) => {
              if (action === 'delete') {
                setDeletePrompt({ type, id, name });
              } else if (action === 'rename') {
                alert("Rename functionality is coming soon!");
              }
            }}
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
            onCreateCategory={() => setShowCreateCategory(true)}
            onCreateSubCategory={openCreateSubCategoryModal}
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
                <h2 className="text-base font-bold text-slate-900">{tx("Add New Rule Set")}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tx("Group related decision rules under a category scope.")}
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
                  {tx("Category & SubCategory Scope")}{" "}<span className="text-red-500">*</span>
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
                  {tx("Rule Set Code")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSetCode}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  placeholder={tx("e.g. medical.nml_grid")}
                  className={`w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 transition ${
                    codeError ? "border-red-300 focus:ring-red-400" : "border-slate-200 focus:ring-blue-500 focus:border-blue-400"
                  }`}
                  required
                />
                {codeError ? (
                  <p className="text-[11px] text-red-500 mt-1">{codeError}</p>
                ) : (
                  <p className="text-[11px] text-slate-400 mt-1">{tx("Format: lowercase.dotted_code")}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Name")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSetName}
                  onChange={(e) => setNewSetName(e.target.value)}
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
                  placeholder={tx("Brief description of what this rule set governs…")}
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
                {tx("Create Rule Set")}
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
                <h2 className="text-base font-bold text-slate-900">{tx("Add New Category")}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tx("Create a top-level rule category (e.g., UNDERWRITING, CLAIMS).")}
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
                  {tx("Category Code")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newCatCode}
                  onChange={(e) => setNewCatCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                  placeholder={tx("e.g. CLAIMS_MANAGEMENT")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono uppercase focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">{tx("Unique uppercase code (e.g. UNDERWRITING_GATES)")}</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("Category Name")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
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
                  placeholder={tx("Brief description of what this domain governs…")}
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
                {tx("Create Category")}
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
                <h2 className="text-base font-bold text-slate-900">{tx("Add New Sub Category")}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tx("Create a sub-domain under an existing parent category.")}
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
                  {tx("Parent Category")}{" "}<span className="text-red-500">*</span>
                </label>
                <select
                  value={newSubCategoryId}
                  onChange={(e) => setNewSubCategoryId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition bg-white"
                  required
                >
                  <option value="" disabled>{tx("Select Parent Category...")}</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name} ({cat.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("SubCategory Code")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSubCode}
                  onChange={(e) => setNewSubCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                  placeholder={tx("e.g. DEATH_CLAIMS")}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono uppercase focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 transition"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">{tx("Unique uppercase code (e.g. ACCIDENTAL_DEATH)")}</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {tx("SubCategory Name")}{" "}<span className="text-red-500">*</span>
                </label>
                <input
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
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
                {tx("Create SubCategory")}
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
                {tx("Are you sure you want to delete the")}{" "}{deletePrompt.type} <strong>{deletePrompt.name}</strong>?
                {deletePrompt.type === 'ruleset' && " " + tx("All associated versions and rules will also be deleted.")}
                {deletePrompt.type === 'category' && " " + tx("Make sure it has no subcategories.")}
                {deletePrompt.type === 'subcategory' && " " + tx("Make sure it has no rule sets.")}
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
                {tx("Delete")}{" "}{deletePrompt.type}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

