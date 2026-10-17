const nodes = [
  { id: "a", x: 150, y: 90, flagged: true },
  { id: "b", x: 70, y: 40, flagged: true },
  { id: "c", x: 235, y: 45, flagged: true },
  { id: "d", x: 60, y: 140, flagged: true },
  { id: "e", x: 250, y: 135, flagged: false },
  { id: "f", x: 150, y: 165, flagged: false },
];

const edges: [string, string, "area" | "occupation"][] = [
  ["a", "b", "area"],
  ["a", "c", "area"],
  ["a", "d", "area"],
  ["b", "d", "area"],
  ["b", "c", "occupation"],
  ["a", "e", "occupation"],
  ["a", "f", "occupation"],
];

const pos = (id: string) => nodes.find((n) => n.id === id)!;

export function FraudMock() {
  return (
    <div className="card mx-auto w-full max-w-[34rem] overflow-hidden shadow-float" role="img" aria-label="Example fraud relationship graph">
      <div className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-faint">Fraud graph</p>
          <p className="mt-1 text-sm font-semibold text-ink">Cluster of 4 related applicants</p>
        </div>
        <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-500/30">
          Fraud probability 0.78
        </span>
      </div>

      <svg viewBox="0 0 310 200" className="w-full px-3 py-2" aria-hidden="true">
        {edges.map(([from, to, kind]) => (
          <line
            key={`${from}-${to}`}
            x1={pos(from).x}
            y1={pos(from).y}
            x2={pos(to).x}
            y2={pos(to).y}
            stroke={kind === "area" ? "#2563eb" : "#9db4e0"}
            strokeWidth={kind === "area" ? 1.5 : 1}
            strokeDasharray={kind === "area" ? undefined : "4 3"}
          />
        ))}
        {nodes.map((n) => (
          <circle
            key={n.id}
            cx={n.x}
            cy={n.y}
            r={n.flagged ? 11 : 8}
            fill={n.flagged ? "#e11d48" : "#c7d7f3"}
            stroke="#ffffff"
            strokeWidth={2}
          />
        ))}
      </svg>

      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line bg-alt px-5 py-3 text-xs text-body">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-5 bg-accent" /> Same registration area
        </span>
        <span className="flex items-center gap-2">
          <span className="h-0 w-5 border-t border-dashed border-line-strong" /> Same occupation cluster
        </span>
      </div>
    </div>
  );
}
