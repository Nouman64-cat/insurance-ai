"use client";

import { useState, useMemo, useEffect } from "react";
import { Category, RuleSetSummary } from "@/app/services/ruleEngine";

export interface HierarchySelection {
  categoryCode: string | null;
  subcategoryCode: string | null;
  channelCode: string | null;
}

interface Props {
  categories: Category[];
  ruleSets?: RuleSetSummary[];
  value: HierarchySelection;
  onChange: (value: HierarchySelection) => void;
  onSelectRuleSet?: (id: string) => void;
  selectedRuleSetId?: string | null;
  allowGlobalOption?: boolean;
  depthLevel?: 1 | 2 | 3;
  searchQuery?: string;
  onAction?: (type: 'category' | 'subcategory' | 'ruleset', action: 'rename' | 'delete', id: string, name: string) => void;
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
const IconCategory = ({ open }: { open: boolean }) => (
  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    {open ? (
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
    ) : (
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    )}
  </svg>
);

const IconSubcategory = ({ open }: { open: boolean }) => (
  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    {open ? (
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
    ) : (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h4a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    )}
  </svg>
);

const IconRuleSet = () => (
  <svg className="w-3.5 h-3.5 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const IconChevron = ({ open }: { open: boolean }) => (
  <svg
    className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${open ? "rotate-90 text-blue-600" : "text-slate-400"}`}
    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

const IconDots = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
  </svg>
);

// ── Count badge ────────────────────────────────────────────────────────────────
const CountBadge = ({ count, active }: { count: number; active: boolean }) =>
  count > 0 ? (
    <span className={`text-xs font-bold min-w-[22px] text-center px-1.5 py-0.5 rounded-full shrink-0 ${
      active ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600 border border-slate-200/80"
    }`}>
      {count}
    </span>
  ) : null;

export default function HierarchyTree({
  categories,
  ruleSets = [],
  value,
  onChange,
  onSelectRuleSet,
  selectedRuleSetId,
  depthLevel = 1,
  searchQuery = "",
  onAction,
}: Props) {
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const [openSubcategories, setOpenSubcategories] = useState<Set<string>>(new Set());
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = () => setActiveMenuId(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // Search filtering logic
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) return categories;

    return categories
      .map((cat) => {
        const catMatch =
          cat.name.toLowerCase().includes(normalizedQuery) ||
          cat.code.toLowerCase().includes(normalizedQuery);

        const matchingSubs = cat.subcategories.filter((sub) => {
          const subMatch =
            sub.name.toLowerCase().includes(normalizedQuery) ||
            sub.code.toLowerCase().includes(normalizedQuery);

          const matchingRs = ruleSets.some(
            (rs) =>
              rs.category_code === cat.code &&
              rs.subcategory_code === sub.code &&
              (rs.name.toLowerCase().includes(normalizedQuery) ||
                rs.rule_code.toLowerCase().includes(normalizedQuery))
          );

          return subMatch || matchingRs;
        });

        if (catMatch || matchingSubs.length > 0) {
          return {
            ...cat,
            subcategories: catMatch ? cat.subcategories : matchingSubs,
          };
        }
        return null;
      })
      .filter((c): c is Category => c !== null);
  }, [categories, ruleSets, normalizedQuery]);

  // Auto-expand tree when searching or changing depthLevel
  useEffect(() => {
    if (normalizedQuery) {
      // Expand all matching categories and subcategories
      const catsToOpen = new Set<string>();
      const subsToOpen = new Set<string>();
      filteredCategories.forEach((c) => {
        catsToOpen.add(c.code);
        c.subcategories.forEach((s) => subsToOpen.add(s.code));
      });
      setOpenCategories(catsToOpen);
      setOpenSubcategories(subsToOpen);
    } else if (depthLevel === 1) {
      setOpenCategories(value.categoryCode ? new Set([value.categoryCode]) : new Set());
      setOpenSubcategories(value.subcategoryCode ? new Set([value.subcategoryCode]) : new Set());
    } else if (depthLevel === 2) {
      setOpenCategories(new Set(categories.map((c) => c.code)));
      setOpenSubcategories(new Set());
    } else if (depthLevel === 3) {
      setOpenCategories(new Set(categories.map((c) => c.code)));
      const allSubs = new Set<string>();
      categories.forEach((cat) => cat.subcategories.forEach((sub) => allSubs.add(sub.code)));
      setOpenSubcategories(allSubs);
    }
  }, [depthLevel, categories, value.categoryCode, value.subcategoryCode, normalizedQuery, filteredCategories]);

  // Index rule sets by category_code::subcategory_code
  const ruleSetsBySubcat = useMemo(() => {
    const map = new Map<string, RuleSetSummary[]>();
    for (const rs of ruleSets) {
      const key = `${rs.category_code}::${rs.subcategory_code}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rs);
    }
    return map;
  }, [ruleSets]);

  // Aggregate category counts
  const countByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const rs of ruleSets) {
      if (rs.category_code) map.set(rs.category_code, (map.get(rs.category_code) || 0) + 1);
    }
    return map;
  }, [ruleSets]);

  // Key subcategory count by category_code::subcategory_code
  const countBySubcat = useMemo(() => {
    const map = new Map<string, number>();
    for (const rs of ruleSets) {
      if (rs.category_code && rs.subcategory_code) {
        const key = `${rs.category_code}::${rs.subcategory_code}`;
        map.set(key, (map.get(key) || 0) + 1);
      }
    }
    return map;
  }, [ruleSets]);

  const toggleCategory = (code: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleSubcat = (code: string) => {
    setOpenSubcategories((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  if (filteredCategories.length === 0) {
    return (
      <div className="border border-dashed border-slate-200 rounded-xl p-6 text-center text-xs text-slate-500 italic bg-white">
        No matching categories or rule sets found.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white select-none shadow-sm">
      {filteredCategories.map((cat, catIdx) => {
        const isCatOpen = openCategories.has(cat.code);
        const isCatSelected = value.categoryCode === cat.code;
        const catCount = countByCategory.get(cat.code) || 0;

        return (
          <div key={cat.id} className={catIdx > 0 ? "border-t border-slate-100" : ""}>

            {/* ═══ CATEGORY ROW ══════════════════════════════════════════ */}
            <div
              onClick={() => {
                toggleCategory(cat.code);
                onChange({ categoryCode: cat.code, subcategoryCode: null, channelCode: null });
              }}
              className={`group w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors cursor-pointer ${
                isCatSelected && !value.subcategoryCode
                  ? "bg-blue-50/90 text-blue-900 border-l-2 border-l-blue-600 pl-[12px]"
                  : "hover:bg-slate-50 text-slate-800"
              }`}
            >
              <span>
                <IconChevron open={isCatOpen} />
              </span>

              <span className={isCatSelected && !value.subcategoryCode ? "text-blue-600" : "text-slate-500"}>
                <IconCategory open={isCatOpen} />
              </span>

              <span className={`flex-1 text-xs font-bold leading-tight truncate min-w-0 ${
                isCatSelected && !value.subcategoryCode ? "text-blue-900" : "text-slate-800"
              }`}>
                {cat.name}
              </span>

              {onAction && (
                <div className="relative" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === cat.id ? null : cat.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === cat.id ? null : cat.id);
                    }}
                    className={`p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors ${
                      activeMenuId === cat.id ? "block text-slate-700 bg-slate-200" : "hidden group-hover:block"
                    }`}
                    title="Options"
                  >
                    <IconDots />
                  </button>
                  {activeMenuId === cat.id && (
                    <div className="absolute right-0 mt-1 w-32 bg-white border border-slate-200 rounded-lg shadow-xl z-[60] overflow-hidden py-1">
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-slate-50 text-slate-700 transition"
                        onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); onAction('category', 'rename', cat.id, cat.name); }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-red-50 text-red-600 transition border-t border-slate-100"
                        onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); onAction('category', 'delete', cat.id, cat.name); }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}

              <CountBadge count={catCount} active={isCatSelected} />
            </div>

            {/* ═══ SUBCATEGORIES ═════════════════════════════════════════ */}
            {isCatOpen && cat.subcategories.map((sub) => {
              const subKey = `${cat.code}::${sub.code}`;
              const isSubOpen = openSubcategories.has(sub.code);
              const isSubSelected = value.subcategoryCode === sub.code;
              const subCount = countBySubcat.get(subKey) || 0;
              const subRuleSets = ruleSetsBySubcat.get(subKey) || [];

              return (
                <div key={sub.id} className="border-t border-slate-100 bg-slate-50/30">

                  {/* ─── SUBCATEGORY ROW ─────────────────────────────── */}
                  <div className="relative flex">
                    <div className="absolute left-[24px] top-0 bottom-0 w-px bg-slate-200" />

                    <div
                      onClick={() => {
                        toggleSubcat(sub.code);
                        onChange({ categoryCode: cat.code, subcategoryCode: sub.code, channelCode: null });
                      }}
                      className={`group flex-1 flex items-center gap-2.5 pl-9 pr-3 py-2 text-left transition-colors cursor-pointer ${
                        isSubSelected && !selectedRuleSetId
                          ? "bg-indigo-50/90 border-l-2 border-l-indigo-600 pl-[34px]"
                          : "hover:bg-slate-100/60"
                      }`}
                    >
                      <span className="absolute left-[24px] top-1/2 w-3 h-px bg-slate-200 -translate-y-1/2" />

                      <span className={`${subRuleSets.length > 0 ? "text-slate-400" : "text-transparent"}`}>
                        <IconChevron open={isSubOpen} />
                      </span>

                      <span className={isSubSelected && !selectedRuleSetId ? "text-indigo-600" : "text-slate-500"}>
                        <IconSubcategory open={isSubOpen} />
                      </span>

                      <span className={`flex-1 text-xs font-semibold leading-tight truncate min-w-0 ${
                        isSubSelected && !selectedRuleSetId ? "text-indigo-900" : "text-slate-700"
                      }`}>
                        {sub.name}
                      </span>

                      {onAction && (
                        <div className="relative" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setActiveMenuId(activeMenuId === sub.id ? null : sub.id);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setActiveMenuId(activeMenuId === sub.id ? null : sub.id);
                            }}
                            className={`p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors ${
                              activeMenuId === sub.id ? "block text-slate-700 bg-slate-200" : "hidden group-hover:block"
                            }`}
                            title="Options"
                          >
                            <IconDots />
                          </button>
                          {activeMenuId === sub.id && (
                            <div className="absolute right-0 mt-1 w-32 bg-white border border-slate-200 rounded-lg shadow-xl z-[60] overflow-hidden py-1">
                              <button
                                type="button"
                                className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-slate-50 text-slate-700 transition"
                                onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); onAction('subcategory', 'rename', sub.id, sub.name); }}
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-red-50 text-red-600 transition border-t border-slate-100"
                                onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); onAction('subcategory', 'delete', sub.id, sub.name); }}
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      <CountBadge count={subCount} active={isSubSelected && !selectedRuleSetId} />
                    </div>
                  </div>

                  {/* ─── RULE SETS ───────────────────────────────────── */}
                  {isSubOpen && subRuleSets.map((rs, rsIdx) => {
                    const isRsSelected = selectedRuleSetId === rs.id;
                    const isLast = rsIdx === subRuleSets.length - 1;

                    return (
                      <div key={rs.id} className="relative flex border-t border-slate-100 bg-white">
                        <div className={`absolute left-[24px] w-px bg-slate-200 ${isLast ? "top-0 h-1/2" : "top-0 bottom-0"}`} />
                        <div className={`absolute left-[40px] w-px bg-slate-200 ${isLast ? "top-0 h-1/2" : "top-0 bottom-0"}`} />

                        <div
                          onClick={() => onSelectRuleSet?.(rs.id)}
                          className={`group flex-1 flex items-center gap-2 pl-14 pr-3 py-2 text-left transition-colors cursor-pointer ${
                            isRsSelected
                              ? "bg-blue-50 border-l-2 border-l-blue-600 pl-[54px]"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          <span className="absolute left-[40px] top-1/2 w-3 h-px bg-slate-200 -translate-y-1/2" />

                          <span className={isRsSelected ? "text-blue-600" : "text-slate-400"}>
                            <IconRuleSet />
                          </span>

                          <span className={`flex-1 text-xs leading-tight truncate min-w-0 ${
                            isRsSelected ? "text-blue-900 font-bold" : "text-slate-700 font-medium"
                          }`} title={rs.name}>
                            {rs.name}
                          </span>

                          {onAction && (
                            <div className="relative" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setActiveMenuId(activeMenuId === rs.id ? null : rs.id);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setActiveMenuId(activeMenuId === rs.id ? null : rs.id);
                                }}
                                className={`p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors ${
                                  activeMenuId === rs.id ? "block text-slate-700 bg-slate-200" : "hidden group-hover:block"
                                }`}
                                title="Options"
                              >
                                <IconDots />
                              </button>
                              {activeMenuId === rs.id && (
                                <div className="absolute right-0 mt-1 w-32 bg-white border border-slate-200 rounded-lg shadow-xl z-[60] overflow-hidden py-1">
                                  <button
                                    type="button"
                                    className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-slate-50 text-slate-700 transition"
                                    onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); onAction('ruleset', 'rename', rs.id, rs.name); }}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-red-50 text-red-600 transition border-t border-slate-100"
                                    onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); onAction('ruleset', 'delete', rs.id, rs.name); }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          <span className={`text-xs font-bold shrink-0 px-1.5 py-0.5 rounded ${
                            isRsSelected ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600"
                          }`}>
                            {rs.rule_count}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
