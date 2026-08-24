"use client";

import { RuleSetSummary } from "@/app/services/ruleEngine";

interface Props {
  ruleSets: RuleSetSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  onCreateCategory?: () => void;
  onCreateSubCategory?: () => void;
  onClearFilter?: () => void;
  isFiltered?: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function RuleSetList({
  ruleSets,
  loading,
  selectedId,
  onSelect,
  onCreateNew,
  onCreateCategory,
  onCreateSubCategory,
  onClearFilter,
  isFiltered = false,
}: Props) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 bg-slate-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (ruleSets.length === 0) {
    return (
      <div className="border border-dashed border-slate-200 rounded-2xl p-10 text-center bg-slate-50/50">
        <div className="w-12 h-12 bg-slate-100 text-slate-400 rounded-xl flex items-center justify-center mx-auto mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-sm font-bold text-slate-800">
          {isFiltered ? "No rule sets in this category" : "No rule sets found"}
        </h3>
        <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
          {isFiltered
            ? "Try selecting another category or clearing the current navigation filter."
            : "Create your first rule set to begin configuring automated decision logic."}
        </p>

        <div className="flex items-center justify-center gap-2.5 mt-4 flex-wrap">
          {isFiltered && onClearFilter && (
            <button
              onClick={onClearFilter}
              className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition"
            >
              Clear Navigation Filter
            </button>
          )}
          {onCreateCategory && (
            <button
              onClick={onCreateCategory}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              </svg>
              Add New Category
            </button>
          )}
          {onCreateSubCategory && (
            <button
              onClick={onCreateSubCategory}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Add New Sub Category
            </button>
          )}
          <button
            onClick={onCreateNew}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add New Rule Set
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* Header bar */}
      <div className="flex items-center justify-between px-1 mb-1 gap-2 flex-wrap">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Rule Sets ({ruleSets.length})
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          {onCreateCategory && (
            <button
              onClick={onCreateCategory}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              </svg>
              Add New Category
            </button>
          )}
          {onCreateSubCategory && (
            <button
              onClick={onCreateSubCategory}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Add New Sub Category
            </button>
          )}
          <button
            onClick={onCreateNew}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add New Rule Set
          </button>
        </div>
      </div>

      {/* List items */}
      <div className="space-y-2">
        {ruleSets.map((rs) => {
          const isSelected = selectedId === rs.id;

          return (
            <div
              key={rs.id}
              onClick={() => onSelect(rs.id)}
              className={`p-3.5 rounded-xl border transition cursor-pointer flex items-center justify-between gap-4 ${
                isSelected
                  ? "bg-blue-50/70 border-blue-500 ring-1 ring-blue-500 shadow-sm"
                  : "bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-slate-900 truncate" title={rs.name}>
                    {rs.name}
                  </h3>
                  <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 shrink-0">
                    {rs.rule_code}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                  <span>Scope: <span className="font-semibold text-slate-700">{rs.scope_type}</span></span>
                  <span>·</span>
                  <span>{rs.rule_count} {rs.rule_count === 1 ? "rule" : "rules"}</span>
                  {rs.updated_at && (
                    <>
                      <span>·</span>
                      <span>Updated {formatDate(rs.updated_at)}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {/* Active version badge - fixed v— bug */}
                {rs.active_version_number ? (
                  <span className="text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-300 px-2.5 py-1 rounded-md">
                    v{rs.active_version_number} Live
                  </span>
                ) : (
                  <span className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300 px-2.5 py-1 rounded-md">
                    No active version
                  </span>
                )}

                <svg className={`w-4 h-4 transition ${isSelected ? "text-blue-600" : "text-slate-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
