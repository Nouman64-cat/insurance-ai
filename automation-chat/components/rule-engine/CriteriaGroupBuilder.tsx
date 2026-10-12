"use client";

import { RuleCriteriaDraft, ComparisonOperator } from "@/app/services/ruleEngine";
import { OPERATOR_OPTIONS } from "./constants";
import FieldSearchSelect from "./FieldSearchSelect";

interface Props {
  criteria: RuleCriteriaDraft[];
  onChange: (criteria: RuleCriteriaDraft[]) => void;
}

const EMPTY_CRITERION = (groupId: number): RuleCriteriaDraft => ({
  group_id: groupId,
  field_name: "age",
  operator: "eq",
  value_numeric: null,
  value_string: "",
  value_range_min: null,
  value_range_max: null,
  value_list: null,
  target_field_name: null,
  target_multiplier: 1,
});

export default function CriteriaGroupBuilder({ criteria, onChange }: Props) {
  const groupIds = Array.from(new Set(criteria.map((c) => c.group_id))).sort((a, b) => a - b);

  const updateCriterion = (index: number, patch: Partial<RuleCriteriaDraft>) => {
    const next = criteria.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const removeCriterion = (index: number) => {
    onChange(criteria.filter((_, i) => i !== index));
  };

  const addConditionToGroup = (groupId: number) => {
    onChange([...criteria, EMPTY_CRITERION(groupId)]);
  };

  const addGroup = () => {
    const nextGroupId = groupIds.length > 0 ? Math.max(...groupIds) + 1 : 1;
    onChange([...criteria, EMPTY_CRITERION(nextGroupId)]);
  };

  const removeGroup = (groupId: number) => {
    onChange(criteria.filter((c) => c.group_id !== groupId));
  };

  return (
    <div className="space-y-3">
      {groupIds.length === 0 ? (
        <div className="p-3 text-center text-xs text-slate-500 bg-slate-50 border border-dashed border-slate-200 rounded-xl flex items-center justify-between">
          <span>Rule always applies (no conditions).</span>
          <button
            type="button"
            onClick={addGroup}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm cursor-pointer"
          >
            + Add Condition
          </button>
        </div>
      ) : (
        groupIds.map((groupId, gIdx) => {
          const groupIndices = criteria
            .map((c, i) => (c.group_id === groupId ? i : -1))
            .filter((i) => i !== -1);

          return (
            <div key={groupId}>
              {gIdx > 0 && (
                <div className="flex items-center gap-2 my-2">
                  <div className="flex-1 h-px bg-slate-200" />
                  <span className="text-[10px] font-bold text-blue-600 uppercase bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                    OR
                  </span>
                  <div className="flex-1 h-px bg-slate-200" />
                </div>
              )}

              <div className="border border-slate-200 rounded-xl bg-slate-50/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    {gIdx === 0 ? "Condition Group" : `Group #${gIdx + 1}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeGroup(groupId)}
                    className="text-xs font-semibold text-slate-400 hover:text-red-600 transition cursor-pointer"
                  >
                    Delete Group
                  </button>
                </div>

                <div className="space-y-2">
                  {groupIndices.map((critIdx, idx) => {
                    const item = criteria[critIdx];

                    return (
                      <div key={critIdx} className="flex items-center gap-2 bg-white p-2 border border-slate-200 rounded-lg flex-wrap sm:flex-nowrap">
                        <span className="text-xs font-bold text-slate-400 w-7 text-center shrink-0">
                          {idx === 0 ? "IF" : "AND"}
                        </span>

                        {/* Searchable Field Dropdown Selector */}
                        <FieldSearchSelect
                          value={item.field_name}
                          onChange={(val) => updateCriterion(critIdx, { field_name: val })}
                        />

                        {/* Operator Selector */}
                        <select
                          value={item.operator}
                          onChange={(e) => updateCriterion(critIdx, { operator: e.target.value as ComparisonOperator })}
                          className="w-32 border border-slate-200 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                        >
                          {OPERATOR_OPTIONS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>

                        {/* Value inputs */}
                        {item.operator === "between" ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              placeholder="min"
                              value={item.value_range_min ?? ""}
                              onChange={(e) => updateCriterion(critIdx, { value_range_min: e.target.value === "" ? null : parseFloat(e.target.value) })}
                              className="w-16 border border-slate-200 rounded px-2 py-1.5 text-xs font-semibold text-slate-800"
                            />
                            <span className="text-slate-400 text-xs">–</span>
                            <input
                              type="number"
                              placeholder="max"
                              value={item.value_range_max ?? ""}
                              onChange={(e) => updateCriterion(critIdx, { value_range_max: e.target.value === "" ? null : parseFloat(e.target.value) })}
                              className="w-16 border border-slate-200 rounded px-2 py-1.5 text-xs font-semibold text-slate-800"
                            />
                          </div>
                        ) : item.operator === "in_set" ? (
                          <input
                            type="text"
                            placeholder="val1, val2"
                            value={item.value_list?.join(", ") ?? ""}
                            onChange={(e) => updateCriterion(critIdx, { value_list: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                            className="w-36 border border-slate-200 rounded px-2 py-1.5 text-xs font-mono font-semibold"
                          />
                        ) : item.operator === "field_gt" || item.operator === "field_gte" ? (
                          <input
                            type="text"
                            placeholder="target_field"
                            value={item.target_field_name ?? ""}
                            onChange={(e) => updateCriterion(critIdx, { target_field_name: e.target.value })}
                            className="w-32 border border-slate-200 rounded px-2 py-1.5 text-xs font-mono font-semibold"
                          />
                        ) : (
                          <input
                            type="text"
                            placeholder="value"
                            value={item.value_string || (item.value_numeric !== null ? String(item.value_numeric) : "")}
                            onChange={(e) => {
                              const v = e.target.value;
                              const num = parseFloat(v);
                              if (!isNaN(num) && String(num) === v.trim()) {
                                updateCriterion(critIdx, { value_numeric: num, value_string: "" });
                              } else {
                                updateCriterion(critIdx, { value_string: v, value_numeric: null });
                              }
                            }}
                            className="w-32 border border-slate-200 rounded px-2 py-1.5 text-xs font-semibold text-slate-800"
                          />
                        )}

                        <button
                          type="button"
                          onClick={() => removeCriterion(critIdx)}
                          className="p-1 text-slate-400 hover:text-red-600 transition cursor-pointer"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex justify-start pt-1">
                  <button
                    type="button"
                    onClick={() => addConditionToGroup(groupId)}
                    className="text-xs font-bold text-blue-600 hover:underline cursor-pointer"
                  >
                    + Add AND condition
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}

      {groupIds.length > 0 && (
        <button
          type="button"
          onClick={addGroup}
          className="text-xs font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition cursor-pointer"
        >
          + Add OR Group
        </button>
      )}
    </div>
  );
}
