"use client";

import { displayDate } from '../../lib/dateDisplay';
import { RuleSetSummary } from "@/app/services/ruleEngine";
import { categoryTone, monogram } from "./constants";
import { tx } from "@/lib/i18n/tx";

interface Props {
  ruleSets: RuleSetSummary[];
  /** category code → display name, for the section headings */
  categoryNames: Record<string, string>;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  isFiltered?: boolean;
  onClearFilter?: () => void;
}

function RuleSetCard({ rs, selected, onSelect }: { rs: RuleSetSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative flex h-full flex-col rounded-2xl border bg-white p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        selected ? "border-blue-300 ring-1 ring-blue-200 shadow-md" : "border-slate-200/80 shadow-sm"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold ring-1 ${categoryTone(rs.category_code)}`}>
          {monogram(rs.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug text-slate-900 line-clamp-2">{rs.name}</h3>
          {rs.connected ? (
            <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{tx("In use")}
            </span>
          ) : (
            <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />{tx("Reference only")}
            </span>
          )}
        </div>
      </div>

      <p className="mt-3 flex-1 text-xs leading-relaxed text-slate-500 line-clamp-2">
        {rs.connected && rs.used_by ? tx("Decides: {0}", { 0: rs.used_by }) : rs.description || tx("No description yet.")}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
        <span>
          <span className="font-semibold text-slate-700">{rs.rule_count}</span> {rs.rule_count === 1 ? tx("rule") : tx("rules")}
          {rs.updated_at && <span className="text-slate-400"> · {tx("updated")} {displayDate(rs.updated_at, { month: "short", day: "numeric" })}</span>}
        </span>
        {rs.active_version_number ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{tx("Version {0}", { 0: rs.active_version_number })}</span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">{tx("Not published")}</span>
        )}
      </div>
    </button>
  );
}

export default function RuleSetList({
  ruleSets, categoryNames, loading, selectedId, onSelect, onCreateNew, isFiltered = false, onClearFilter,
}: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-slate-100" />)}
      </div>
    );
  }

  if (ruleSets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center">
        <p className="text-sm font-semibold text-slate-800">
          {isFiltered ? tx("Nothing matches your search") : tx("No rule sets yet")}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
          {isFiltered ? tx("Try another word or clear the filters.") : tx("Create a rule set to start defining how decisions are made.")}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {isFiltered && onClearFilter && (
            <button onClick={onClearFilter} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              {tx("Clear filters")}
            </button>
          )}
          <button onClick={onCreateNew} className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700">
            {tx("New rule set")}
          </button>
        </div>
      </div>
    );
  }

  // Group by category, keeping the incoming order (in-use sets first) within each group.
  const groups = new Map<string, RuleSetSummary[]>();
  for (const rs of ruleSets) {
    const key = rs.category_code || "_other";
    groups.set(key, [...(groups.get(key) ?? []), rs]);
  }
  const ordered = Array.from(groups.entries()).sort(([a, x], [b, y]) => {
    const used = Number(y.some((r) => r.connected)) - Number(x.some((r) => r.connected));
    return used || (categoryNames[a] ?? a).localeCompare(categoryNames[b] ?? b);
  });

  return (
    <div className="space-y-8">
      {ordered.map(([code, sets]) => (
        <section key={code}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{categoryNames[code] ?? tx("Other")}</h2>
            <span className="text-xs text-slate-400">{sets.length}</span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sets.map((rs) => (
              <RuleSetCard key={rs.id} rs={rs} selected={selectedId === rs.id} onSelect={() => onSelect(rs.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
