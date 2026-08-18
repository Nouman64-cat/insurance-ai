"use client";

import React, { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import {
  Category, RuleSetSummary, RuleSetDetail, RuleDetail, RuleDraft, ScopeType, ImpactType,
  listCategories, listRuleSets, createRuleSet, getRuleSetDetail, createRuleVersion,
  updateVersionStatus, addRuleToVersion, updateRule, deleteRule,
  DEFAULT_IMPACT_DATA,
} from "@/app/services/ruleEngine";
import HierarchyTree, { HierarchySelection } from "./HierarchyTree";
import CriteriaGroupBuilder from "./CriteriaGroupBuilder";
import ImpactForm from "./ImpactForm";
import { IMPACT_TYPE_LABELS, criterionSentence } from "./constants";

const COMMON_FIELDS = [
  "age", "sum_assured", "tsar_accumulated", "declared_income", "is_smoker", "bmi",
  "category", "policy_year", "premium_type", "composite_score", "score", "occupation",
  "sanctions_matched", "is_pep", "annual_premium",
];

export default function CatalogTab({ tenantId }: { tenantId: string }) {
  const { notify } = useNotify();
  const [categories, setCategories] = useState<Category[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSetSummary[]>([]);
  const [filter, setFilter] = useState<HierarchySelection>({ categoryCode: null, subcategoryCode: null, channelCode: null });
  const [loading, setLoading] = useState(true);

  const [selectedRuleSetId, setSelectedRuleSetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RuleSetDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  const [showCreateSet, setShowCreateSet] = useState(false);
  const [newSetScope, setNewSetScope] = useState<HierarchySelection>({ categoryCode: null, subcategoryCode: null, channelCode: null });
  const [newSetCode, setNewSetCode] = useState("");
  const [newSetName, setNewSetName] = useState("");
  const [newSetDesc, setNewSetDesc] = useState("");

  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<RuleDetail | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>({
    name: "", rule_code: "", priority: 100, is_active: true,
    impact_type: "AUTO_APPROVE", impact_data: { ...DEFAULT_IMPACT_DATA }, action_outcome: "", criteria: [],
  });

  useEffect(() => {
    load();
  }, [tenantId]);

  const load = async (f?: HierarchySelection) => {
    setLoading(true);
    try {
      const [cats, sets] = await Promise.all([
        listCategories(tenantId),
        listRuleSets(tenantId, {
          category: (f ?? filter).categoryCode || undefined,
          subcategory: (f ?? filter).subcategoryCode || undefined,
          channel: (f ?? filter).channelCode || undefined,
        }),
      ]);
      setCategories(cats);
      setRuleSets(sets);
    } catch (err: any) {
      notify(err.message || "Failed to load rule catalog.", false);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (f: HierarchySelection) => {
    setFilter(f);
    load(f);
  };

  const openDetail = async (id: string) => {
    setSelectedRuleSetId(id);
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
  };

  const closeDetail = () => {
    setSelectedRuleSetId(null);
    setDetail(null);
    setSelectedVersionId(null);
  };

  const handleCreateRuleSet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSetCode || !newSetName || !newSetScope.subcategoryCode) {
      notify("Pick a Category/SubCategory and fill in the rule set code + name.", false);
      return;
    }
    const cat = categories.find((c) => c.code === newSetScope.categoryCode);
    const sub = cat?.subcategories.find((s) => s.code === newSetScope.subcategoryCode);
    if (!sub) {
      notify("Selected SubCategory not found.", false);
      return;
    }
    const profile = newSetScope.channelCode ? sub.eligibility_profiles.find((p) => p.channel_code === newSetScope.channelCode) : null;
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
      notify("Rule set created.", true);
      setShowCreateSet(false);
      setNewSetCode(""); setNewSetName(""); setNewSetDesc("");
      setNewSetScope({ categoryCode: null, subcategoryCode: null, channelCode: null });
      load();
    } catch (err: any) {
      notify(err.message || "Failed to create rule set.", false);
    }
  };

  const handleCreateVersion = async () => {
    if (!detail) return;
    try {
      const v = await createRuleVersion(tenantId, detail.id);
      notify(`Created draft v${v.version_number}`, true);
      openDetail(detail.id);
    } catch (err: any) {
      notify(err.message || "Failed to create version.", false);
    }
  };

  const handleDeployVersion = async (versionId: string) => {
    try {
      await updateVersionStatus(tenantId, versionId, "ACTIVE", "Compliance Officer");
      notify("Version deployed to Active.", true);
      if (detail) openDetail(detail.id);
      load();
    } catch (err: any) {
      notify(err.message || "Failed to deploy version.", false);
    }
  };

  const openAddRule = () => {
    setEditingRule(null);
    setRuleDraft({
      name: "", rule_code: "", priority: 100, is_active: true,
      impact_type: "AUTO_APPROVE", impact_data: { ...DEFAULT_IMPACT_DATA }, action_outcome: "", criteria: [],
    });
    setShowRuleModal(true);
  };

  const openEditRule = (rule: RuleDetail) => {
    setEditingRule(rule);
    setRuleDraft({
      name: rule.name, rule_code: rule.rule_code, priority: rule.priority, is_active: rule.is_active,
      impact_type: rule.impact_type, impact_data: { ...rule.impact_data },
      action_outcome: rule.action_outcome,
      criteria: rule.criteria.map(({ id, ...rest }) => rest),
    });
    setShowRuleModal(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVersionId || !ruleDraft.name) return;
    try {
      if (editingRule) {
        await updateRule(tenantId, selectedVersionId, editingRule.id, ruleDraft);
        notify("Rule updated.", true);
      } else {
        await addRuleToVersion(tenantId, selectedVersionId, ruleDraft);
        notify("Rule added.", true);
      }
      setShowRuleModal(false);
      if (detail) openDetail(detail.id);
    } catch (err: any) {
      notify(err.message || "Failed to save rule.", false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await deleteRule(tenantId, ruleId);
      notify("Rule deleted.", true);
      if (detail) openDetail(detail.id);
    } catch (err: any) {
      notify(err.message || "Failed to delete rule.", false);
    }
  };

  const currentVersion = detail?.versions.find((v) => v.id === selectedVersionId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <div className="lg:col-span-3 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-wider text-slate-500 font-bold">Browse Hierarchy</h2>
          <button
            onClick={() => { setFilter({ categoryCode: null, subcategoryCode: null, channelCode: null }); load({ categoryCode: null, subcategoryCode: null, channelCode: null }); }}
            className="text-[10px] text-blue-600 hover:underline font-semibold"
          >
            Clear
          </button>
        </div>
        <HierarchyTree categories={categories} value={filter} onChange={handleFilterChange} />
        <button
          onClick={() => setShowCreateSet(true)}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
        >
          + New Rule Set
        </button>
      </div>

      <div className="lg:col-span-9 space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-slate-500 font-bold px-1">
          Rule Sets ({ruleSets.length})
        </h2>
        {loading ? (
          <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-400 text-sm animate-pulse font-medium">
            Loading rule catalog...
          </div>
        ) : ruleSets.length === 0 ? (
          <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-500 text-sm font-medium">
            No rule sets found for this selection.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {ruleSets.map((rs) => (
              <div
                key={rs.id}
                onClick={() => openDetail(rs.id)}
                className="p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-md cursor-pointer transition flex items-center justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1.5">
                    <h3 className="text-sm font-bold text-slate-900 truncate">{rs.name}</h3>
                    <span className="font-mono text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                      Code: {rs.rule_code}
                    </span>
                    <span className="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-200">
                      {rs.scope_type === "GLOBAL" ? "Global" : rs.channel_code || "Channel"}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                      v{rs.active_version_number || "—"} {rs.active_version_status}
                    </span>
                  </div>
                  {rs.description && <p className="text-xs text-slate-500 truncate mb-2">{rs.description}</p>}
                  <div className="flex items-center gap-4 text-[10px] text-slate-400">
                    <span className="font-semibold text-slate-600">{rs.rule_count} rules</span>
                  </div>
                </div>
                <div className="text-slate-300 flex-shrink-0">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rule Set Detail Modal */}
      {selectedRuleSetId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white w-full max-w-6xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">
            {loadingDetail || !detail ? (
              <div className="p-12 text-center text-slate-400 text-sm animate-pulse font-medium">Loading...</div>
            ) : (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-bold text-slate-900">{detail.name}</h2>
                      <span className="font-mono text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                        Code: {detail.rule_code}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                        {detail.category_code} / {detail.subcategory_code}{detail.channel_code ? ` / ${detail.channel_code}` : ""}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500 mt-1">{detail.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={handleCreateVersion} className="px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 shadow-sm">
                      + New Draft Version
                    </button>
                    <button onClick={closeDetail} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 bg-slate-50 space-y-4">
                  <div className="flex items-center justify-between bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-2 overflow-x-auto">
                      <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mr-1">Versions:</span>
                      {detail.versions.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => setSelectedVersionId(v.id)}
                          className={`px-3 py-1 rounded-lg text-[11px] font-bold border transition ${
                            selectedVersionId === v.id ? "bg-blue-600 text-white border-blue-600" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                          }`}
                        >
                          v{v.version_number} ({v.status}) • {new Date(v.effective_from).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </button>
                      ))}
                    </div>
                    {currentVersion?.status === "DRAFT" && (
                      <button onClick={() => handleDeployVersion(currentVersion.id)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm">
                        Deploy to Active
                      </button>
                    )}
                  </div>

                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs uppercase tracking-wider text-slate-900 font-bold">
                        Decision Rules ({currentVersion?.rules.length || 0})
                      </h3>
                      {currentVersion?.status === "DRAFT" && (
                        <button onClick={openAddRule} className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 text-[11px] font-bold rounded-lg">
                          + Add Rule
                        </button>
                      )}
                    </div>

                    {!currentVersion || currentVersion.rules.length === 0 ? (
                      <div className="p-8 text-center border border-slate-200 rounded-xl bg-slate-50 text-slate-500 text-sm font-medium">
                        No rules yet in this version.
                      </div>
                    ) : (
                      <div className="overflow-x-auto border border-slate-200 rounded-xl">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-100">
                            <tr>
                              <th className="px-4 py-3 w-28">Priority</th>
                              <th className="px-4 py-3 w-48">Rule</th>
                              <th className="px-4 py-3 w-24">Status</th>
                              <th className="px-4 py-3">Conditions</th>
                              <th className="px-4 py-3 w-52">Impact</th>
                              {currentVersion.status === "DRAFT" && <th className="px-4 py-3 text-right w-24">Actions</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {[...currentVersion.rules].sort((a, b) => a.priority - b.priority).map((rule) => {
                              const impactCfg = IMPACT_TYPE_LABELS[rule.impact_type] || { label: rule.impact_type, badge: "bg-slate-100 text-slate-700 border-slate-200" };
                              const groupIds = Array.from(new Set(rule.criteria.map((c) => c.group_id))).sort();
                              return (
                                <React.Fragment key={rule.id}>
                                  <tr 
                                    className="align-top cursor-pointer hover:bg-slate-50 transition-colors"
                                    onClick={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
                                  >
                                    <td className="px-4 py-3">
                                      <span className="font-mono text-[11px] text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">{rule.priority}</span>
                                    </td>
                                    <td className="px-4 py-3">
                                      <div className="font-bold text-slate-900 text-xs">{rule.name}</div>
                                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">{rule.rule_code}</div>
                                    </td>
                                    <td className="px-4 py-3">
                                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${rule.is_active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                                        {rule.is_active ? 'Active' : 'Inactive'}
                                      </span>
                                    </td>
                                    <td className="px-4 py-3 text-xs text-slate-600 max-w-md">
                                      {rule.criteria.length === 0 ? (
                                        <span className="italic text-slate-400">Always applies</span>
                                      ) : (
                                        <div className="space-y-1">
                                          {groupIds.map((gid, idx) => (
                                            <div key={gid}>
                                              {idx > 0 && <span className="text-[9px] font-bold text-blue-500 uppercase mr-1">OR</span>}
                                              <span>
                                                {rule.criteria.filter((c) => c.group_id === gid).map((c, i, arr) => (
                                                  <span key={i}>
                                                    {criterionSentence(c)}
                                                    {i < arr.length - 1 && <span className="text-[9px] font-bold text-slate-400 uppercase"> AND </span>}
                                                  </span>
                                                ))}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </td>
                                    <td className="px-4 py-3">
                                      <span className={`inline-block px-2 py-1 rounded-md text-[10px] border font-bold uppercase tracking-wider ${impactCfg.badge}`}>
                                        {impactCfg.label}
                                      </span>
                                      {rule.impact_data.is_terminal && (
                                        <span className="block mt-1 text-[9px] text-amber-600 font-semibold">Terminal</span>
                                      )}
                                    </td>
                                    {currentVersion.status === "DRAFT" && (
                                      <td className="px-4 py-3 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                          <button onClick={(e) => { e.stopPropagation(); openEditRule(rule); }} className="text-slate-400 hover:text-blue-600 p-1.5 rounded-lg hover:bg-blue-50 bg-slate-50 border border-slate-200" title="Edit">
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                          </button>
                                          <button onClick={(e) => { e.stopPropagation(); handleDeleteRule(rule.id); }} className="text-slate-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 bg-slate-50 border border-slate-200" title="Delete">
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                          </button>
                                        </div>
                                      </td>
                                    )}
                                  </tr>

                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Rule Set Modal */}
      {showCreateSet && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <form onSubmit={handleCreateRuleSet} className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-6 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <h2 className="text-base font-bold text-slate-900">New Rule Set</h2>

            <div>
              <label className="block text-xs text-slate-700 font-semibold mb-1">Category / SubCategory / Channel Scope</label>
              <HierarchyTree categories={categories} value={newSetScope} onChange={setNewSetScope} allowGlobalOption />
            </div>

            <div>
              <label className="block text-xs text-slate-700 font-semibold mb-1">Rule Set Code</label>
              <input value={newSetCode} onChange={(e) => setNewSetCode(e.target.value)} placeholder="e.g. RS-MED-001" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium" required />
            </div>
            <div>
              <label className="block text-xs text-slate-700 font-semibold mb-1">Name</label>
              <input value={newSetName} onChange={(e) => setNewSetName(e.target.value)} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium" required />
            </div>
            <div>
              <label className="block text-xs text-slate-700 font-semibold mb-1">Description</label>
              <textarea value={newSetDesc} onChange={(e) => setNewSetDesc(e.target.value)} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium" />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCreateSet(false)} className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 rounded-lg border border-slate-200">Cancel</button>
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm">Create</button>
            </div>
          </form>
        </div>
      )}

      {/* Add/Edit Rule Modal */}
      {showRuleModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <form onSubmit={handleSaveRule} className="bg-white w-full max-w-2xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">{editingRule ? "Edit Rule" : "Add Rule"}</h2>
              <button type="button" onClick={() => setShowRuleModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-slate-700 font-semibold mb-1">Rule Name</label>
                  <input value={ruleDraft.name} onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium" required />
                </div>
                <div>
                  <label className="block text-xs text-slate-700 font-semibold mb-1">Priority</label>
                  <input type="number" value={ruleDraft.priority} onChange={(e) => setRuleDraft({ ...ruleDraft, priority: Number(e.target.value) })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-700 font-semibold mb-1">Rule Code (optional)</label>
                <input value={ruleDraft.rule_code} onChange={(e) => setRuleDraft({ ...ruleDraft, rule_code: e.target.value })} placeholder="Auto-generated if left blank" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium" />
              </div>

              <div>
                <label className="block text-xs text-slate-700 font-semibold mb-2">Conditions</label>
                <CriteriaGroupBuilder criteria={ruleDraft.criteria} onChange={(criteria) => setRuleDraft({ ...ruleDraft, criteria })} fieldSuggestions={COMMON_FIELDS} />
              </div>

              <div>
                <label className="block text-xs text-slate-700 font-semibold mb-2">Impact</label>
                <ImpactForm
                  impactType={ruleDraft.impact_type}
                  impactData={ruleDraft.impact_data}
                  actionOutcome={ruleDraft.action_outcome}
                  onImpactTypeChange={(t: ImpactType) => setRuleDraft({ ...ruleDraft, impact_type: t })}
                  onImpactDataChange={(d) => setRuleDraft({ ...ruleDraft, impact_data: d })}
                  onActionOutcomeChange={(s) => setRuleDraft({ ...ruleDraft, action_outcome: s })}
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button type="button" onClick={() => setShowRuleModal(false)} className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 rounded-lg border border-slate-200">Cancel</button>
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm">
                {editingRule ? "Save Changes" : "Add Rule"}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Rule Details Modal */}
      {expandedRuleId && (() => {
        const currentVersionForModal = detail?.versions.find(v => v.id === selectedVersionId);
        const rule = currentVersionForModal?.rules.find(r => r.id === expandedRuleId);
        if (!rule) return null;
        return (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={() => setExpandedRuleId(null)}>
            <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-slate-200" onClick={e => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <div>
                  <h2 className="text-base font-bold text-slate-900">{rule.name}</h2>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">{rule.rule_code}</div>
                </div>
                <button type="button" onClick={() => setExpandedRuleId(null)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg bg-white border border-slate-200">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="p-6 space-y-6">
                <div>
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    Action Outcome (Internal Tag)
                  </h4>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 inline-block">
                    <p className="text-sm font-bold text-slate-800 font-mono">{rule.action_outcome || "None"}</p>
                  </div>
                </div>
                {rule.impact_data && Object.keys(rule.impact_data).some(k => rule.impact_data[k as keyof typeof rule.impact_data] !== null && rule.impact_data[k as keyof typeof rule.impact_data] !== 0 && (Array.isArray(rule.impact_data[k as keyof typeof rule.impact_data]) ? (rule.impact_data[k as keyof typeof rule.impact_data] as any[]).length > 0 : true) && k !== 'is_terminal') && (
                  <div>
                    <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      Impact Payload Variables
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(rule.impact_data).map(([k, v]) => {
                        if (v === null || v === 0 || (Array.isArray(v) && v.length === 0) || k === 'is_terminal') return null;
                        return (
                          <div key={k} className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
                            <div className="text-[10px] text-slate-500 font-mono mb-1 truncate" title={k}>{k}</div>
                            <div className="text-sm font-bold text-slate-900">{Array.isArray(v) ? v.join(", ") : String(v)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
