"use client";

import { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import {
  Category, RuleSetSummary, EvaluationResult,
  listCategories, listRuleSets, evaluateRuleSet, evaluateScope,
} from "@/app/services/ruleEngine";
import { IMPACT_TYPE_LABELS } from "./constants";

export default function SimulatorTab({ tenantId }: { tenantId: string }) {
  const { notify } = useNotify();
  const [mode, setMode] = useState<"rule_set" | "scope">("rule_set");
  const [ruleSets, setRuleSets] = useState<RuleSetSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ruleSetCode, setRuleSetCode] = useState("");
  const [subcategoryCode, setSubcategoryCode] = useState("");
  const [channelCode, setChannelCode] = useState("");

  const [customerId, setCustomerId] = useState("");
  const [cnic, setCnic] = useState("");
  const [proposedSumAssured, setProposedSumAssured] = useState<number>(0);

  const [contextJson, setContextJson] = useState('{\n  "age": 45,\n  "sum_assured": 5000000\n}');
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [sets, cats] = await Promise.all([listRuleSets(tenantId), listCategories(tenantId)]);
        setRuleSets(sets);
        setCategories(cats);
        if (sets.length > 0) setRuleSetCode(sets[0].rule_code);
      } catch (err: any) {
        notify(err.message || "Failed to load rule sets.", false);
      }
    })();
  }, [tenantId]);

  const allSubcategories = categories.flatMap((c) => c.subcategories.map((s) => ({ ...s, categoryName: c.name })));
  const selectedSub = allSubcategories.find((s) => s.code === subcategoryCode);

  const handleRun = async () => {
    let context: Record<string, any> = {};
    try {
      context = JSON.parse(contextJson || "{}");
    } catch {
      notify("Context JSON is invalid.", false);
      return;
    }

    setRunning(true);
    setResult(null);
    try {
      const opts = {
        customer_id: customerId || undefined,
        cnic: cnic || undefined,
        proposed_sum_assured: proposedSumAssured || undefined,
        actor: "Underwriter Tester",
      };
      const res = mode === "rule_set"
        ? await evaluateRuleSet(tenantId, ruleSetCode, context, opts)
        : await evaluateScope(tenantId, subcategoryCode, channelCode || null, context, opts);
      setResult(res);
      notify("Evaluation complete.", true);
    } catch (err: any) {
      notify(err.message || "Evaluation failed.", false);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Test a Decision</h2>

        <div className="flex bg-slate-100 rounded-lg p-1 text-xs font-semibold">
          <button onClick={() => setMode("rule_set")} className={`flex-1 py-1.5 rounded-md transition ${mode === "rule_set" ? "bg-white shadow-sm text-blue-700" : "text-slate-500"}`}>
            By Rule Set
          </button>
          <button onClick={() => setMode("scope")} className={`flex-1 py-1.5 rounded-md transition ${mode === "scope" ? "bg-white shadow-sm text-blue-700" : "text-slate-500"}`}>
            By Category / Channel
          </button>
        </div>

        {mode === "rule_set" ? (
          <div>
            <label className="block text-xs text-slate-700 font-semibold mb-1">Rule Set</label>
            <select value={ruleSetCode} onChange={(e) => setRuleSetCode(e.target.value)} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium">
              {ruleSets.map((rs) => <option key={rs.id} value={rs.rule_code}>{rs.name}</option>)}
            </select>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-700 font-semibold mb-1">SubCategory</label>
              <select value={subcategoryCode} onChange={(e) => { setSubcategoryCode(e.target.value); setChannelCode(""); }} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium">
                <option value="">Select...</option>
                {allSubcategories.map((s) => <option key={s.id} value={s.code}>{s.categoryName} / {s.name}</option>)}
              </select>
            </div>
            {selectedSub && selectedSub.eligibility_profiles.length > 0 && (
              <div>
                <label className="block text-xs text-slate-700 font-semibold mb-1">Channel (optional)</label>
                <select value={channelCode} onChange={(e) => setChannelCode(e.target.value)} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium">
                  <option value="">Global rules only</option>
                  {selectedSub.eligibility_profiles.map((p) => <option key={p.id} value={p.channel_code}>{p.channel_code}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        <div className="p-3 bg-blue-50/60 border border-blue-100 rounded-xl space-y-2">
          <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">TSAR Context Derivation (optional)</p>
          <p className="text-[10px] text-slate-500">Provide a customer to auto-derive Total Sum At Risk, HLV cap, and channel from their existing policies.</p>
          <div className="grid grid-cols-2 gap-2">
            <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="Customer ID (UUID)" className="border border-slate-200 rounded-md px-2 py-1.5 text-[11px]" />
            <input value={cnic} onChange={(e) => setCnic(e.target.value)} placeholder="or CNIC" className="border border-slate-200 rounded-md px-2 py-1.5 text-[11px]" />
          </div>
          <input
            type="number"
            value={proposedSumAssured || ""}
            onChange={(e) => setProposedSumAssured(Number(e.target.value))}
            placeholder="Proposed Sum Assured (PKR)"
            className="w-full border border-slate-200 rounded-md px-2 py-1.5 text-[11px]"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-700 font-semibold mb-1">Context Overrides (JSON)</label>
          <textarea
            value={contextJson}
            onChange={(e) => setContextJson(e.target.value)}
            rows={8}
            className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono text-slate-800"
          />
        </div>

        <button
          onClick={handleRun}
          disabled={running}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-xs rounded-lg shadow-sm transition"
        >
          {running ? "Running..." : "Run Decision Test"}
        </button>
      </div>

      <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Result</h2>
        {!result ? (
          <div className="p-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg text-xs">
            Run a test to see the evaluation result.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 rounded-lg border bg-blue-50/60 border-blue-200 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-blue-600 uppercase tracking-wider font-semibold">Status</span>
                <h3 className="text-base font-bold text-blue-900 mt-0.5">{result.status}</h3>
              </div>
              <span className="px-3 py-1 bg-blue-100 text-blue-800 border border-blue-300 rounded-full text-xs font-semibold">
                {result.matched_rule_codes.length} rule(s) matched
              </span>
            </div>

            {result.matched_rule_codes.length > 0 && (
              <div className="bg-slate-50 border border-slate-200 p-3 rounded-lg">
                <span className="text-[10px] font-bold text-slate-500 uppercase">Matched Rule Codes</span>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {result.matched_rule_codes.map((c) => (
                    <span key={c} className="font-mono text-[10px] bg-white border border-slate-200 px-2 py-0.5 rounded">{c}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg space-y-2">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Final Impacts</h3>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(result.final_impacts || {}).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 text-slate-500 font-medium">{k}</td>
                      <td className="py-1.5 text-slate-800 font-semibold text-right">
                        {Array.isArray(v) ? (v.length ? v.join(", ") : "—") : v === null ? "—" : String(v)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {result.reasons && result.reasons.length > 0 && (
              <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg space-y-1">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Reasons</h3>
                <ul className="space-y-1 text-xs text-slate-700 list-disc list-inside">
                  {result.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}

            {result.rule_set_results && result.rule_set_results.length > 0 && (
              <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg space-y-2">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Per-Rule-Set Results</h3>
                {result.rule_set_results.map((r, i) => (
                  <div key={i} className="text-xs bg-white border border-slate-200 rounded-lg p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-slate-700">{r.rule_set_code}</span>
                      <span className="text-slate-500">{r.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
