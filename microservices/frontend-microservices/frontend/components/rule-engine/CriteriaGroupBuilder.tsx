"use client";

import { RuleCriteriaDraft, ComparisonOperator } from "@/app/services/ruleEngine";
import { BOOLEAN_FIELDS, FRIENDLY_OPERATORS, OPTION_FIELDS } from "./constants";
import FieldSearchSelect from "./FieldSearchSelect";
import KeywordListEditor from "./KeywordListEditor";
import { tx } from "@/lib/i18n/tx";

interface Props {
  criteria: RuleCriteriaDraft[];
  onChange: (criteria: RuleCriteriaDraft[]) => void;
}

const EMPTY_CRITERION = (groupId: number): RuleCriteriaDraft => ({
  group_id: groupId,
  field_name: "age",
  operator: "gte",
  value_numeric: null,
  value_string: "",
  value_range_min: null,
  value_range_max: null,
  value_list: null,
  target_field_name: null,
  target_multiplier: 1,
});

const control = "rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100";

/** Free-text facts where a keyword list is the natural way to write a rule. */
const TEXT_FIELDS = new Set(["occupation"]);

/** Operators that make sense for a field: yes/no and option facts only compare for equality. */
function operatorsFor(field: string) {
  if (BOOLEAN_FIELDS.has(field)) return FRIENDLY_OPERATORS.filter((o) => o.value === "eq");
  if (OPTION_FIELDS[field]) return FRIENDLY_OPERATORS.filter((o) => ["eq", "neq", "in_set"].includes(o.value));
  if (TEXT_FIELDS.has(field)) return FRIENDLY_OPERATORS.filter((o) => ["contains_any", "contains", "eq", "neq"].includes(o.value));
  return FRIENDLY_OPERATORS.filter((o) => o.value !== "contains_any");
}

