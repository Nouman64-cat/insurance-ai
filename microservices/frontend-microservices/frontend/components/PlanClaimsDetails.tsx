import type { ClaimsTerms } from "@/app/services/insurancePlans";
import { tx } from "@/lib/i18n/tx";

const SCOPE_LABELS = { base: "Base cover", built_in: "Built-in benefit", optional_rider: "Optional rider", plan_benefit: "Plan benefit" };
const EVENT_LABELS: Record<string, string> = { death: "Death", disability: "Disability", hospitalization: "Hospitalization" };

export default function PlanClaimsDetails({ terms }: { terms?: ClaimsTerms | null }) {
  return <section className="mt-5 space-y-3 border-t border-slate-200 pt-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-bold text-slate-900">{tx("Claims & eligibility")}</h3>
      {terms && <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold text-slate-600">{tx("Brochure reference")}</span>}
    </div>
    {!terms ? <p className="text-xs text-slate-500">{tx("Claims criteria have not been researched for this plan.")}</p> : <>
      <p className="rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-xs leading-5 text-slate-600">{tx("The issued policy and selected riders determine claim eligibility. Optional riders apply only when included in the customer's cover.")}</p>
      {terms.status === "conflicting_sources" && <p className="text-xs text-amber-700">{tx("Some published details require confirmation against the issued policy.")}</p>}
      <div className="space-y-2">{terms.benefits.filter(b => b.scope !== "optional_rider").map((b, i) => <div key={i} className="rounded-xl border border-slate-200 p-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tx(SCOPE_LABELS[b.scope])}</span>
        <p className="mt-1 text-xs leading-5 text-slate-700">{tx(b.summary)}</p>
        {b.conditions.length > 0 && <ul className="mt-2 list-disc space-y-1 ps-4 text-xs leading-5 text-slate-500">{b.conditions.map((s, j) => <li key={j}>{tx(s)}</li>)}</ul>}
      </div>)}</div>
      <div className="rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        <h4 className="font-semibold text-slate-800">{tx("Waiting periods & notification")}</h4>
        {terms.waiting_periods ? terms.waiting_periods.map((w, i) => <p key={i} className="mt-1">{tx(w.summary)}</p>) : <p className="mt-1">{tx("Waiting period not disclosed in the reviewed brochure. Confirm the policy wording.")}</p>}
        <p className="mt-2">{terms.notification ? tx(terms.notification.summary) : tx("No plan-specific notification deadline is published in the reviewed brochure. Notify the insurer promptly.")}</p>
      </div>
      {terms.benefits.some(b => b.scope === "optional_rider") && <details className="rounded-xl border border-slate-200 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-slate-700">{tx("Optional rider claims")}</summary>
        <ul className="mt-3 space-y-3 text-slate-600">{terms.benefits.filter(b => b.scope === "optional_rider").map((b, i) => <li key={i}><p className="leading-5">{tx(b.summary)}</p>{b.conditions.map((c, j) => <p key={j} className="mt-1 text-slate-500">{tx(c)}</p>)}</li>)}</ul>
      </details>}
      <details className="rounded-xl border border-slate-200 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-slate-700">{tx("Exclusions")}</summary>
        {terms.exclusions ? <><p className="mt-2 text-slate-500">{tx("Published summary; consult the contract for the full exclusions.")}</p><ul className="mt-2 list-disc space-y-2 ps-4 text-slate-600">{terms.exclusions.map((e, i) => <li key={i}>{tx(e.summary)}</li>)}</ul></> : <p className="mt-2 leading-5 text-slate-500">{tx("The reviewed brochure does not list the full exclusions. This does not mean all events are covered.")}</p>}
      </details>
      <details className="rounded-xl border border-slate-200 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-slate-700">{tx("Documents & filing a claim")}</summary>
        {Object.entries(terms.documents).map(([event, docs]) => <div key={event} className="mt-3">
          <h4 className="font-semibold text-slate-800">{tx(EVENT_LABELS[event] ?? event)}</h4>
          <ul className="mt-1 list-disc space-y-1 ps-4 text-slate-600">{docs.required.map((doc, i) => <li key={i}>{tx(doc)}</li>)}{docs.conditional.map((doc, i) => <li key={`c-${i}`}>{tx(doc.document)} — {tx(doc.condition)}</li>)}</ul>
        </div>)}
        <ol className="mt-4 list-decimal space-y-1 ps-4 text-slate-600">{terms.filing.steps.map((s, i) => <li key={i}>{tx(s)}</li>)}</ol>
        <p className="mt-3 leading-5 text-slate-500">{tx(terms.filing.document_authenticity)}</p>
        <p className="mt-2 leading-5 text-slate-500">{tx(terms.filing.decision_time)}</p>
        <a href={terms.filing.portal_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex rounded-lg bg-blue-50 px-3 py-2 font-semibold text-slate-700 hover:bg-blue-100">{tx("Open insurer claims portal")} ↗</a>
      </details>
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer font-semibold">{tx("Research notes & sources")}</summary>
        <ul className="mt-2 list-disc space-y-2 ps-4">{[...terms.notes, ...terms.not_disclosed].map((note, i) => <li key={i}>{tx(note)}</li>)}</ul>
        <p className="mt-3">{tx("Researched on: {0}", { 0: terms.researched_on })}</p>
        <ul className="mt-2 space-y-2">{terms.sources.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">{s.title}</a>{s.pages && ` · ${tx("Pages")} ${s.pages.join(", ")}`}</li>)}</ul>
      </details>
    </>}
  </section>;
}
