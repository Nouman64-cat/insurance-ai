// Everything the Evaluation Studio says to the backend, plus the pure helpers its map uses (layout, links, health colours). No React in here, so the integration test can drive
// exactly the calls the pages make and compute the same layout the page draws.
import api from "@/app/services/api";

export type Health = "ok" | "warn" | "bad" | "unknown";
export interface StudioNode {
  id: string; kind: string; label: string; layer: number; order: number; health: { state: Health; reason: string }; stats: Record<string, any>; badge: string | null; active: boolean;
}
export interface StudioEdge { from: string; to: string; kind: string; weight: number; label: string }
export interface StudioGraph { as_of: string; nodes: StudioNode[]; edges: StudioEdge[]; health: Record<string, number>; layers: string[]; running: Record<string, any>[]; note: string }

export interface ObservedItem { name: string; executions: number; ran: number; passed: number; failed: number; scripted_executions: number; pass_rate: number | null; tools: string[]; specialists: string[]; models: string[] }
export interface Observed {
  agent: { executions: number; ran: number; passed: number; failed: number; blocked: number; infrastructure_errors: number; scripted_executions: number; pass_rate: number | null };
  specialists: ObservedItem[]; tools: ObservedItem[]; note: string;
}

export interface SearchItem { id: string; title: string; sub: string; dataset?: string; provider?: string; type?: string; when?: string }
export interface SearchGroup { kind: "dataset" | "case" | "benchmark" | "run" | "model" | "rule" | "finding"; label: string; items: SearchItem[] }
export interface SearchResult { q: string; groups: SearchGroup[]; total: number }

export interface ImpactCandidate { key: string; title: string; type: string; version: number | null; changed_at: string | null; dependent_cases: number; open_findings: number }
export interface ImpactDiff { path: string; before: unknown; after: unknown; change: "added" | "removed" | "changed" }
export interface ImpactDependent { dataset: string; version: string; case_id: string; category: string | null; severity: string | null;
  latest_real_result: { status: string; model: string | null; run_id: string; result_id: string; at: string; critical_failed: boolean } | null }
export interface ImpactSuggestion { id: string; kind: string; severity: string; state: string; summary: string; needs_expected: boolean; decision_note: string | null; decided_at: string | null; affected_cases: string[]; dataset: string | null }
export interface ImpactRun { run_id: string; model: string | null; version: string | null; started_at: string; pass_rate: number | null; ran: number; cost_usd: number; phase: "before" | "after" | null }
export interface ImpactCompare { model: string; before: ImpactRun; after: ImpactRun; pass_rate_delta: number | null; cost_per_execution_delta: number | null }
export interface Impact {
  item: { key: string; title: string; type: string; source: string | null }; changed_at: string | null; versions: { version: number; captured_at: string; captured_from: string; diff: ImpactDiff[] }[];
  dependents: ImpactDependent[]; suggested_updates: ImpactSuggestion[]; dataset_versions: Record<string, { version: string; published_at: string | null; case_count: number; after_change: boolean }[]>;
  regression: Record<string, { runs: ImpactRun[]; compare: ImpactCompare[] }>;
  stages: { change: boolean; affected_cases: number; suggestions: number; open_suggestions: number; new_versions: number; regression_pairs: number }; principle: string;
}

export const getGraph = async () => (await api.get<StudioGraph>("/eval/studio/graph")).data;
export const getObserved = async () => (await api.get<Observed>("/eval/studio/observed")).data;
export const searchStudio = async (q: string) => (await api.get<SearchResult>("/eval/studio/search", { params: { q } })).data;
export const listImpactCandidates = async () => (await api.get<{ items: ImpactCandidate[] }>("/eval/studio/impact")).data.items;
export const getImpact = async (key: string) => (await api.get<Impact>("/eval/studio/impact/item", { params: { key } })).data;

// ── modes, tools and links ──────────────────────────────────────────────────────────────────────────────────────────

export const STUDIO_ROOT = "/super-admin/evaluation";
export const MODES = [
  { id: "explore", label: "Explore", hint: "The ecosystem: what is connected to what, and how healthy each part is" },
  { id: "simulate", label: "Simulate", hint: "Estimate, start and watch an evaluation or a model benchmark" },
  { id: "investigate", label: "Investigate", hint: "Results, failures, traces, models side by side and what they cost" },
] as const;
export type ModeId = (typeof MODES)[number]["id"];
export const TOOLS = [
  { id: "datasets", label: "Golden datasets" }, { id: "drift", label: "Drift review" }, { id: "costs", label: "Costs & budgets" },
] as const;
export type ToolId = (typeof TOOLS)[number]["id"];
export const TEMPLATES_ROUTE = "/super-admin/templates";