export default function CriteriaGroupBuilder({ criteria, onChange }: Props) {
  const groupIds = Array.from(new Set(criteria.map((c) => c.group_id))).sort((a, b) => a - b);

  const update = (index: number, patch: Partial<RuleCriteriaDraft>) => {
    const next = criteria.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const remove = (index: number) => onChange(criteria.filter((_, i) => i !== index));
  const addTo = (groupId: number) => onChange([...criteria, EMPTY_CRITERION(groupId)]);
  const addGroup = () => onChange([...criteria, EMPTY_CRITERION(groupIds.length ? Math.max(...groupIds) + 1 : 1)]);

  const changeField = (index: number, field: string) => {
    // Reset the comparison to one that suits the new field.
    if (BOOLEAN_FIELDS.has(field)) return update(index, { field_name: field, operator: "eq", value_string: "true", value_numeric: null });
    if (OPTION_FIELDS[field]) return update(index, { field_name: field, operator: "eq", value_string: OPTION_FIELDS[field][0].value, value_numeric: null });
    if (TEXT_FIELDS.has(field)) return update(index, { field_name: field, operator: "contains_any", value_list: [], value_string: "", value_numeric: null });
    const current = criteria[index];
    const keepOp = FRIENDLY_OPERATORS.some((o) => o.value === current.operator) ? current.operator : "gte";
    update(index, { field_name: field, operator: keepOp, value_string: "", value_numeric: null });
  };

  const valueInput = (item: RuleCriteriaDraft, idx: number) => {
    const f = item.field_name;
    if (BOOLEAN_FIELDS.has(f)) {
      return (
        <select value={String(item.value_string || "true").toLowerCase()} onChange={(e) => update(idx, { value_string: e.target.value, value_numeric: null })} className={control}>
          <option value="true">{tx("Yes")}</option>
          <option value="false">{tx("No")}</option>
        </select>
      );
    }
    if (OPTION_FIELDS[f] && item.operator !== "in_set") {
      return (
        <select value={item.value_string || ""} onChange={(e) => update(idx, { value_string: e.target.value, value_numeric: null })} className={control}>
          {OPTION_FIELDS[f].map((o) => <option key={o.value} value={o.value}>{tx(o.label)}</option>)}
        </select>
      );
    }
    if (item.operator === "contains_any") {
      return <KeywordListEditor field={f} values={item.value_list ?? []} onChange={(v) => update(idx, { value_list: v })} />;
    }
    if (item.operator === "between") {
      return (
        <div className="flex items-center gap-1.5">
          <input type="number" placeholder={tx("from")} value={item.value_range_min ?? ""}
            onChange={(e) => update(idx, { value_range_min: e.target.value === "" ? null : parseFloat(e.target.value) })}
            className={`${control} w-24`} />
          <span className="text-xs text-slate-400">{tx("and")}</span>
          <input type="number" placeholder={tx("to")} value={item.value_range_max ?? ""}
            onChange={(e) => update(idx, { value_range_max: e.target.value === "" ? null : parseFloat(e.target.value) })}
            className={`${control} w-24`} />
        </div>
      );
    }
    if (item.operator === "in_set" && OPTION_FIELDS[f]) {
      const chosen = (item.value_list ?? []).map((v) => String(v).toLowerCase());
      return (
        <div className="flex flex-wrap gap-1.5">
          {OPTION_FIELDS[f].map((o) => {
            const on = chosen.includes(o.value);
            return (
              <button key={o.value} type="button"
                onClick={() => update(idx, { value_list: on ? chosen.filter((v) => v !== o.value) : [...chosen, o.value] })}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition ${on ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-200 hover:ring-slate-300"}`}>
                {tx(o.label)}
              </button>
            );
          })}
        </div>
      );
    }
    if (item.operator === "in_set") {
      return (
        <input type="text" placeholder={OPTION_FIELDS[f] ? OPTION_FIELDS[f].map((o) => o.value).join(", ") : tx("e.g. high, very high")}
          value={item.value_list?.join(", ") ?? ""}
          onChange={(e) => update(idx, { value_list: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          className={`${control} w-48`} />
      );
    }
    if (item.operator === "field_gt" || item.operator === "field_gte") {
      return (
        <div className="flex items-center gap-1.5">
          <div className="w-44"><FieldSearchSelect value={item.target_field_name ?? ""} onChange={(v) => update(idx, { target_field_name: v })} /></div>
          <span className="text-xs text-slate-400">×</span>
          <input type="number" step="0.1" value={item.target_multiplier ?? 1}
            onChange={(e) => update(idx, { target_multiplier: parseFloat(e.target.value) || 1 })}
            className={`${control} w-16`} />
        </div>
      );
    }
    return (
      <input type="text" placeholder={tx("value")}
        value={item.value_string || (item.value_numeric !== null && item.value_numeric !== undefined ? String(item.value_numeric) : "")}
        onChange={(e) => {
          const v = e.target.value;
          const num = parseFloat(v);
          if (!isNaN(num) && String(num) === v.trim()) update(idx, { value_numeric: num, value_string: "" });
          else update(idx, { value_string: v, value_numeric: null });
        }}
        className={`${control} w-32`} />
    );
  };

  if (groupIds.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
        <span className="text-xs text-slate-500">{tx("No conditions — this rule applies to everyone.")}</span>
        <button type="button" onClick={addGroup} className="rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
          {tx("Add a condition")}
        </button>
      </div>
    );
  }

  const usesHazardLevel = criteria.some((c) => c.field_name === "occupation_hazard");
  const hasOccupationList = criteria.some((c) => c.field_name === "occupation");
  const addOccupationList = () => {
    const nextGroup = groupIds.length ? Math.max(...groupIds) + 1 : 1;
    onChange([...criteria, { ...EMPTY_CRITERION(nextGroup), field_name: "occupation", operator: "contains_any", value_list: [], value_string: "" }]);
  };

  return (
    <div className="space-y-3">
      {usesHazardLevel && !hasOccupationList && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-fuchsia-50/60 px-4 py-3 ring-1 ring-fuchsia-100">
          <p className="text-xs text-slate-700">
            <span className="font-semibold">{tx("Want to name the occupations yourself?")}</span>{" "}
            {tx("Add a list of jobs (e.g. miner, pilot, security guard) — type it or generate it with AI from a description.")}
          </p>
          <button type="button" onClick={addOccupationList}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-fuchsia-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-fuchsia-700">
            {tx("+ Add an occupation list")}
          </button>
        </div>
      )}
      {groupIds.map((groupId, gIdx) => {
        const indices = criteria.map((c, i) => (c.group_id === groupId ? i : -1)).filter((i) => i !== -1);
        return (
          <div key={groupId}>
            {gIdx > 0 && (
              <div className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-200" />
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-500">{tx("or")}</span>
                <div className="h-px flex-1 bg-slate-200" />
              </div>
            )}
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-500">
                  {indices.length > 1 ? tx("All of these are true") : tx("This is true")}
                </span>
                {groupIds.length > 1 && (
                  <button type="button" onClick={() => onChange(criteria.filter((c) => c.group_id !== groupId))} className="text-[11px] font-medium text-slate-400 hover:text-red-600">
                    {tx("Remove group")}
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {indices.map((critIdx, i) => {
                  const item = criteria[critIdx];
                  return (
                    <div key={critIdx} className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-2 ring-1 ring-slate-200/70">
                      <span className="w-8 shrink-0 text-center text-[11px] font-semibold text-slate-400">{i === 0 ? tx("If") : tx("and")}</span>
                      <div className="min-w-[180px] flex-1"><FieldSearchSelect value={item.field_name} onChange={(v) => changeField(critIdx, v)} /></div>
                      <select
                        value={item.operator}
                        onChange={(e) => update(critIdx, { operator: e.target.value as ComparisonOperator })}
                        className={control}
                      >
                        {operatorsFor(item.field_name).map((op) => <option key={op.value} value={op.value}>{tx(op.label)}</option>)}
                      </select>
                      {item.operator !== "contains_any" && valueInput(item, critIdx)}
                      <button type="button" onClick={() => remove(critIdx)} className="ml-auto rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600" aria-label={tx("Remove condition")}>
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                      {item.operator === "contains_any" && <div className="basis-full">{valueInput(item, critIdx)}</div>}
                    </div>
                  );
                })}
              </div>
              <button type="button" onClick={() => addTo(groupId)} className="mt-2 text-xs font-semibold text-blue-600 hover:underline">
                {tx("+ And another condition")}
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" onClick={addGroup} className="rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
        {tx("+ Or a different set of conditions")}
      </button>
    </div>
  );
}
