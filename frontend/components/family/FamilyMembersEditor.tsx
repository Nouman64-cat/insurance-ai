"use client";

// The member table shared by the "Add New Family" window and the family's Manage page.
//
// Only the head ("Self") and — if the family wants it — the spouse are insured and underwritten.
// Everyone else is a nominee: no cover, no medical, just a share of the head's death benefit.
// Every member except the head carries a share (%), and the shares total 100%.

import { InsurancePlan } from "@/app/services/insurancePlans";

export type Kind = "Self" | "Spouse" | "Nominee";

export interface FamilyRow {
  kind: Kind;
  /** Nominees only: how they are related to the head. */
  relationship: string;
  /** Spouse only: is the spouse fully insured too? "" = not answered yet. */
  insured: "" | "yes" | "no";
  name: string; cnic: string; dob: string; gender: string; occupation: string; declared_income: string;
  is_smoker: string; height_cm: string; weight_kg: string; coverage_amount: string; plan_code: string;
  share_pct: string;
}

export const NOMINEE_RELATIONSHIPS = ["Child", "Parent", "Sibling", "Other"];

export const blankRow = (kind: Kind = "Nominee"): FamilyRow => ({
  kind, relationship: kind === "Nominee" ? "Child" : "", insured: kind === "Self" ? "yes" : "",
  name: "", cnic: "", dob: "", gender: "", occupation: "", declared_income: "",
  is_smoker: "", height_cm: "", weight_kg: "", coverage_amount: "", plan_code: "", share_pct: "",
});

export const startRows = (): FamilyRow[] => [blankRow("Self"), blankRow("Spouse")];

export const isInsured = (r: FamilyRow): boolean => r.kind === "Self" || (r.kind === "Spouse" && r.insured === "yes");
export const relationshipOf = (r: FamilyRow): string => (r.kind === "Nominee" ? r.relationship : r.kind);

export function formatCNIC(value: string): string {
  const v = value.replace(/\D/g, "");
  let res = "";
  if (v.length > 0) res += v.substring(0, 5);
  if (v.length > 5) res += "-" + v.substring(5, 12);
  if (v.length > 12) res += "-" + v.substring(12, 13);
  return res;
}

const num = (v: string): number => parseFloat(v) || 0;
export const totalShare = (rows: FamilyRow[]): number =>
  Math.round(rows.filter((r) => r.kind !== "Self").reduce((n, r) => n + num(r.share_pct), 0) * 100) / 100;

/** The body of the validate / confirm calls. */
export function buildMembersPayload(rows: FamilyRow[], isBundle: boolean): Record<string, unknown>[] {
  return rows.map((r) => {
    const base: Record<string, unknown> = {
      relationship: relationshipOf(r), name: r.name, is_insured: isInsured(r),
      ...(r.kind !== "Self" ? { share_pct: num(r.share_pct) } : {}),
      ...(r.cnic ? { cnic: r.cnic } : {}), ...(r.dob ? { dob: r.dob } : {}), ...(r.gender ? { gender: r.gender } : {}),
    };
    if (!isInsured(r)) return base;
    return {
      ...base, occupation: r.occupation, declared_income: num(r.declared_income),
      ...(r.is_smoker !== "" ? { is_smoker: r.is_smoker === "true" } : {}),
      ...(r.height_cm !== "" ? { height_cm: num(r.height_cm) || undefined } : {}),
      ...(r.weight_kg !== "" ? { weight_kg: num(r.weight_kg) || undefined } : {}),
      ...(isBundle ? { coverage_amount: num(r.coverage_amount), plan_code: r.plan_code } : {}),
    };
  });
}

const empty = (v: string) => v.trim() === "";

/** An untouched extra row (nothing typed into it): safe to ignore rather than report as incomplete. */
export const isBlankRow = (r: FamilyRow) =>
  r.kind !== "Self" &&
  [r.name, r.cnic, r.dob, r.gender, r.occupation, r.declared_income, r.share_pct].every((v) => empty(String(v ?? "")));

/**
 * What is wrong with the rows, before anything is saved. `existingShare` is what earlier batches already
 * gave their nominees; `hasHead` is false when the head was enrolled earlier (an add-on batch).
 */
