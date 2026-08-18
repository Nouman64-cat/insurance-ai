"use client";

import { useState } from "react";
import { Category } from "@/app/services/ruleEngine";

export interface HierarchySelection {
  categoryCode: string | null;
  subcategoryCode: string | null;
  channelCode: string | null; // null = GLOBAL / no channel filter
}

interface Props {
  categories: Category[];
  value: HierarchySelection;
  onChange: (value: HierarchySelection) => void;
  /** When true, a SubCategory node itself is selectable as "Global (applies
   * everywhere)" in addition to its channel leaves — used by the
   * create-rule-set picker so scope_type can be chosen. */
  allowGlobalOption?: boolean;
}

/**
 * Cascading Category -> SubCategory -> EligibilityProfile (channel) tree.
 * Used both to browse/filter the catalog and, with allowGlobalOption, to
 * pick a RuleSet's scope when creating one.
 */
export default function HierarchyTree({ categories, value, onChange, allowGlobalOption }: Props) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(value.categoryCode);

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden divide-y divide-slate-100">
      {categories.map((cat) => {
        const isExpanded = expandedCategory === cat.code;
        return (
          <div key={cat.id}>
            <button
              type="button"
              onClick={() => setExpandedCategory(isExpanded ? null : cat.code)}
              className={`w-full flex items-center justify-between px-3 py-2.5 text-left text-xs font-bold transition ${
                value.categoryCode === cat.code ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span>{cat.name}</span>
              <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="bg-slate-50/60 divide-y divide-slate-100">
                {cat.subcategories.length === 0 && (
                  <div className="px-6 py-2 text-[11px] text-slate-400 italic">No subcategories yet.</div>
                )}
                {cat.subcategories.map((sub) => {
                  const isSelectedSub = value.subcategoryCode === sub.code;
                  return (
                    <div key={sub.id} className="px-3 py-2">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() =>
                            onChange({ categoryCode: cat.code, subcategoryCode: sub.code, channelCode: null })
                          }
                          className={`text-xs font-semibold text-left ${
                            isSelectedSub && !value.channelCode ? "text-blue-700" : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          {sub.name}
                        </button>
                        {allowGlobalOption && (
                          <span
                            className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border cursor-pointer ${
                              isSelectedSub && !value.channelCode
                                ? "bg-slate-800 text-white border-slate-800"
                                : "bg-white text-slate-400 border-slate-200"
                            }`}
                            onClick={() => onChange({ categoryCode: cat.code, subcategoryCode: sub.code, channelCode: null })}
                          >
                            Global
                          </span>
                        )}
                      </div>

                      {sub.eligibility_profiles.length > 0 && (
                        <div className="mt-1.5 ml-2 flex flex-wrap gap-1.5">
                          {sub.eligibility_profiles.map((p) => {
                            const isSelectedChannel = isSelectedSub && value.channelCode === p.channel_code;
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() =>
                                  onChange({ categoryCode: cat.code, subcategoryCode: sub.code, channelCode: p.channel_code })
                                }
                                className={`px-2 py-0.5 rounded-md text-[10px] font-medium border transition ${
                                  isSelectedChannel
                                    ? "bg-blue-600 text-white border-blue-600"
                                    : "bg-white text-slate-600 border-slate-200 hover:border-blue-300"
                                }`}
                                title={`Ages ${p.min_entry_age}-${p.max_entry_age}, min sum assured PKR ${p.min_sum_assured.toLocaleString()}`}
                              >
                                {p.channel_code}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