/** The address of a place in the Studio. Only what differs from the default is written, so links stay short. */
export function studioHref(p: { mode?: ModeId; tool?: ToolId; node?: string; lens?: "map" | "impact"; impact?: string; sub?: string; bench?: string; runid?: string; dataset?: string; models?: string; extra?: Record<string, string> } = {}): string {
  const q = new URLSearchParams();
  if (p.mode && p.mode !== "explore") q.set("mode", p.mode);
  if (p.tool) q.set("tool", p.tool);
  if (p.node) q.set("node", p.node);
  if (p.lens && p.lens !== "map") q.set("lens", p.lens);
  if (p.impact) q.set("impact", p.impact);
  if (p.sub) q.set("sub", p.sub);
  if (p.bench) q.set("bench", p.bench);
  if (p.runid) q.set("runid", p.runid);
  if (p.dataset) q.set("dataset", p.dataset);
  if (p.models) q.set("models", p.models);
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  const s = q.toString();
  return s ? `${STUDIO_ROOT}?${s}` : STUDIO_ROOT;
}

// ── the map's layout and look ───────────────────────────────────────────────────────────────────────────────────────

export const NODE_W = 168, NODE_H = 66, COL_GAP = 62, ROW_GAP = 22, PAD = 28;
export interface Placed extends StudioNode { x: number; y: number }
export interface Layout { nodes: Placed[]; width: number; height: number; byId: Record<string, Placed> }

/** Columns are the layers, left to right; nodes of a layer are centred on the tallest layer. Same input, same picture: nothing is random, so a node never jumps between visits. */
export function layoutGraph(g: Pick<StudioGraph, "nodes">): Layout {
  const layers = Array.from(new Set(g.nodes.map((n) => n.layer))).sort((a, b) => a - b);
  const tallest = Math.max(1, ...layers.map((l) => g.nodes.filter((n) => n.layer === l).length));
  const colH = tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const placed: Placed[] = [];
  layers.forEach((layer, col) => {
    const col_nodes = g.nodes.filter((n) => n.layer === layer).sort((a, b) => a.order - b.order);
    const h = col_nodes.length * NODE_H + (col_nodes.length - 1) * ROW_GAP;
    col_nodes.forEach((n, i) => placed.push({ ...n, x: PAD + col * (NODE_W + COL_GAP), y: PAD + 26 + (colH - h) / 2 + i * (NODE_H + ROW_GAP) }));
  });
  const byId = Object.fromEntries(placed.map((n) => [n.id, n]));
  return { nodes: placed, byId, width: PAD * 2 + layers.length * NODE_W + (layers.length - 1) * COL_GAP, height: PAD * 2 + 26 + colH };
}

