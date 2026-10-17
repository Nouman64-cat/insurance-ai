"use client";

import { useEffect, useState } from "react";
import { useNotify } from "@/components/NotificationContext";
import { RuleSetSummary, EvaluationResult, listRuleSets, evaluateRuleSet } from "@/app/services/ruleEngine";
import { BOOLEAN_FIELDS, IMPACT_TYPE_CONFIG, OPTION_FIELDS, plainFieldLabel } from "./constants";
import FieldSearchSelect from "./FieldSearchSelect";
import { tx } from "@/lib/i18n/tx";

type Row = { field: string; value: string };

const control = "rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100";

const STARTER_ROWS: Record<string, Row[]> = {
  "RS-RISK-001": [{ field: "age", value: "48" }, { field: "bmi", value: "31" }, { field: "smoking_status", value: "current" }],
  "RS-ELG-002": [{ field: "age", value: "17" }, { field: "occupation", value: "Army officer" }],
};

const IMPACT_LABELS: Record<string, (v: any) => string | null> = {
  extra_mortality_pct: (v) => (v ? `Premium loading +${v}%` : null),
  flat_extra_per_thousand: (v) => (v ? `Flat extra PKR ${v} per 1,000 cover` : null),
  medical_profile_codes: (v) => (v?.length ? `Medical tests: ${v.join(", ")}` : null),
  exclusion_riders: (v) => (v?.length ? `Exclusions: ${v.join(", ").replace(/_/g, " ")}` : null),
  hlv_max_multiple: (v) => (v ? `Max cover ${v}× income` : null),
  reinsurance_retention_limit: (v) => (v ? `Reinsurer limit PKR ${Number(v).toLocaleString()}` : null),
  underwriter_authority_level: (v) => (v ? `Needs approver level ${v}` : null),
  commission_pct: (v) => (v != null ? `Commission ${v}%` : null),
  withholding_tax_pct: (v) => (v != null ? `Withholding tax ${v}%` : null),
};

function toValue(field: string, raw: string): any {
  if (BOOLEAN_FIELDS.has(field)) return raw === "true";
  const n = Number(raw);
  return raw.trim() !== "" && !isNaN(n) && !OPTION_FIELDS[field] ? n : raw;
}

