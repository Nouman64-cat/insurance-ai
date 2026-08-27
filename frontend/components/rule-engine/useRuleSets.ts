"use client";

import { useState, useCallback, useRef } from "react";
import { useNotify } from "@/components/NotificationContext";
import {
  Category, RuleSetSummary, RuleSetDetail, RuleDetail, RuleDraft, ScopeType,
  listCategories, createCategory, createSubCategory, listRuleSets, createRuleSet, getRuleSetDetail, createRuleVersion,
  updateVersionStatus, addRuleToVersion, updateRule, deleteRule,
  deleteCategory, deleteSubCategory, deleteRuleSet,
  DEFAULT_IMPACT_DATA, ImpactType,
} from "@/app/services/ruleEngine";
import { HierarchySelection } from "./HierarchyTree";

export interface RuleFormState extends RuleDraft {
  // nothing extra — kept separate so callers can widen if needed
}

export type DeletePromptType = 'category' | 'subcategory' | 'ruleset' | 'rule';
export interface DeletePromptState {
  type: DeletePromptType;
  id: string;
  name: string;
}

const EMPTY_RULE_DRAFT = (): RuleFormState => ({
  name: "",
  rule_code: "",
  priority: 100,
  is_active: true,
  impact_type: "AUTO_APPROVE" as ImpactType,
  impact_data: { ...DEFAULT_IMPACT_DATA },
  action_outcome: "",
  criteria: [],
});

