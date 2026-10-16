import { Tilt } from "@/components/effects/Tilt";

const leads = [
  { name: "Ahmed Khan", initials: "AK", kind: "Individual", status: "Quoted", meta: "Term Life 20" },
  { name: "Sana Iqbal", initials: "SI", kind: "Family", status: "Proposed", meta: "Head + spouse + 2 nominees" },
  { name: "Bilal Traders (Pvt) Ltd", initials: "BT", kind: "Corporate", status: "Census", meta: "48 employees" },
  { name: "Zain Raza", initials: "ZR", kind: "Individual", status: "New", meta: "Awaiting e-application" },
];

// Status pills: dark text on a light tint, all AA
const statusTone: Record<string, string> = {
  Quoted: "bg-chip text-accent",
  Proposed: "bg-violet-50 text-brand-violet",
  Census: "bg-cyan-50 text-cyan-800",
  New: "bg-emerald-50 text-emerald-700",
};

const tabs = [
  { label: "Leads", active: true, d: "M4 6h16M4 12h16M4 18h10" },
  { label: "Apply", active: false, d: "M12 5v14M5 12h14" },
  { label: "Reports", active: false, d: "M6 20V10M12 20V4M18 20v-7" },
  { label: "Earnings", active: false, d: "M12 3v18M16 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8" },
];

// A phone running the agent app. Everything is sized in rem so it scales with the root font size on
// large displays (no CSS zoom). On white the frame gets a hairline ring, a soft brand shadow and a
// faint glow behind it so it doesn't read as a hard black cut-out.
export function AgentMock() {
  return (
    <div className="relative isolate mx-auto w-full max-w-[18rem] 2xl:max-w-[19.5rem]" role="img" aria-label="Example agent app lead board">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-x-4 -inset-y-8 -z-10 rounded-full bg-[radial-gradient(closest-side,rgb(37_99_235/0.16),rgb(109_40_217/0.07)_60%,transparent)] blur-xl"
      />
      <Tilt max={5} className="rounded-[3rem]">
        <div aria-hidden="true" className="relative rounded-[3rem] bg-gradient-to-b from-[#26215a] to-ink p-[0.625rem] shadow-surface ring-1 ring-ink/15">
          {/* Side buttons */}
          <span className="absolute -left-[3px] top-24 h-8 w-[3px] rounded-l bg-ink" />
          <span className="absolute -left-[3px] top-36 h-12 w-[3px] rounded-l bg-ink" />
          <span className="absolute -left-[3px] top-[13.5rem] h-12 w-[3px] rounded-l bg-ink" />
          <span className="absolute -right-[3px] top-32 h-16 w-[3px] rounded-r bg-ink" />

          {/* Screen */}
          <div className="relative flex aspect-[9/19.5] flex-col overflow-hidden rounded-[2.4rem] bg-alt ring-1 ring-white/10">
            {/* Status bar + dynamic island */}
            <div className="relative flex h-11 shrink-0 items-center justify-between px-6 text-[0.6875rem] font-semibold text-ink">
              <span>9:41</span>
              <span className="absolute left-1/2 top-2 h-6 w-[5.25rem] -translate-x-1/2 rounded-full bg-ink" />
              <span className="flex items-center gap-1">
                <svg className="h-2.5 w-[0.9375rem]" viewBox="0 0 15 10" fill="currentColor">
                  <rect x="0" y="7" width="2.5" height="3" rx="0.5" />
                  <rect x="4" y="5" width="2.5" height="5" rx="0.5" />
                  <rect x="8" y="2.5" width="2.5" height="7.5" rx="0.5" />
                  <rect x="12" y="0" width="2.5" height="10" rx="0.5" />
                </svg>
                <svg className="h-[0.6875rem] w-[1.375rem]" viewBox="0 0 22 11" fill="none">
                  <rect x="0.5" y="0.5" width="18" height="10" rx="2.5" stroke="currentColor" opacity="0.4" />
                  <rect x="2" y="2" width="13" height="7" rx="1.5" fill="currentColor" />
                  <rect x="19.5" y="3.5" width="1.5" height="4" rx="0.75" fill="currentColor" opacity="0.4" />
                </svg>
              </span>
            </div>

            {/* App header */}
            <div className="shrink-0 px-4 pb-3 pt-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[0.6875rem] text-muted">Good morning</p>
                  <p className="text-base font-semibold text-ink">Your leads</p>
                </div>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-gradient-strong text-[0.6875rem] font-semibold text-white">
                  AK
                </span>
              </div>
              <div className="mt-3 flex gap-1.5 text-[0.6875rem] font-medium">
                <span className="whitespace-nowrap rounded-full bg-brand-gradient-strong px-2.5 py-1 text-white">All 4</span>
                <span className="whitespace-nowrap rounded-full border border-line bg-card px-2.5 py-1 text-body">In progress</span>
                <span className="whitespace-nowrap rounded-full border border-line bg-card px-2.5 py-1 text-body">Proposed</span>
              </div>
            </div>

            {/* Lead list: white cards on the pale screen */}
            <ul className="min-h-0 flex-1 space-y-2 overflow-hidden px-3">
              {leads.map((l) => (
                <li key={l.name} className="flex items-center gap-2.5 rounded-xl border border-line bg-card px-2.5 py-2 shadow-card">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-chip text-[0.625rem] font-semibold text-accent">
                    {l.initials}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="truncate text-[0.8125rem] font-semibold text-ink">{l.name}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${statusTone[l.status]}`}>
                        {l.status}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[0.6875rem] text-muted">
                      {l.kind} · {l.meta}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            {/* Tokenised e-application link for the newest lead */}
            <div className="shrink-0 px-3 pb-3 pt-2">
              <div className="rounded-xl border border-dashed border-line-strong bg-card/70 px-3 py-2.5">
                <p className="text-[0.6875rem] font-semibold text-ink">E-application link</p>
                <p className="mt-0.5 text-[0.625rem] text-muted">Zain Raza · tokenised, for disclosure and declaration</p>
                <span className="mt-2 flex items-center justify-center rounded-lg bg-brand-gradient-strong py-1.5 text-[0.6875rem] font-semibold text-white">
                  Send link
                </span>
              </div>
            </div>

            {/* Tab bar */}
            <div className="shrink-0 border-t border-line bg-card px-3 pb-5 pt-2">
              <div className="flex justify-between">
                {tabs.map((t) => (
                  <span
                    key={t.label}
                    className={`flex flex-1 flex-col items-center gap-0.5 text-[0.5625rem] font-medium ${t.active ? "text-accent" : "text-muted"}`}
                  >
                    <svg
                      className="h-[1.125rem] w-[1.125rem]"
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
            <span className="absolute bottom-1.5 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-ink/80" />
          </div>
        </div>
      </Tilt>
    </div>
  );
}
