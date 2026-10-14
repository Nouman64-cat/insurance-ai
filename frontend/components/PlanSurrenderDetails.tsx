import type { SurrenderChargeBand, SurrenderTerms } from "@/app/services/insurancePlans";
import { tx } from "@/lib/i18n/tx";

export function surrenderStatus(terms?: SurrenderTerms | null): string {
  if (!terms) return tx("Not researched");
  return tx({ verified: "Published terms", conflicting_sources: "Terms need confirmation",
    not_disclosed: "Not disclosed", not_applicable: "No surrender value" }[terms.status]);
}

function Schedule({ bands, unit }: { bands: SurrenderChargeBand[]; unit: string | null }) {
  const month = unit?.endsWith("month");
  return <table className="w-full text-xs border border-slate-200">
    <thead className="bg-slate-50 text-left"><tr><th className="px-3 py-2">{tx(month ? "Policy / membership month" : "Policy / membership year")}</th><th className="px-3 py-2">{tx("Charge (% of account value)")}</th></tr></thead>
    <tbody>{bands.map((b) => <tr key={b.from} className="border-t border-slate-100">
      <td className="px-3 py-2">{b.through == null ? tx("{0} onwards", { 0: b.from }) : b.from === b.through ? b.from : `${b.from}–${b.through}`}</td>
      <td className="px-3 py-2 font-semibold">{b.charge_pct}%</td>
    </tr>)}</tbody>
  </table>;
}

export default function PlanSurrenderDetails({ terms }: { terms?: SurrenderTerms | null }) {
  const partial = terms?.partial_withdrawal;
  const zero = terms?.zero_charge_conditions;
  return <section className="border-t border-slate-200 pt-4 space-y-3">
    <h3 className="text-sm font-bold text-slate-900">{tx("Early exit & surrender")}</h3>
    <p className={`text-xs font-semibold ${terms?.status === "conflicting_sources" ? "text-amber-700" : "text-slate-600"}`}>{surrenderStatus(terms)}</p>
    {!terms ? <p className="text-xs text-slate-500">{tx("Surrender terms have not been researched for this plan.")}</p> : <>
      {terms.status === "conflicting_sources" && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{tx("Published terms conflict. Confirm the issued policy version with the insurer before applying these charges.")}</p>}
      {terms.status === "not_disclosed" && <p className="text-xs text-slate-600">{tx("The reviewed brochure does not disclose surrender rates. This does not mean surrender is free.")}</p>}
      {terms.has_surrender_value === false && <p className="text-xs text-slate-600">{tx("This plan has no cash surrender value.")}</p>}
      {terms.charge_schedule && <Schedule bands={terms.charge_schedule} unit={terms.schedule_unit} />}
      {terms.processing_fee_pkr != null && <p className="text-xs text-slate-700">{tx("Processing fee: PKR {0} per surrender / withdrawal", { 0: terms.processing_fee_pkr.toLocaleString() })}</p>}
      {zero && <p className="text-xs text-slate-600">{tx("Nil-charge conditions: at least {0} completed months and {1} full years of premiums / contributions paid.", { 0: zero.minimum_completed_months, 1: zero.minimum_full_years_premiums_paid ?? zero.minimum_full_years_contributions_paid })}</p>}
      {terms.free_look_days != null && <p className="text-xs text-slate-600">{tx("Free-look cancellation period: {0} days", { 0: terms.free_look_days })}</p>}
      {partial && <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
        <h4 className="font-semibold">{tx("Partial withdrawals")}</h4>
        {partial.minimum_inforce_months != null && <p>{tx("Available after {0} months in force", { 0: partial.minimum_inforce_months })}</p>}
        <p>{tx("Maximum: {0}% of net cash surrender value", { 0: partial.maximum_pct_of_net_cash_surrender_value })}</p>
        {partial.maximum_per_year != null && <p>{tx("Up to {0} withdrawals per year", { 0: partial.maximum_per_year })}</p>}
        <p>{tx("Minimum retained value: PKR {0}", { 0: partial.minimum_remaining_net_cash_surrender_value_pkr.toLocaleString() })}</p>
        {partial.conditions.map((condition, i) => <p key={i}>{tx(condition)}</p>)}
      </div>}
      {terms.loan && <p className="text-xs text-slate-600">{tx("Loan limit: {0}% of net cash surrender value", { 0: terms.loan.maximum_pct_of_net_cash_surrender_value })}{" "}{terms.loan.eligibility_text && tx(terms.loan.eligibility_text)}</p>}
      {terms.alternative_published_schedules?.map((alternative, i) => <div key={i} className="space-y-2">
        <h4 className="text-xs font-semibold text-amber-800">{tx("Alternative published schedule — requires confirmation")}</h4>
        <Schedule bands={alternative.charge_schedule} unit={alternative.schedule_unit} />
      </div>)}
      <details className="text-xs text-slate-600"><summary className="cursor-pointer font-semibold">{tx("Conditions & source documents")}</summary>
        <ul className="list-disc ps-4 mt-2 space-y-2">{terms.notes.map((note, i) => <li key={i}>{tx(note)}</li>)}</ul>
        <p className="mt-3">{tx("Researched on: {0}", { 0: terms.researched_on })}</p>
        <ul className="mt-2 space-y-2">{terms.sources.map((source, i) => <li key={i}><a href={source.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline break-words">{source.title}</a>{source.pages && ` · ${tx("Pages")} ${source.pages.join(", ")}`}</li>)}</ul>
      </details>
      {terms.has_surrender_value !== false && <p className="text-[11px] text-slate-500">{tx("These are catalog references. The payable amount depends on the issued contract and actual insurer account value.")}</p>}
    </>}
  </section>;
}