export function useRuleSets(tenantId: string) {
  const { notify } = useNotify();

  // ── Catalog state ──────────────────────────────────────────────────────
  const [categories, setCategories] = useState<Category[]>([]);
  const [allRuleSets, setAllRuleSets] = useState<RuleSetSummary[]>([]); // Unfiltered catalog for hierarchy counts
  const [ruleSets, setRuleSets] = useState<RuleSetSummary[]>([]); // Filtered catalog for center list
  const [filter, setFilter] = useState<HierarchySelection>({
    categoryCode: null,
    subcategoryCode: null,
    channelCode: null,
  });
  const [loading, setLoading] = useState(true);
  const reqSequenceRef = useRef(0); // Race condition guard

  // ── Drawer / detail state ──────────────────────────────────────────────
  const [selectedRuleSetId, setSelectedRuleSetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RuleSetDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);

  // ── Rule editor state ──────────────────────────────────────────────────
  const [editingRule, setEditingRule] = useState<RuleDetail | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleFormState>(EMPTY_RULE_DRAFT());
  const [isEditMode, setIsEditMode] = useState(false);

  // ── Delete confirmation modal state ────────────────────────────────────
  const [deletePrompt, setDeletePrompt] = useState<DeletePromptState | null>(null);

  // ── Create rule-set modal state ────────────────────────────────────────
  const [showCreateSet, setShowCreateSet] = useState(false);
  const [newSetScope, setNewSetScope] = useState<HierarchySelection>({
    categoryCode: null,
    subcategoryCode: null,
    channelCode: null,
  });
  const [newSetCode, setNewSetCode] = useState("");
  const [newSetName, setNewSetName] = useState("");
  const [newSetDesc, setNewSetDesc] = useState("");

  // ── Create category modal state ────────────────────────────────────────
  const [showCreateCategory, setShowCreateCategory] = useState(false);
  const [newCatCode, setNewCatCode] = useState("");
  const [newCatName, setNewCatName] = useState("");
  const [newCatDesc, setNewCatDesc] = useState("");

  // ── Create subcategory modal state ─────────────────────────────────────
  const [showCreateSubCategory, setShowCreateSubCategory] = useState(false);
  const [newSubCategoryId, setNewSubCategoryId] = useState("");
  const [newSubCode, setNewSubCode] = useState("");
  const [newSubName, setNewSubName] = useState("");

  // ── Load catalog (with race guard & unfiltered count sync) ─────────────
  const load = useCallback(
    async (f?: HierarchySelection) => {
      const currentReq = ++reqSequenceRef.current;
      setLoading(true);
      try {
        const activeFilter = f ?? filter;
        const [cats, unfilteredSets, filteredSets] = await Promise.all([
          listCategories(tenantId),
          listRuleSets(tenantId, {}), // Load unfiltered once for hierarchy counts
          listRuleSets(tenantId, {
            category: activeFilter.categoryCode || undefined,
            subcategory: activeFilter.subcategoryCode || undefined,
            channel: activeFilter.channelCode || undefined,
          }),
        ]);

        if (currentReq === reqSequenceRef.current) {
          setCategories(cats);
          setAllRuleSets(unfilteredSets);
          setRuleSets(filteredSets);
        }
      } catch (err: any) {
        if (currentReq === reqSequenceRef.current) {
          notify(err.message || "Failed to load rule catalog.", false);
        }
      } finally {
        if (currentReq === reqSequenceRef.current) {
          setLoading(false);
        }
      }
    },
    [tenantId, filter, notify]
  );

  const handleFilterChange = useCallback(
    (f: HierarchySelection) => {
      setFilter(f);
      load(f);
    },
    [load]
  );

  const clearFilter = useCallback(() => {
    const empty: HierarchySelection = { categoryCode: null, subcategoryCode: null, channelCode: null };
    setFilter(empty);
    load(empty);
  }, [load]);

  // ── Open / close detail drawer ─────────────────────────────────────────
  const openDetail = useCallback(
    async (id: string) => {
      setSelectedRuleSetId(id);
      setIsEditMode(false);
      setLoadingDetail(true);
      try {
        const d = await getRuleSetDetail(tenantId, id);
        setDetail(d);
        const active = d.versions.find((v) => v.status === "ACTIVE") || d.versions[0];
        setSelectedVersionId(active?.id || null);
      } catch (err: any) {
        notify(err.message || "Failed to load rule set.", false);
      } finally {
        setLoadingDetail(false);
      }
    },
    [tenantId, notify]
  );

  const closeDetail = useCallback(() => {
    setSelectedRuleSetId(null);
    setDetail(null);
    setSelectedVersionId(null);
    setIsEditMode(false);
    setEditingRule(null);
  }, []);

  // ── Refresh detail in-place (after mutations) ──────────────────────────
  const refreshDetail = useCallback(
    async (keepVersionId?: string) => {
      if (!selectedRuleSetId) return;
      try {
        const d = await getRuleSetDetail(tenantId, selectedRuleSetId);
        setDetail(d);
        if (keepVersionId) {
          setSelectedVersionId(keepVersionId);
        }
      } catch (err: any) {
        notify(err.message || "Could not sync rule details.", false);
      }
    },
    [tenantId, selectedRuleSetId, notify]
  );

  // ── Version management ─────────────────────────────────────────────────
  const handleCreateVersion = useCallback(async () => {
    if (!detail) return;
    try {
      const v = await createRuleVersion(tenantId, detail.id);
      notify(`Draft v${v.version_number} created.`, true);
      await refreshDetail(v.id);
    } catch (err: any) {
      notify(err.message || "Failed to create version.", false);
    }
  }, [tenantId, detail, notify, refreshDetail]);

  const handleDeployVersion = useCallback(
    async (versionId: string) => {
      if (isDeploying) return;
      setIsDeploying(true);
      try {
        const currentUser =
          localStorage.getItem("user_name") ||
          localStorage.getItem("user_email") ||
          "Compliance Officer";
        await updateVersionStatus(tenantId, versionId, "ACTIVE", currentUser);
        notify(`Version deployed to Production by ${currentUser}.`, true);
        await refreshDetail(versionId);
        load();
      } catch (err: any) {
        notify(err.message || "Failed to deploy version.", false);
      } finally {
        setIsDeploying(false);
      }
    },
    [tenantId, isDeploying, notify, refreshDetail, load]
  );

  // ── Rule reordering (optimistic update + priority sync) ────────────────
  const handleReorderRules = useCallback(
    async (orderedIds: string[]) => {
      if (!detail || !selectedVersionId) return;
      const versionIdx = detail.versions.findIndex((v) => v.id === selectedVersionId);
      if (versionIdx === -1) return;

      const currentVersion = detail.versions[versionIdx];
      if (currentVersion.status === "ACTIVE") {
        notify("Cannot reorder rules on an active version.", false);
        return;
      }

      // Re-map priorities in sequence (10, 20, 30...)
      const updatedRulesMap = new Map(currentVersion.rules.map((r) => [r.id, r]));
      const newRules: RuleDetail[] = [];
      
      orderedIds.forEach((id, index) => {
        const existing = updatedRulesMap.get(id);
        if (existing) {
          newRules.push({ ...existing, priority: (index + 1) * 10 });
        }
      });

      // Optimistically update local state immediately
      const updatedVersions = [...detail.versions];
      updatedVersions[versionIdx] = { ...currentVersion, rules: newRules };
      setDetail({ ...detail, versions: updatedVersions });

      // Persist priority updates to API for changed rules
      try {
        await Promise.all(
          newRules.map((rule) => {
            const original = updatedRulesMap.get(rule.id);
            if (original && original.priority !== rule.priority) {
              return updateRule(tenantId, selectedVersionId, rule.id, {
                name: rule.name,
                rule_code: rule.rule_code,
                priority: rule.priority,
                is_active: rule.is_active,
                impact_type: rule.impact_type,
                impact_data: rule.impact_data,
                action_outcome: rule.action_outcome,
                criteria: rule.criteria.map(({ id, ...rest }) => rest),
              });
            }
            return Promise.resolve();
          })
        );
        notify("Rule priorities updated & saved.", true);
      } catch (err: any) {
        notify("Failed to save reordered priorities.", false);
        refreshDetail(selectedVersionId);
      }
    },
    [tenantId, detail, selectedVersionId, notify, refreshDetail]
  );

  // ── Rule editor open/close ─────────────────────────────────────────────
  const openAddRule = useCallback(() => {
    setEditingRule(null);
    setRuleDraft(EMPTY_RULE_DRAFT());
    setIsEditMode(true);
  }, []);

  const openEditRule = useCallback((rule: RuleDetail) => {
    setEditingRule(rule);
    setRuleDraft({
      name: rule.name,
      rule_code: rule.rule_code,
      priority: rule.priority,
      is_active: rule.is_active,
      impact_type: rule.impact_type,
      impact_data: { ...rule.impact_data },
      action_outcome: rule.action_outcome,
      criteria: rule.criteria.map(({ id, ...rest }) => rest),
    });
    setIsEditMode(true);
  }, []);

  const cancelEditMode = useCallback(() => {
    setIsEditMode(false);
    setEditingRule(null);
    setRuleDraft(EMPTY_RULE_DRAFT());
  }, []);

  // ── Save rule ──────────────────────────────────────────────────────────
  const handleSaveRule = useCallback(
    async (draft: RuleFormState) => {
      if (!selectedVersionId) {
        notify("No version selected.", false);
        return;
      }
      if (!draft.name.trim()) {
        notify("Rule name is required.", false);
        return;
      }
      try {
        if (editingRule) {
          await updateRule(tenantId, selectedVersionId, editingRule.id, draft);
          notify("Rule updated successfully.", true);
        } else {
          await addRuleToVersion(tenantId, selectedVersionId, draft);
          notify("Rule added successfully.", true);
        }
        setIsEditMode(false);
        setEditingRule(null);
        await refreshDetail(selectedVersionId);
      } catch (err: any) {
        notify(err.message || "Failed to save rule.", false);
      }
    },
    [tenantId, selectedVersionId, editingRule, notify, refreshDetail]
  );

  // ── Delete actions ──────────────────────────────────────────────────────
  const handleDeleteCategory = useCallback(
    async (categoryId: string) => {
      try {
        await deleteCategory(tenantId, categoryId);
        notify("Category deleted.", true);
        setDeletePrompt(null);
        load();
      } catch (err: any) {
        notify(err.response?.data?.detail || err.message || "Failed to delete Category.", false);
      }
    },
    [tenantId, notify, load]
  );

  const handleDeleteSubCategory = useCallback(
    async (subcategoryId: string) => {
      try {
        await deleteSubCategory(tenantId, subcategoryId);
        notify("SubCategory deleted.", true);
        setDeletePrompt(null);
        load();
      } catch (err: any) {
        notify(err.response?.data?.detail || err.message || "Failed to delete SubCategory.", false);
      }
    },
    [tenantId, notify, load]
  );

  const handleDeleteRuleSet = useCallback(
    async (ruleSetId: string) => {
      try {
        await deleteRuleSet(tenantId, ruleSetId);
        notify("Rule Set deleted.", true);
        setDeletePrompt(null);
        if (selectedRuleSetId === ruleSetId) closeDetail();
        load();
      } catch (err: any) {
        notify(err.response?.data?.detail || err.message || "Failed to delete Rule Set.", false);
      }
    },
    [tenantId, notify, load, selectedRuleSetId, closeDetail]
  );

  // ── Delete rule ────────────────────────────────────────────────────────
  const handleDeleteRule = useCallback(
    async (ruleId: string) => {
      try {
        await deleteRule(tenantId, ruleId);
        notify("Rule deleted.", true);
        setDeletePrompt(null);
        await refreshDetail(selectedVersionId || undefined);
      } catch (err: any) {
        notify(err.message || "Failed to delete rule.", false);
      }
    },
    [tenantId, notify, refreshDetail, selectedVersionId]
  );

  // ── Create Category ───────────────────────────────────────────────────
  const handleCreateCategory = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newCatCode.trim() || !newCatName.trim()) {
        notify("Category code and name are required.", false);
        return;
      }
      try {
        await createCategory(tenantId, {
          code: newCatCode.trim().toUpperCase(),
          name: newCatName.trim(),
          description: newCatDesc.trim(),
        });
        notify("Category created successfully.", true);
        setShowCreateCategory(false);
        setNewCatCode("");
        setNewCatName("");
        setNewCatDesc("");
        load();
      } catch (err: any) {
        notify(err.message || "Failed to create category.", false);
      }
    },
    [tenantId, newCatCode, newCatName, newCatDesc, notify, load]
  );

  // ── Open Create SubCategory modal with preselected parent ─────────────
  const openCreateSubCategoryModal = useCallback(() => {
    if (filter.categoryCode) {
      const parent = categories.find((c) => c.code === filter.categoryCode);
      if (parent) {
        setNewSubCategoryId(parent.id);
      }
    } else if (categories.length > 0) {
      setNewSubCategoryId(categories[0].id);
    }
    setShowCreateSubCategory(true);
  }, [filter.categoryCode, categories]);

  // ── Create SubCategory ────────────────────────────────────────────────
  const handleCreateSubCategory = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newSubCategoryId) {
        notify("Please select a parent Category.", false);
        return;
      }
      if (!newSubCode.trim() || !newSubName.trim()) {
        notify("SubCategory code and name are required.", false);
        return;
      }
      try {
        await createSubCategory(tenantId, newSubCategoryId, {
          code: newSubCode.trim().toUpperCase(),
          name: newSubName.trim(),
        });
        notify("SubCategory created successfully.", true);
        setShowCreateSubCategory(false);
        setNewSubCategoryId("");
        setNewSubCode("");
        setNewSubName("");
        load();
      } catch (err: any) {
        notify(err.message || "Failed to create subcategory.", false);
      }
    },
    [tenantId, newSubCategoryId, newSubCode, newSubName, notify, load]
  );

  // ── Create rule set ────────────────────────────────────────────────────
  const handleCreateRuleSet = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newSetCode || !newSetName || !newSetScope.subcategoryCode) {
        notify("Pick a Category/SubCategory and fill in code + name.", false);
        return;
      }
      const cat = categories.find((c) => c.code === newSetScope.categoryCode);
      const sub = cat?.subcategories.find((s) => s.code === newSetScope.subcategoryCode);
      if (!sub) { notify("Selected SubCategory not found.", false); return; }

      const profile = newSetScope.channelCode
        ? sub.eligibility_profiles.find((p) => p.channel_code === newSetScope.channelCode)
        : null;
      const scopeType: ScopeType = profile ? "CHANNEL_PRODUCT" : "GLOBAL";

      try {
        await createRuleSet(tenantId, {
          rule_code: newSetCode.trim(),
          name: newSetName,
          description: newSetDesc,
          scope_type: scopeType,
          subcategory_id: sub.id,
          eligibility_id: profile?.id || null,
        });
        notify("Rule set created successfully.", true);
        setShowCreateSet(false);
        setNewSetCode(""); setNewSetName(""); setNewSetDesc("");
        setNewSetScope({ categoryCode: null, subcategoryCode: null, channelCode: null });
        load();
      } catch (err: any) {
        notify(err.message || "Failed to create rule set.", false);
      }
    },
    [tenantId, categories, newSetCode, newSetName, newSetDesc, newSetScope, notify, load]
  );

  return {
    // Catalog
    categories, allRuleSets, ruleSets, filter, loading,
    handleFilterChange, clearFilter, load,
    // Drawer
    selectedRuleSetId, detail, loadingDetail, selectedVersionId,
    setSelectedVersionId, isDeploying,
    openDetail, closeDetail,
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
    // Delete handlers & state
    deletePrompt, setDeletePrompt,
    handleDeleteCategory, handleDeleteSubCategory, handleDeleteRuleSet,
  };
}