export function checkRows(rows: FamilyRow[], isBundle: boolean, existingShare = 0, hasHead = false): { problems: string[]; flagged: string[] } {
  const problems: string[] = [];
  const flagged: string[] = [];
  const flag = (i: number, f: keyof FamilyRow) => flagged.push(`member.${i}.${f}`);
  const heads = rows.filter((r) => r.kind === "Self").length;
  if (!hasHead && heads !== 1) problems.push(`Exactly one member must be the head (found ${heads})`);
  if (hasHead && heads > 0) problems.push("The head is already enrolled on this policy");
  if (rows.filter((r) => r.kind === "Spouse").length > 1) problems.push("A family can have only one spouse");

  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.kind === "Spouse" && r.insured === "") { problems.push(`Row ${n}: say whether the spouse is fully insured`); flag(i, "insured"); }
    if (empty(r.name)) { problems.push(`Row ${n}: name is missing`); flag(i, "name"); }
    if (r.kind !== "Self" && !(num(r.share_pct) > 0)) { problems.push(`Row ${n}: nominee share is missing`); flag(i, "share_pct"); }
    if (isInsured(r)) {
      const need: [keyof FamilyRow, string][] = [["cnic", "CNIC"], ["dob", "date of birth"], ["gender", "gender"], ["occupation", "occupation"], ["declared_income", "annual income"],
        ...(isBundle ? ([["coverage_amount", "coverage"], ["plan_code", "plan"]] as [keyof FamilyRow, string][]) : [])];
      need.forEach(([f, text]) => { if (empty(String(r[f]))) { problems.push(`Row ${n}: ${text} is missing`); flag(i, f); } });
    }
  });
  const cnics = rows.map((r) => r.cnic).filter(Boolean);
  if (new Set(cnics).size !== cnics.length) problems.push("Two members have the same CNIC");
  const total = Math.round((totalShare(rows) + existingShare) * 100) / 100;
  if (rows.some((r) => r.kind !== "Self") && Math.abs(total - 100) > 0.01) problems.push(`Nominee shares must total 100% (they are ${total}%)`);
  return { problems, flagged };
}

const CELL = "w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-300 disabled:cursor-not-allowed";
const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

interface Props {
  rows: FamilyRow[];
  onChange: (rows: FamilyRow[]) => void;
  isBundle: boolean;
  lifePlans: InsurancePlan[];
  /** What a share is a share of: the floater's sum insured, or the head's own cover for a life bundle. */
  baseAmount: number;
  /** `member.<row>.<field>` keys to highlight while still empty (from a document that lacked them). */
  flagged?: Set<string>;
  /** Shares already given to nominees by earlier batches. */
  existingShare?: number;
  /** An add-on batch to a family whose head is already enrolled: no head row. */
  hasHead?: boolean;
  maxRows?: number;
}

