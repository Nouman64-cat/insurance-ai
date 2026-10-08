import { Icon } from "@/components/ui/Icon";

export function CopilotMock() {
  return (
    <div className="card mx-auto w-full max-w-[34rem] overflow-hidden shadow-float" role="img" aria-label="Example copilot conversation">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-white">
          <Icon name="spark" className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold text-ink">Copilot</p>
      </div>

      <div className="space-y-3 px-5 py-4 text-sm">
        <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-brand px-3.5 py-2.5 text-white">
          Add Ahmed Khan, CNIC 3520112345671, software engineer, income 1.2M
        </div>

        <div className="max-w-[90%] rounded-xl rounded-bl-sm bg-chip px-3.5 py-2.5 text-ink">
          I formatted the CNIC as <span className="font-medium">35201-1234567-1</span>. Ready to add this customer.
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-body">
            <dt>Name</dt>
            <dd className="text-ink">Ahmed Khan</dd>
            <dt>Occupation</dt>
            <dd className="text-ink">Software Engineer</dd>
            <dt>Income</dt>
            <dd className="tabular-nums text-ink">PKR 1,200,000</dd>
          </dl>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">Confirm</span>
          <span className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold text-body">
            Cancel
          </span>
          <span className="ml-auto text-xs text-faint">add_customer · awaiting confirmation</span>
        </div>
      </div>
    </div>
  );
}
