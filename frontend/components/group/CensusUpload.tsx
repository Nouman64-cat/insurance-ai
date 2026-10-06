"use client";

import { useRef, useState } from "react";
import api from "@/app/services/api";
import { PanelProps, errMsg, mpBase, pkr } from "./groupShared";

interface Parsed {
  filename: string;
  rows: Record<string, any>[];
  row_count: number;
  columns: string[];
  ignored_columns: string[];
  warnings: string[];
}
interface Validation {
  is_valid: boolean;
  total: number;
  duplicate_cnics: string[];
  missing_fields: string[];
  errors: string[];
  computed_free_cover_limit: number | null;
}

/**
 * Load a census from a CSV or Excel file: the server reads the file, the same
 * validator the form uses checks every row, and nothing is enrolled until the
 * admin confirms a clean result.
 */
export default function CensusUpload({ tenantId, orgId, mp, reload }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [verdict, setVerdict] = useState<Validation | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reset = () => { setParsed(null); setVerdict(null); if (input.current) input.current.value = ""; };

  const onFile = async (file: File) => {
    setError(""); setNotice(""); setParsed(null); setVerdict(null); setBusy("Reading the file…");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.post<Parsed>(`${base}/census/parse`, form, { headers: { "Content-Type": "multipart/form-data" } });
      setParsed(res.data);
      setBusy("Checking every row…");
      const check = await api.post<Validation>(`${base}/census/validate`, { employees: res.data.rows });
      setVerdict(check.data);
    } catch (e: any) { setError(errMsg(e, "Could not read that file.")); }
    finally { setBusy(""); if (input.current) input.current.value = ""; }
  };

  const confirm = async () => {
    if (!parsed) return;
    setError(""); setBusy("Enrolling…");
    try {
      const res = await api.post(`${base}/census/confirm`, { employees: parsed.rows });
      const above = res.data.employees.filter((e: any) => e.coverage_amount > res.data.free_cover_limit).length;
      setNotice(`${res.data.employees.length} employees enrolled — Free Cover Limit ${pkr(res.data.free_cover_limit)}` +
        (above ? `; ${above} above it were routed to underwriting.` : "; all guaranteed-issue."));
      reset();
      await reload();
    } catch (e: any) { setError(errMsg(e, "Could not enrol the census.")); }
    finally { setBusy(""); }
  };

  const problems = verdict ? [...verdict.missing_fields, ...verdict.errors] : [];
  const preview = parsed?.rows.slice(0, 6) ?? [];
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-slate-700">Upload a census file</p>
          <p className="text-xs text-slate-400">
            .csv or .xlsx — columns: cnic, name, dob, gender, occupation, declared_income (annual), plus optional employee_id, designation,
            grade, joining_date, benefit_class, basic_monthly_salary, is_smoker, height_cm, weight_kg.
          </p>
        </div>
        <input ref={input} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        <button onClick={() => input.current?.click()} disabled={!!busy}
          className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60">
          Choose file
        </button>
      </div>

      {busy && <p className="text-xs text-slate-500">{busy}</p>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 font-medium">{error}</div>}
      {notice && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 font-medium">{notice}</div>}

      {parsed && (
        <div className="space-y-3">
          <p className="text-xs text-slate-600">
            <strong>{parsed.filename}</strong> — {parsed.row_count} employee row{parsed.row_count === 1 ? "" : "s"}
            {parsed.ignored_columns.length > 0 && <span className="text-amber-700"> · ignored columns: {parsed.ignored_columns.join(", ")}</span>}
          </p>
          {parsed.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
          <div className="overflow-x-auto border border-slate-100 rounded-lg">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50 text-slate-400 uppercase tracking-wider">
                {parsed.columns.map((c) => <th key={c} className="px-3 py-2 text-left whitespace-nowrap">{c}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {preview.map((r, i) => (
                  <tr key={i}>{parsed.columns.map((c) => <td key={c} className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{String(r[c] ?? "")}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.row_count > preview.length && <p className="text-[11px] text-slate-400">Showing the first {preview.length} rows.</p>}

          {verdict && (verdict.is_valid ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-sm text-emerald-800 font-medium">
                All {verdict.total} rows are valid{verdict.computed_free_cover_limit != null ? ` · Free Cover Limit will be ${pkr(verdict.computed_free_cover_limit)}` : ""}.
              </p>
              <div className="flex gap-2">
                <button onClick={reset} className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg">Cancel</button>
                <button onClick={confirm} disabled={!!busy} className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg">
                  Enrol {verdict.total} employees
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-1">
              <p className="text-sm font-bold text-red-700">Fix these before enrolling — nothing has been saved:</p>
              {problems.slice(0, 12).map((p, i) => <p key={i} className="text-xs text-red-700">• {p}</p>)}
              {problems.length > 12 && <p className="text-xs text-red-700">…and {problems.length - 12} more.</p>}
              {verdict.duplicate_cnics.length > 0 && <p className="text-xs text-red-700">• Duplicate CNICs: {verdict.duplicate_cnics.join(", ")}</p>}
              <button onClick={reset} className="mt-1 text-xs font-semibold text-red-700 underline">Choose a corrected file</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
