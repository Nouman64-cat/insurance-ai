const leads = [
  { name: "Ahmed Khan", kind: "Individual", status: "Quoted", meta: "Term Life 20" },
  { name: "Sana Iqbal", kind: "Family", status: "Proposed", meta: "Head + spouse + 2 nominees" },
  { name: "Bilal Traders (Pvt) Ltd", kind: "Corporate", status: "Census", meta: "48 employees" },
  { name: "Zain Raza", kind: "Individual", status: "New", meta: "Awaiting e-application" },
];

export function AgentMock() {
  return (
    <div className="mx-auto w-full max-w-[300px]" role="img" aria-label="Example agent app lead board">
      <div className="rounded-[2rem] border-[6px] border-ink bg-card shadow-float">
        <div className="px-4 pb-2 pt-5">
          <p className="text-xs text-faint">Good morning</p>
          <p className="text-base font-semibold text-ink">Your leads</p>
          <div className="mt-3 flex gap-1.5 text-xs font-medium">
            <span className="whitespace-nowrap rounded-full bg-brand px-2.5 py-1 text-white">All 4</span>
            <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-body">In progress</span>
            <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-body">Proposed</span>
          </div>
        </div>
        <ul className="divide-y divide-line px-4 pb-4">
          {leads.map((l) => (
            <li key={l.name} className="py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-ink">{l.name}</p>
                <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-body">
                  {l.status}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {l.kind} · {l.meta}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
