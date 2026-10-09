const leads = [
  { name: "Ahmed Khan", kind: "Individual", status: "Quoted", meta: "Term Life 20" },
  { name: "Sana Iqbal", kind: "Family", status: "Proposed", meta: "Head + spouse + 2 nominees" },
  { name: "Bilal Traders (Pvt) Ltd", kind: "Corporate", status: "Census", meta: "48 employees" },
  { name: "Zain Raza", kind: "Individual", status: "New", meta: "Awaiting e-application" },
];

const tabs = [
  { label: "Leads", active: true, d: "M4 6h16M4 12h16M4 18h10" },
  { label: "Apply", active: false, d: "M12 5v14M5 12h14" },
  { label: "Reports", active: false, d: "M6 20V10M12 20V4M18 20v-7" },
  { label: "Earnings", active: false, d: "M12 3v18M16 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8" },
];

export function AgentMock() {
  return (
    <div className="mx-auto w-full max-w-[290px]" role="img" aria-label="Example agent app lead board">
      {/* Phone body */}
      <div className="relative rounded-[3rem] bg-ink p-[10px] shadow-float ring-1 ring-black/10">
        {/* Side buttons */}
        <span aria-hidden className="absolute -left-[3px] top-24 h-8 w-[3px] rounded-l bg-ink" />
        <span aria-hidden className="absolute -left-[3px] top-36 h-12 w-[3px] rounded-l bg-ink" />
        <span aria-hidden className="absolute -left-[3px] top-[13.5rem] h-12 w-[3px] rounded-l bg-ink" />
        <span aria-hidden className="absolute -right-[3px] top-32 h-16 w-[3px] rounded-r bg-ink" />

        {/* Screen */}
        <div className="relative flex aspect-[9/19.5] flex-col overflow-hidden rounded-[2.35rem] bg-card">
          {/* Status bar + dynamic island */}
          <div className="relative flex h-11 shrink-0 items-center justify-between px-6 text-[11px] font-semibold text-ink">
            <span>9:41</span>
            <span aria-hidden className="absolute left-1/2 top-2 h-6 w-[84px] -translate-x-1/2 rounded-full bg-ink" />
            <span aria-hidden className="flex items-center gap-1">
              <svg width="15" height="10" viewBox="0 0 15 10" fill="currentColor">
                <rect x="0" y="7" width="2.5" height="3" rx="0.5" />
                <rect x="4" y="5" width="2.5" height="5" rx="0.5" />
                <rect x="8" y="2.5" width="2.5" height="7.5" rx="0.5" />
                <rect x="12" y="0" width="2.5" height="10" rx="0.5" />
              </svg>
              <svg width="22" height="11" viewBox="0 0 22 11" fill="none">
                <rect x="0.5" y="0.5" width="18" height="10" rx="2.5" stroke="currentColor" opacity="0.4" />
                <rect x="2" y="2" width="13" height="7" rx="1.5" fill="currentColor" />
                <rect x="19.5" y="3.5" width="1.5" height="4" rx="0.75" fill="currentColor" opacity="0.4" />
              </svg>
            </span>
          </div>

          {/* App header */}
          <div className="shrink-0 px-4 pb-2 pt-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] text-faint">Good morning</p>
                <p className="text-base font-semibold text-ink">Your leads</p>
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white">
                AK
              </span>
            </div>
            <div className="mt-3 flex gap-1.5 text-[11px] font-medium">
              <span className="whitespace-nowrap rounded-full bg-brand px-2.5 py-1 text-white">All 4</span>
              <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-body">In progress</span>
              <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-body">Proposed</span>
            </div>
          </div>

          {/* Lead list */}
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-hidden px-4">
            {leads.map((l) => (
              <li key={l.name} className="py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-[13px] font-semibold text-ink">{l.name}</p>
                  <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 text-[10px] font-medium text-body">
                    {l.status}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted">
                  {l.kind} · {l.meta}
                </p>
              </li>
            ))}
          </ul>

          {/* Tab bar */}
          <div className="shrink-0 border-t border-line bg-card px-3 pb-5 pt-2">
            <div className="flex justify-between">
              {tabs.map((t) => (
                <span
                  key={t.label}
                  className={`flex flex-1 flex-col items-center gap-0.5 text-[9px] font-medium ${
                    t.active ? "text-brand" : "text-faint"
                  }`}
                >
                  <svg
                    aria-hidden
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={t.d} />
                  </svg>
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {/* Home indicator */}
          <span
            aria-hidden
            className="absolute bottom-1.5 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-ink/80"
          />
        </div>
      </div>
    </div>
  );
}
