import { Tilt } from "@/components/effects/Tilt";
import { Icon } from "@/components/ui/Icon";

// The copilot proposing a data change and pausing for a yes/no. Sized in rem so it scales with
// the root font size on large displays (no CSS zoom).
export function CopilotMock() {
  return (
    <Tilt max={4} className="mx-auto w-full max-w-[34rem] rounded-2xl 2xl:max-w-[38rem]">
      <div className="glass overflow-hidden rounded-2xl shadow-surface" role="img" aria-label="Example copilot conversation">
        <div aria-hidden="true">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-alt/60 px-5 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient-strong text-white shadow-glow">
                <Icon name="spark" className="h-4 w-4" />
              </span>
              <div className="leading-tight">
                <p className="text-sm font-semibold text-ink">Copilot</p>
                <p className="text-[0.6875rem] text-muted">Asks before it changes data</p>
              </div>
            </div>
            <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-[0.6875rem] font-medium text-body">Demo data</span>
          </div>

          <div className="space-y-3 px-5 py-5 text-sm">
            <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-brand-gradient-strong px-3.5 py-2.5 leading-relaxed text-white">
              Add Ahmed Khan, CNIC 3520112345671, software engineer, income 1.2M
            </div>

            <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-line bg-card px-3.5 py-2.5 leading-relaxed text-ink">
              I formatted the CNIC as <span className="font-semibold">35201-1234567-1</span>. Ready to add this customer.
              <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line pt-2.5 text-xs">
                <dt className="text-muted">Name</dt>
                <dd className="text-ink">Ahmed Khan</dd>
                <dt className="text-muted">Occupation</dt>
                <dd className="text-ink">Software Engineer</dd>
                <dt className="text-muted">Income</dt>
                <dd className="tabular-nums text-ink">PKR 1,200,000</dd>
              </dl>
            </div>

            {/* The pending action: nothing is written until someone confirms */}
            <div className="rounded-xl border border-line bg-alt px-3.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs font-medium text-body">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span className="font-mono text-[0.6875rem] text-ink">add_customer</span>
                  awaiting confirmation
                </span>
                <span className="flex items-center gap-2">
                  <span className="rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs font-semibold text-body">Cancel</span>
                  <span className="flex items-center gap-1 rounded-lg bg-brand-gradient-strong px-3 py-1.5 text-xs font-semibold text-white">
                    <Icon name="check" className="h-3.5 w-3.5" />
                    Confirm
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="border-t border-line px-5 py-3">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3.5 py-2.5 text-sm text-faint">
              Ask the copilot…
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-chip text-accent">
                <Icon name="arrow" className="h-4 w-4" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </Tilt>
  );
}
