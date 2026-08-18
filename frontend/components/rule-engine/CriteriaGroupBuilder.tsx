"use client";

import { RuleCriteriaDraft, ComparisonOperator } from "@/app/services/ruleEngine";
import { OPERATOR_OPTIONS, fieldLabel } from "./constants";

interface Props {
  criteria: RuleCriteriaDraft[];
  onChange: (criteria: RuleCriteriaDraft[]) => void;
  fieldSuggestions?: string[];
}

const EMPTY_CRITERION = (groupId: number): RuleCriteriaDraft => ({
  group_id: groupId,
  field_name: "",
  operator: "eq",
  value_numeric: null,
  value_string: "",
  value_range_min: null,
  value_range_max: null,
  value_list: null,
  target_field_name: null,
  target_multiplier: 1,
});

/**
 * Form-based nested-OR-group criteria builder — no JSON ever shown. Groups
 * (rendered as separate cards, "Match ANY of these groups") are OR'd
 * together; conditions within one group ("Match ALL of these conditions")
 * are AND'd. Each condition is Field + Operator, then either a plain Value
 * input (number/text/range/list depending on operator) or, for the two
 * cross-field operators, a "compare to another field" Target Field +
 * Multiplier pair.
 */
export default function CriteriaGroupBuilder({ criteria, onChange, fieldSuggestions = [] }: Props) {
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
      {groupIds.length === 0 && (
        <div className="p-4 text-center text-xs text-slate-500 italic bg-slate-50 border border-dashed border-slate-200 rounded-lg">
          No conditions — this rule always applies.
        </div>
      )}

      {groupIds.map((groupId, gIdx) => (
        <div key={groupId}>
          {gIdx > 0 && (
            <div className="flex items-center gap-2 my-2">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">OR</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>
          )}
          <div className="border border-slate-200 rounded-xl bg-slate-50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Match ALL of these conditions
              </span>
              <button
                type="button"
                onClick={() => removeGroup(groupId)}
                className="text-[10px] text-red-500 hover:text-red-700 font-semibold"
              >
                Remove group
              </button>
            </div>

            {criteria
              .map((c, i) => ({ c, i }))
              .filter(({ c }) => c.group_id === groupId)
              .map(({ c, i }) => (
                <div key={i} className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <input
                      list="rule-engine-field-suggestions"
                      value={c.field_name}
                      onChange={(e) => updateCriterion(i, { field_name: e.target.value })}
                      placeholder="Field name (e.g. age)"
                      className="col-span-4 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                    />
                    <select
                      value={c.operator}
                      onChange={(e) => updateCriterion(i, { operator: e.target.value as ComparisonOperator })}
                      className="col-span-4 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                    >
                      {OPERATOR_OPTIONS.map((op) => (
                        <option key={op.value} value={op.value}>{op.label}</option>
                      ))}
                    </select>

                    {(c.operator === "field_gt" || c.operator === "field_gte") ? (
                      <>
                        <input
                          list="rule-engine-field-suggestions"
                          value={c.target_field_name || ""}
                          onChange={(e) => updateCriterion(i, { target_field_name: e.target.value })}
                          placeholder="Target field"
                          className="col-span-3 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                        />
                        <input
                          type="number"
                          step="0.1"
                          value={c.target_multiplier ?? 1}
                          onChange={(e) => updateCriterion(i, { target_multiplier: Number(e.target.value) })}
                          placeholder="×"
                          title="Multiplier"
                          className="col-span-1 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                        />
                      </>
                    ) : c.operator === "between" ? (
                      <>
                        <input
                          type="number"
                          value={c.value_range_min ?? ""}
                          onChange={(e) => updateCriterion(i, { value_range_min: e.target.value === "" ? null : Number(e.target.value) })}
                          placeholder="Min"
                          className="col-span-2 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                        />
                        <input
                          type="number"
                          value={c.value_range_max ?? ""}
                          onChange={(e) => updateCriterion(i, { value_range_max: e.target.value === "" ? null : Number(e.target.value) })}
                          placeholder="Max"
                          className="col-span-2 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                        />
                      </>
                    ) : c.operator === "in_set" ? (
                      <input
                        value={(c.value_list || []).join(", ")}
                        onChange={(e) => updateCriterion(i, { value_list: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        placeholder="Comma-separated values"
                        className="col-span-4 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                      />
                    ) : c.operator === "contains" ? (
                      <input
                        value={c.value_string || ""}
                        onChange={(e) => updateCriterion(i, { value_string: e.target.value })}
                        placeholder="Text to search for"
                        className="col-span-4 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                      />
                    ) : (
                      <input
                        value={c.value_string ?? (c.value_numeric ?? "")}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === "true" || raw === "false") {
                            updateCriterion(i, { value_string: raw, value_numeric: null });
                          } else if (raw !== "" && !isNaN(Number(raw))) {
                            updateCriterion(i, { value_numeric: Number(raw), value_string: null });
                          } else {
                            updateCriterion(i, { value_string: raw, value_numeric: null });
                          }
                        }}
                        placeholder="Value (number, text, true/false)"
                        className="col-span-3 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-medium"
                      />
                    )}

                    <button
                      type="button"
                      onClick={() => removeCriterion(i)}
                      className="col-span-1 text-slate-400 hover:text-red-600 flex items-center justify-center"
                      title="Remove condition"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {c.field_name && (
                    <p className="text-[10px] text-slate-400 italic">
                      {fieldLabel(c.field_name)}
                    </p>
                  )}
                </div>
              ))}

            <button
              type="button"
              onClick={() => addConditionToGroup(groupId)}
              className="text-[11px] font-semibold text-blue-600 hover:underline"
            >
              + Add condition (AND)
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addGroup}
        className="w-full py-2 border border-dashed border-slate-300 rounded-lg text-[11px] font-semibold text-slate-500 hover:text-blue-600 hover:border-blue-300 transition"
      >
        + Add OR group
      </button>

      <datalist id="rule-engine-field-suggestions">
        {fieldSuggestions.map((f) => <option key={f} value={f} />)}
      </datalist>
    </div>
  );
}
