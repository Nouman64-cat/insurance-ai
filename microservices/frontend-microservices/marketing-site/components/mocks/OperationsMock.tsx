import { Icon } from "@/components/ui/Icon";

const examples = {
  finance: {title:"Finance payment workspace",reference:"CLM-DEMO-0042",rows:[["Claim decision","Approved by Claims Manager"],["Payee details","Verified"],["Settlement","Authorised by Claims Manager"],["External payment","Recorded Paid · BANK-DEMO-42"],["Reconciliation","Pending Finance review"]],note:"Recording a payment does not initiate a bank transfer."},
  commissions: {title:"Commission earnings register",reference:"Premium receipt · DEMO-0018",rows:[["Source","Agent allocation recorded"],["Premium","Receipt confirmed after issuance"],["Commission","Rate from configured rule"],["Payable date","Source start-day next month"],["Corrections","Reason and adjustment history retained"]],note:"Amounts and recurring eligibility follow the applicable commission rules."},
  customer: {title:"Connected customer journey",reference:"Customer portal · illustrative view",rows:[["Policy","Policy details available"],["Disclosure","Customer questionnaire submitted"],["Evidence","Requested document uploaded"],["Service request","With the responsible team"],["Claim","Status available in the customer journey"]],note:"Available customer journeys follow the insurer’s configuration."},
};

export function OperationsMock({kind}: {kind:keyof typeof examples}) {
  const data=examples[kind];
  return <div className="card mx-auto w-full max-w-[34rem] overflow-hidden shadow-float" role="img" aria-label={`${data.title}, illustrative demo data`}>
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-faint">{data.title}</p><p className="mt-2 text-sm font-semibold text-ink">{data.reference}</p></div><span className="shrink-0 rounded-full bg-chip px-2.5 py-1 text-xs text-body">Demo data</span></div>
    <dl className="divide-y divide-line px-5">{data.rows.map(([label,value])=><div key={label} className="flex items-start justify-between gap-5 py-4 text-sm"><dt className="text-muted">{label}</dt><dd className="max-w-[65%] text-right font-medium text-ink">{value}</dd></div>)}</dl>
    <p className="flex items-start gap-2 border-t border-line bg-alt px-5 py-4 text-xs leading-relaxed text-body"><Icon name="file" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />{data.note}</p>
  </div>;
}