export default function FamilyMembersEditor({ rows, onChange, isBundle, lifePlans, baseAmount, flagged, existingShare = 0, hasHead = false, maxRows = 8 }: Props) {
  const set = (i: number, patch: Partial<FamilyRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const miss = (i: number, f: keyof FamilyRow) => !!flagged?.has(`member.${i}.${f}`) && empty(String(rows[i]?.[f] ?? ""));
  const total = Math.round((totalShare(rows) + existingShare) * 100) / 100;
  const nominees = rows.filter((r) => r.kind !== "Self");
  const cell = (i: number, f: keyof FamilyRow, extra = "") => `${CELL} ${miss(i, f) ? "!border-amber-400 !bg-amber-50" : ""} ${extra}`;

  const changeKind = (i: number, kind: Kind) =>
    set(i, { kind, relationship: kind === "Nominee" ? rows[i].relationship || "Child" : "", insured: kind === "Spouse" ? rows[i].insured : "" });

  const splitEvenly = () => {
    const open = 100 - existingShare;
    const n = nominees.length;
    if (!n || open <= 0) return;
    const each = Math.floor((open / n) * 100) / 100;
    let left = Math.round((open - each * n) * 100) / 100;
    onChange(rows.map((r) => {
      if (r.kind === "Self") return r;
      const extra = left > 0 ? left : 0;
      left = 0;
      return { ...r, share_pct: String(Math.round((each + extra) * 100) / 100) };
    }));
  };

  const headers = ["Member", "Relation", "Fully insured?", "Name", "CNIC", "DOB", "Gender", "Occupation", "Annual income", "Smoker", "Ht (cm)", "Wt (kg)",
    ...(isBundle ? ["Coverage", "Plan"] : []), "Share %", "Amount", ""];

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        The head is always insured. A <strong>spouse</strong> can also be fully insured (then underwritten after the head); everyone else is a <strong>nominee</strong> —
        no cover, no medical. Give each person their share of the head&apos;s death benefit; the shares total 100%.
      </p>

      <div className="overflow-x-auto border border-slate-100 rounded-lg">
        <table className="w-full text-xs table-auto">
          <thead>
            <tr className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {headers.map((h, k) => <th key={`${h}${k}`} className="px-2 py-2 text-left whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => {
              const ins = isInsured(r);
              const off = !ins;
              return (
                <tr key={i} className={off ? "bg-slate-50/40" : ""}>
                  <td className="px-1.5 py-1.5 min-w-[92px]">
                    {r.kind === "Self" ? <span className="font-semibold text-slate-700 px-1">Head</span> : (
                      <select className={cell(i, "kind")} value={r.kind} onChange={(e) => changeKind(i, e.target.value as Kind)}>
                        <option value="Spouse">Spouse</option><option value="Nominee">Nominee</option>
                      </select>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5 min-w-[84px]">
                    {r.kind === "Nominee" ? (
                      <select className={cell(i, "relationship")} value={r.relationship} onChange={(e) => set(i, { relationship: e.target.value })}>
                        {NOMINEE_RELATIONSHIPS.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : <span className="text-slate-300 px-1">—</span>}
                  </td>
                  <td className="px-1.5 py-1.5 min-w-[92px]">
                    {r.kind === "Spouse" ? (
                      <select className={cell(i, "insured")} value={r.insured} onChange={(e) => set(i, { insured: e.target.value as FamilyRow["insured"] })}>
                        <option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option>
                      </select>
                    ) : <span className={`px-1 ${r.kind === "Self" ? "text-slate-700" : "text-slate-300"}`}>{r.kind === "Self" ? "Yes" : "No"}</span>}
                  </td>
                  <td className="px-1.5 py-1.5 min-w-[130px]"><input className={cell(i, "name")} value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Full name" /></td>
                  <td className="px-1.5 py-1.5 min-w-[140px]"><input className={cell(i, "cnic")} value={r.cnic} onChange={(e) => set(i, { cnic: formatCNIC(e.target.value) })} placeholder={ins ? "61101-1234567-1" : "Optional"} /></td>
                  <td className="px-1.5 py-1.5 min-w-[120px]"><input type="date" className={cell(i, "dob")} value={r.dob} onChange={(e) => set(i, { dob: e.target.value })} /></td>
                  <td className="px-1.5 py-1.5"><select className={cell(i, "gender")} value={r.gender} onChange={(e) => set(i, { gender: e.target.value })}><option value="">—</option><option>Male</option><option>Female</option></select></td>
                  <td className="px-1.5 py-1.5 min-w-[110px]"><input className={cell(i, "occupation")} disabled={off} value={off ? "" : r.occupation} onChange={(e) => set(i, { occupation: e.target.value })} placeholder={off ? "—" : "Job title"} /></td>
                  <td className="px-1.5 py-1.5 min-w-[100px]"><input type="number" className={cell(i, "declared_income")} disabled={off} value={off ? "" : r.declared_income} onChange={(e) => set(i, { declared_income: e.target.value })} placeholder={off ? "—" : "0"} /></td>
                  <td className="px-1.5 py-1.5"><select className={cell(i, "is_smoker")} disabled={off} value={off ? "" : r.is_smoker} onChange={(e) => set(i, { is_smoker: e.target.value })}><option value="">—</option><option value="false">No</option><option value="true">Yes</option></select></td>
                  <td className="px-1.5 py-1.5 w-[72px] min-w-[72px]"><input type="number" className={cell(i, "height_cm")} disabled={off} value={off ? "" : r.height_cm} onChange={(e) => set(i, { height_cm: e.target.value })} placeholder="cm" /></td>
                  <td className="px-1.5 py-1.5 w-[72px] min-w-[72px]"><input type="number" className={cell(i, "weight_kg")} disabled={off} value={off ? "" : r.weight_kg} onChange={(e) => set(i, { weight_kg: e.target.value })} placeholder="kg" /></td>
                  {isBundle && (
                    <>
                      <td className="px-1.5 py-1.5 min-w-[110px]"><input type="number" className={cell(i, "coverage_amount")} disabled={off} value={off ? "" : r.coverage_amount} onChange={(e) => set(i, { coverage_amount: e.target.value })} placeholder={off ? "—" : "5000000"} /></td>
                      <td className="px-1.5 py-1.5 min-w-[140px]">
                        <select className={cell(i, "plan_code")} disabled={off} value={off ? "" : r.plan_code} onChange={(e) => set(i, { plan_code: e.target.value })}>
                          <option value="">{off ? "—" : "Select plan"}</option>
                          {lifePlans.map((p) => <option key={p.id} value={p.code}>{p.label}</option>)}
                        </select>
                      </td>
                    </>
                  )}
                  <td className="px-1.5 py-1.5 w-[84px] min-w-[84px]">
                    {r.kind === "Self" ? <span className="text-slate-300 px-1">—</span> : (
                      <input type="number" min="0" max="100" step="0.01" className={cell(i, "share_pct")} value={r.share_pct} onChange={(e) => set(i, { share_pct: e.target.value })} placeholder="%" />
                    )}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-slate-600">
                    {r.kind !== "Self" && num(r.share_pct) > 0 && baseAmount > 0 ? pkr((num(r.share_pct) / 100) * baseAmount) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-1.5 py-1.5">{r.kind !== "Self" && <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-600" aria-label="Remove member">✕</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4">
          {rows.length < maxRows && (
            <button type="button" onClick={() => onChange([...rows, blankRow("Nominee")])} className="text-xs font-semibold text-blue-600 hover:text-blue-800">+ Add nominee</button>
          )}
          {nominees.length > 0 && <button type="button" onClick={splitEvenly} className="text-xs font-semibold text-slate-600 hover:text-slate-900">Split evenly</button>}
        </div>
        {nominees.length > 0 && (
          <p className={`text-xs font-semibold tabular-nums ${Math.abs(total - 100) < 0.01 ? "text-emerald-700" : "text-amber-700"}`}>
            Nominee shares: {total}%{Math.abs(total - 100) < 0.01 ? " ✓" : " — must total 100%"}
            {baseAmount > 0 && <span className="font-normal text-slate-400"> · of {pkr(baseAmount)}</span>}
          </p>
        )}
      </div>
    </div>
  );
}