/** The curve of a link: from the right side of the left node to the left side of the right node, or the other way round when it goes backwards (the drift monitor watches things to its left). */
export function edgePath(a: Placed, b: Placed): string {
  const forward = b.x > a.x;
  const x1 = forward ? a.x + NODE_W : a.x, x2 = forward ? b.x : b.x + NODE_W, y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2;
  const dx = Math.max(24, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export const HEALTH_COLOR: Record<Health, { dot: string; ring: string; text: string; label: string }> = {
  ok: { dot: "#10b981", ring: "#a7f3d0", text: "text-emerald-700 dark:text-emerald-300", label: "healthy" },
  warn: { dot: "#f59e0b", ring: "#fde68a", text: "text-amber-700 dark:text-amber-300", label: "needs attention" },
  bad: { dot: "#ef4444", ring: "#fecaca", text: "text-red-700 dark:text-red-300", label: "failing" },
  unknown: { dot: "#94a3b8", ring: "#e2e8f0", text: "text-slate-500 dark:text-slate-400", label: "not enough evidence" },
};
export const KIND_ICON: Record<string, string> = {
  rules: "◇", dataset: "▤", harness: "⚙", drift: "≋", agent: "◉", specialists: "◎", tools: "✦", provider: "☁", deepeval: "✓", results: "▦", costs: "$",
};

/** The nodes and links connected to a node (one step each way): what lights up when it is hovered or selected. */
export function neighbourhood(g: Pick<StudioGraph, "edges">, id: string): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set<string>([id]);
  const edges = new Set<number>();
  g.edges.forEach((e, i) => { if (e.from === id || e.to === id) { nodes.add(e.from); nodes.add(e.to); edges.add(i); } });
  return { nodes, edges };
}

/** Which links carry the running evaluation: the datasets and the models it uses, through the harness, the agent and the judge to the results. Nothing is drawn as running unless a job is. */
export function activeLinks(g: StudioGraph): Set<number> {
  const out = new Set<number>();
  const running = g.running ?? [];
  if (running.length === 0) return out;
  const datasets = new Set(running.map((j) => `dataset:${j.dataset}`));
  const providers = new Set(running.flatMap((j) => ((j.models ?? []) as (string | null)[]).filter(Boolean).map((m) => `provider:${String(m).split("/")[0]}`)));
  g.edges.forEach((e, i) => {
    if ((e.kind === "feeds" && datasets.has(e.from)) || (e.kind === "exercises") || (e.kind === "uses" && providers.has(e.to)) || e.kind === "judged_by" || e.kind === "produces") out.add(i);
  });
  return out;
}

export const HEALTH_ORDER: Health[] = ["bad", "warn", "unknown", "ok"];
export const worstHealth = (nodes: StudioNode[]): Health => HEALTH_ORDER.find((h) => nodes.some((n) => n.health.state === h)) ?? "unknown";

export interface ResultRow { result_id: string; run_id: string; model: string | null; synthetic: boolean; dataset: string | null; version: string | null; case: string; stage: string | null; repetition: number; status: string;
  reason: string | null; critical_failed: boolean; latency_ms: number | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; cost_known: boolean; judge_cost_usd: number | null;
  has_trace: boolean; at: string | null; specialist: string | null; tools: string[] }
export interface ResultsPage { total: number; by_status: Record<string, number>; models: string[]; datasets: string[]; results: ResultRow[] }
export const listExecutions = async (p: { status?: string; model?: string; dataset?: string; case?: string; run_id?: string; include_synthetic?: boolean; limit?: number; offset?: number } = {}) =>
  (await api.get<ResultsPage>("/eval/studio/results", { params: Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "" && v !== false)) })).data;

/** The steps of a stored trace in the order they happened, for the replay: what the user said, what the agent answered, which tools it called and what came back. Per-step timings are not recorded,
 *  so only the whole turn's latency (when the trace has it) is attached; nothing is made up. */
export interface TraceStep { index: number; lane: "user" | "agent" | "tool" | "result" | "usage"; title: string; detail?: unknown; text?: string; ms?: number | null }
export function traceSteps(r: { trace: Record<string, unknown> | null; trace_summary?: { specialist?: string | null } | null; model: string | null; latency_ms: number | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; judge_cost_usd: number | null }): TraceStep[] {
  const t = (r.trace ?? {}) as { turns?: { index: number; message: string; reply?: string; latency_ms?: number | null }[]; messages?: { type: string; content?: string; name?: string; tool_calls?: { name: string; args?: unknown }[]; result?: unknown }[] };
  const steps: TraceStep[] = [];
  const push = (s: Omit<TraceStep, "index">) => steps.push({ ...s, index: steps.length });
  if (r.trace_summary?.specialist) push({ lane: "agent", title: `Routed to the ${r.trace_summary.specialist} specialist` });
  if (t.messages && t.messages.length > 0) {
    t.messages.forEach((m) => {
      const kind = (m.type ?? "").toLowerCase();
      if (kind === "human") push({ lane: "user", title: "User", text: m.content });
      else if (kind === "tool") push({ lane: "result", title: `Result from ${m.name ?? "a tool"}`, detail: m.result ?? m.content });
      else {
        if (m.content) push({ lane: "agent", title: "Agent", text: m.content });
        (m.tool_calls ?? []).forEach((c) => push({ lane: "tool", title: `Calls ${c.name}`, detail: c.args }));
      }
    });
  } else if (t.turns) {
    t.turns.forEach((u) => { push({ lane: "user", title: `User ${u.index}`, text: u.message }); if (u.reply) push({ lane: "agent", title: "Agent", text: u.reply, ms: u.latency_ms ?? null }); });
  }
  const turnMs = (t.turns ?? []).map((u) => u.latency_ms).filter((x): x is number => typeof x === "number");
  if (turnMs.length > 0) {
    let k = 0;
    steps.forEach((s) => { if (s.lane === "agent" && s.text !== undefined && s.ms === undefined && k < turnMs.length) s.ms = turnMs[k++]; });          // an agent ANSWER, not the routing note
  }
  push({ lane: "usage", title: `${r.model ?? "Model"} used ${r.input_tokens ?? "?"} tokens in, ${r.output_tokens ?? "?"} out`, detail: { latency_ms: r.latency_ms, cost_usd: r.cost_usd, judge_cost_usd: r.judge_cost_usd } });
  return steps;
}