export default function SimulatorTab({ tenantId }: { tenantId: string }) {
  const { notify } = useNotify();
  const [ruleSets, setRuleSets] = useState<RuleSetSummary[]>([]);
  const [ruleSetCode, setRuleSetCode] = useState("");
  const [rows, setRows] = useState<Row[]>([{ field: "age", value: "45" }]);
  const [cnic, setCnic] = useState("");
  const [cover, setCover] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const sets = await listRuleSets(tenantId);
        setRuleSets(sets);
        if (sets.length > 0) pick(sets[0].rule_code);
      } catch (err: any) {
        notify(err.message || tx("Failed to load rule sets."), false);
      }
    })();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (code: string) => {
    setRuleSetCode(code);
    setResult(null);
    setRows(STARTER_ROWS[code] ?? [{ field: "age", value: "45" }]);
  };

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const handleRun = async () => {
    const context = Object.fromEntries(rows.filter((r) => r.field).map((r) => [r.field, toValue(r.field, r.value)]));
    setRunning(true);
    setResult(null);
    try {
      const res = await evaluateRuleSet(tenantId, ruleSetCode, context, {
        cnic: cnic || undefined,
        proposed_sum_assured: Number(cover) || undefined,
        actor: "Rule test",
      });
      setResult(res);
    } catch (err: any) {
      notify(err.message || tx("The test could not be run."), false);
    } finally {
      setRunning(false);
    }
  };

  const selected = ruleSets.find((r) => r.rule_code === ruleSetCode);
  const outcomes = result
    ? Object.entries(result.final_impacts || {}).map(([k, v]) => IMPACT_LABELS[k]?.(v)).filter(Boolean) as string[]
    : [];
  const matched = result?.matched_impacts ?? result?.matched_rule_codes.map((c) => ({ rule_code: c, name: c, impact_type: "", reason: null })) ?? [];

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <div className="space-y-5 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm lg:col-span-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{tx("Try a rule set")}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{tx("Enter some details and see which rules would match. Nothing is saved to a customer.")}</p>
        </div>

        <label className="block text-xs font-medium text-slate-700">
          {tx("Rule set")}
          <select value={ruleSetCode} onChange={(e) => pick(e.target.value)} className={`${control} mt-1 w-full`}>
            {ruleSets.map((rs) => (
              <option key={rs.id} value={rs.rule_code}>{rs.name}{rs.connected ? ` — ${tx("in use")}` : ""}</option>
            ))}
          </select>
          {selected?.used_by && <span className="mt-1 block text-[11px] font-normal text-slate-400">{tx("Decides: {0}", { 0: selected.used_by })}</span>}
        </label>

        <div>
          <p className="mb-2 text-xs font-medium text-slate-700">{tx("Details to test")}</p>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><FieldSearchSelect value={r.field} onChange={(v) => setRow(i, { field: v, value: BOOLEAN_FIELDS.has(v) ? "true" : OPTION_FIELDS[v]?.[0].value ?? "" })} /></div>
                {BOOLEAN_FIELDS.has(r.field) ? (
                  <select value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} className={`${control} w-28`}>
                    <option value="true">{tx("Yes")}</option><option value="false">{tx("No")}</option>
                  </select>
                ) : OPTION_FIELDS[r.field] ? (
                  <select value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} className={`${control} w-36`}>
                    {OPTION_FIELDS[r.field].map((o) => <option key={o.value} value={o.value}>{tx(o.label)}</option>)}
                  </select>
                ) : (
                  <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={tx("value")} className={`${control} w-28`} />
                )}
                <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600" aria-label={tx("Remove")}>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
          </div>
          <button onClick={() => setRows([...rows, { field: "", value: "" }])} className="mt-2 text-xs font-semibold text-blue-600 hover:underline">
            {tx("+ Add a detail")}
          </button>
        </div>

        <div className="rounded-xl border border-slate-200">
          <button onClick={() => setShowMore((v) => !v)} className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-slate-600">
            {tx("Use an existing customer (optional)")}
            <svg className={`h-4 w-4 text-slate-400 transition ${showMore ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
          {showMore && (
            <div className="grid grid-cols-2 gap-2 border-t border-slate-100 px-3.5 py-3">
              <input value={cnic} onChange={(e) => setCnic(e.target.value)} placeholder={tx("Customer CNIC")} className={control} />
              <input type="number" value={cover} onChange={(e) => setCover(e.target.value)} placeholder={tx("New cover (PKR)")} className={control} />
              <p className="col-span-2 text-[11px] text-slate-400">{tx("Adds their existing cover and income limits to the test. Details above override them.")}</p>
            </div>
          )}
        </div>

        <button
          onClick={handleRun}
          disabled={running || !ruleSetCode}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? tx("Checking…") : tx("Run test")}
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm lg:col-span-7">
        <h2 className="text-base font-semibold text-slate-900">{tx("Result")}</h2>
        {!result ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-200 p-12 text-center text-sm text-slate-400">
            {tx("Run a test to see which rules match.")}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className={`rounded-2xl p-4 ${matched.length ? "bg-blue-50 text-blue-900" : "bg-slate-50 text-slate-700"}`}>
              <p className="text-lg font-semibold">
                {matched.length === 0 ? tx("No rule matched") : matched.length === 1 ? tx("1 rule matched") : tx("{0} rules matched", { 0: matched.length })}
              </p>
              <p className="mt-0.5 text-xs opacity-80">
                {matched.length === 0 ? tx("With these details nothing would change.") : tx("Using version {0} of {1}.", { 0: result.version_number ?? "", 1: selected?.name ?? ruleSetCode })}
              </p>
            </div>

            {matched.length > 0 && (
              <ul className="space-y-2">
                {matched.map((m) => {
                  const cfg = IMPACT_TYPE_CONFIG[m.impact_type as keyof typeof IMPACT_TYPE_CONFIG];
                  return (
                    <li key={m.rule_code} className="rounded-xl border border-slate-200/80 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-900">{m.name}</span>
                        {cfg && <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${cfg.badge}`}>{tx(cfg.label)}</span>}
                      </div>
                      {m.reason && <p className="mt-1 text-xs text-slate-500">{m.reason}</p>}
                    </li>
                  );
                })}
              </ul>
            )}

            {outcomes.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-slate-700">{tx("Combined effect")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {outcomes.map((o) => <span key={o} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-700">{o}</span>)}
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-400">
              {tx("Tested with")}: {rows.filter((r) => r.field).map((r) => `${plainFieldLabel(r.field)} = ${r.value}`).join(" · ")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
