// What the judge said about a benchmark, worked out from the stored summary and shown the same way every time. There are three honest states:
//   none      no judge was used: only the rule-based checks (tool calls, state, exact text) were applied, and judged qualities such as correctness or safety were not measured
//   unscored  a judge was named but produced no scores (most often its provider has no key here, or the evaluation environment does not allow it)
//   scored    the judge scored answers: a mean per metric per model, how many answers met the threshold, and how far the judge itself can be trusted (its calibration)
// Nothing is filled in: a model the judge did not score has no figure, and a scripted judge or a judge that is also a compared model is called out.
import type { BenchmarkDetail } from "@/lib/evalBenchmarks";

export type JudgeState = "none" | "unscored" | "scored";
export type Tone = "good" | "warn" | "bad" | "unknown";
export interface JudgeCell { mean: number | null; n: number; met: number; best: boolean }
export interface JudgeRow { metric: string; label: string; cells: Record<string, JudgeCell> }
export interface JudgeModel { label: string; synthetic: boolean; scored: boolean; answers: number; overall: number | null; costUsd: number | null }
export interface JudgeCalibration { status: string; title: string; detail: string; tone: Tone; agreement: number | null }
export type VerdictKind = "winner" | "tie" | "unreliable" | "insufficient";
export interface JudgeVerdict { kind: VerdictKind; title: string; detail: string; model: string | null }
export interface JudgeView { verdict: JudgeVerdict | null; state: JudgeState; judge: string | null; provider: string | null; scriptedJudge: boolean; calibration: JudgeCalibration | null; rows: JudgeRow[]; models: JudgeModel[]; notes: string[]; totalCostUsd: number | null }

const CAL: Record<string, { title: string; tone: Tone; detail: string }> = {
  trusted: { title: "Trusted judge", tone: "good", detail: "It scored a set of answers of known quality the right way: good ones high, bad ones low." },
  partial: { title: "Partly trusted judge", tone: "warn", detail: "It agreed with the known answers on most, but not all, of the calibration set." },
  not_trusted: { title: "Judge not trusted", tone: "bad", detail: "It disagreed with answers of known quality too often. Treat its scores as unreliable." },
  not_calibrated: { title: "Judge not calibrated", tone: "unknown", detail: "It has not been checked against answers of known quality, so how far to trust its scores is not known." },
};
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function judgeView(b: Pick<BenchmarkDetail, "judge_model" | "summary">): JudgeView {
  const labels = Object.keys(b.summary.models);
  const judge = b.summary.judge?.model ?? b.judge_model ?? null;
  const metrics = Array.from(new Set(labels.flatMap((l) => Object.keys(b.summary.models[l].quality ?? {})))).sort();
  const scoredAny = labels.some((l) => Object.values(b.summary.models[l].quality ?? {}).some((q) => q.n > 0 && q.mean !== null));
  const state: JudgeState = !judge ? "none" : scoredAny ? "scored" : "unscored";
  const fair = labels.filter((l) => b.summary.models[l].status === "measured" && !b.summary.models[l].synthetic);
  const rows: JudgeRow[] = metrics.map((metric) => {
    const cells: Record<string, JudgeCell> = {};
    for (const l of labels) { const q = b.summary.models[l].quality?.[metric]; cells[l] = { mean: q && q.n > 0 ? num(q.mean) : null, n: q?.n ?? 0, met: q?.met ?? 0, best: false }; }
    const vals = fair.map((l) => cells[l].mean).filter((v): v is number => v !== null);
    if (vals.length >= 2 && !vals.every((v) => v === vals[0])) { const top = Math.max(...vals); fair.forEach((l) => { if (cells[l].mean === top) cells[l].best = true; }); }
    return { metric, label: metric.replace(/_/g, " "), cells };
  });
  const models: JudgeModel[] = labels.map((l) => {
    const m = b.summary.models[l], means = rows.map((r) => r.cells[l].mean).filter((v): v is number => v !== null);
    return { label: l, synthetic: m.synthetic, scored: means.length > 0, answers: Math.max(0, ...rows.map((r) => r.cells[l].n)), overall: means.length ? means.reduce((a, c) => a + c, 0) / means.length : null, costUsd: num(m.cost?.judge_usd) };
  });
  const cal = b.summary.judge?.calibration as ({ status?: string; agreement?: number | null; trust_threshold?: number } | null | undefined);
  const known = cal?.status ? CAL[cal.status] : undefined;
  const calibration: JudgeCalibration | null = judge ? (known ? { status: cal!.status!, ...known, agreement: num(cal!.agreement) } : { status: "not_calibrated", ...CAL.not_calibrated, agreement: null }) : null;
  const scriptedJudge = !!judge && judge.startsWith("mock/");
  const notes: string[] = [];
  if (state === "unscored") notes.push("The judge was named but produced no scores. Most often its provider has no key in the evaluation environment, or the environment does not allow that provider. Choose another judge (for example openai/gpt-4o, which is not one of the compared models) and run again.");
  if (judge && labels.includes(judge)) notes.push("The judge is also one of the compared models. A model tends to favour its own answers, so treat the ranking with care.");
  if (scriptedJudge) notes.push("This judge is a scripted stand-in: it accepts any answer that is not empty. Its scores test the machinery, not the quality of the answers.");
  const costs = models.map((m) => m.costUsd).filter((v): v is number => v !== null);
  return { verdict: state === "scored" ? verdictOf(models, rows, scriptedJudge) : null, state, judge, provider: judge ? judge.split("/")[0] : null, scriptedJudge, calibration, rows, models, notes, totalCostUsd: costs.length ? costs.reduce((a, c) => a + c, 0) : null };
}

const shortName = (m: string) => m.split("/")[1] ?? m;
/** Who came out ahead on the judge's scores, in a sentence: only among real models the judge scored, never from a scripted judge, and "no winner" when the averages are level. */
function verdictOf(models: JudgeModel[], rows: JudgeRow[], scriptedJudge: boolean): JudgeVerdict {
  if (scriptedJudge) return { kind: "unreliable", model: null, title: "No winner can be named from this judge", detail: "It is a scripted stand-in that gives the same score to any answer that is not empty, so identical or high scores here mean nothing. Run again with a real judge to rank the models." };
  const fair = models.filter((m) => !m.synthetic && m.scored && m.overall !== null).sort((a, b) => (b.overall as number) - (a.overall as number));
  if (fair.length < 2) return { kind: "insufficient", model: null, title: "Nothing to compare yet", detail: "Fewer than two real models were scored by the judge, so there is no winner to name." };
  const [top, second] = fair, gap = (top.overall as number) - (second.overall as number);
  const answers = Math.min(...fair.map((m) => m.answers));
  const few = answers < 10 ? ` It rests on only ${answers} judged answer${answers === 1 ? "" : "s"} per metric: treat it as a hint, not proof.` : "";
  if (gap < 0.005) return { kind: "tie", model: null, title: "No winner: the models are level on the judge's scores", detail: `Their averages are the same (${(top.overall as number).toFixed(2)}).${few}` };
  const wins = rows.filter((r) => { const a = r.cells[top.label].mean, b = r.cells[second.label].mean; return a !== null && b !== null && a > b; }).length;
  return { kind: "winner", model: top.label, title: `${shortName(top.label)} scored highest`, detail: `Average ${(top.overall as number).toFixed(2)} against ${(second.overall as number).toFixed(2)} for ${shortName(second.label)}, ahead on ${wins} of ${rows.length} metrics.${few}` };
}
