import { Icon } from "@/components/ui/Icon";

export function CopilotMock() {
  return (
    <div className="card mx-auto w-full max-w-[34rem] overflow-hidden shadow-float" role="img" aria-label="Illustrative Finance Copilot conversation, demo data">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-white">
          <Icon name="building" className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold text-ink">Finance Copilot</p>
        <span className="ml-auto text-xs text-faint">Demo data</span>
      </div>
      <div className="space-y-3 px-5 py-4 text-sm">
        <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-brand px-3.5 py-2.5 text-white">
          Can I record the payment for CLM-DEMO-0042?
        </div>
        <div className="max-w-[90%] rounded-xl rounded-bl-sm bg-chip px-3.5 py-2.5 text-ink">
          The Claims Manager has authorised settlement and the payee is verified.
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-body">
            <dt>Claim</dt><dd className="text-ink">Approved</dd>
            <dt>Settlement</dt><dd className="text-ink">Authorised</dd>
            <dt>Payment</dt><dd className="text-ink">Awaiting external payment details</dd>
          </dl>
          <p className="mt-3">Once payment is made, provide the amount, payment date and bank reference so I can record it.</p>
        </div>
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Icon name="shield" className="h-4 w-4 shrink-0 text-accent" />
          Finance records external payments. The copilot does not initiate a bank transfer.
        </p>
      </div>
    </div>
  );
}