// ── helping a first-time reader: what each part is, what each column means, and the one sentence that says how things stand ─────────────

/** What each kind of node IS, in plain words. These describe the architecture, not its state: every number and colour on the map still comes from the platform's records. */
export const KIND_HELP: Record<string, string> = {
  rules: "The business rules, plans, calculations, workflows and form templates the product runs on. When one changes, the Golden cases that depend on it may need updating.",
  dataset: "A Golden dataset: the approved test cases, with the outcome each should produce. Every evaluation is measured against one published version of it.",
  harness: "The evaluation harness. It runs the cases against the system in isolation, with scripted or real models, and records every result.",
  drift: "The change monitor. It notices when a rule, plan or template changes and queues what a person must review before any Golden case is touched.",
  agent: "The Individual Insurance chat agent: the system being tested.",
  specialists: "Specialist sub-agents the agent hands work to. Only the ones seen in recorded runs are shown.",
  tools: "The tools the agent called while it was tested. Only the ones seen in recorded runs are shown.",
  provider: "A model provider (GPT, Gemini or Claude) whose models answer in the tests. Scripted stand-ins test the machinery only and say nothing about quality.",
  deepeval: "The judge. DeepEval scores answers on correctness, faithfulness, relevance, safety and more, where a fixed rule cannot decide.",
  results: "Every recorded verdict (passed, failed, blocked, skipped), each with its trace.",
  costs: "What the evaluations cost, against the spending limits and the provider bills.",
};
export const LAYER_HELP: Record<string, string> = {
  "Business": "What the insurance product runs on",
  "Golden data": "The approved test cases",
  "Harness": "Runs the tests, watches for change",
  "System under test": "The agent being evaluated",
  "Models": "Who answers the questions",
  "Outcomes": "What came out, and what it cost",
};

/** The one sentence that says how things stand, from the nodes' own health: how many are failing or need attention, and the most urgent one with its reason. */
export function headline(g: Pick<StudioGraph, "nodes">): { state: Health; text: string; nodeId: string | null } {
  const by = (h: Health) => g.nodes.filter((n) => n.health.state === h);
  const bad = by("bad"), warn = by("warn"), ok = by("ok"), unknown = by("unknown");
  const top = bad[0] ?? warn[0] ?? null;
  if (g.nodes.length === 0) return { state: "unknown", text: "Nothing is recorded yet, so there is nothing to show.", nodeId: null };
  if (top) return { state: bad.length ? "bad" : "warn", nodeId: top.id, text: `${bad.length ? `${bad.length} part${bad.length === 1 ? " is" : "s are"} failing` : "Nothing is failing"}${warn.length ? `, ${warn.length} need${warn.length === 1 ? "s" : ""} attention` : ""}. Most urgent: ${top.label}: ${top.health.reason}.` };
  return { state: ok.length ? "ok" : "unknown", nodeId: null, text: ok.length ? `Everything with enough evidence is healthy${unknown.length ? `; ${unknown.length} part${unknown.length === 1 ? " has" : "s have"} not been run yet` : ""}.` : "Nothing has enough evidence to judge yet." };
}

/** Which node an arrow key moves to from `id`: left and right go to the nearest node in the neighbouring column (by height), up and down to the neighbour in the same column. Null at an edge. */
export function arrowTarget(nodes: Placed[], id: string, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string | null {
  const from = nodes.find((n) => n.id === id);
  if (!from) return null;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const col = nodes.filter((n) => n.layer === from.layer).sort((a, b) => a.y - b.y);
    const i = col.findIndex((n) => n.id === id);
    return col[i + (key === "ArrowDown" ? 1 : -1)]?.id ?? null;
  }
  const layers = Array.from(new Set(nodes.map((n) => n.layer))).sort((a, b) => a - b);
  const next = layers[layers.indexOf(from.layer) + (key === "ArrowRight" ? 1 : -1)];
  if (next === undefined) return null;
  return nodes.filter((n) => n.layer === next).sort((a, b) => Math.abs(a.y - from.y) - Math.abs(b.y - from.y))[0]?.id ?? null;
}

/** Two graphs that say the same thing (ignoring when they were read): a refresh that finds nothing new must not redraw the map. */
export function sameGraph(a: StudioGraph | null, b: StudioGraph | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify([a.nodes, a.edges, a.running, a.health]) === JSON.stringify([b.nodes, b.edges, b.running, b.health]);
}
