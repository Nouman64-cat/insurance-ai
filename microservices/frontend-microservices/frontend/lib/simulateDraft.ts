// Keeps the Simulate setup form when the person leaves the page and comes back. The form is kept as a draft in this browser (the address is NOT used: it grew into a long link), restored whenever the page opens,
// including from the sidebar and the back button. An older link that still carries `s_*` parameters is read once (they win over the draft) and then removed from the address. A draft is per browser: it is not shared with other people.
// Only what differs from an empty form is stored. Everything read back is checked against the known fields and types: neither the address nor the draft is trusted.
import type { BenchmarkForm } from "@/lib/evalBenchmarks";

export const DRAFT_KEY = "simulateDraft";
export const PREFIX = "s_";
type Key = keyof BenchmarkForm;
type Kind = "str" | "num" | "bool" | "list";
const FIELDS: Record<Exclude<Key, "dataset">, { p: string; k: Kind }> = {
  version: { p: "ver", k: "str" }, mode: { p: "md", k: "str" }, models: { p: "ms", k: "list" }, repetitions: { p: "rp", k: "num" }, judge: { p: "jd", k: "str" },
  metrics: { p: "mt", k: "list" }, stages: { p: "sg", k: "list" }, temperature: { p: "tp", k: "str" }, budget: { p: "bg", k: "str" }, stopOnCritical: { p: "sc", k: "bool" },
  allowSameJudge: { p: "sj", k: "bool" }, skills: { p: "sk", k: "str" }, maxLatencyMs: { p: "ml", k: "str" }, maxTokens: { p: "mk", k: "str" }, maxCostUsd: { p: "mc", k: "str" },
  gate: { p: "gt", k: "bool" }, gateMinPassPct: { p: "gp", k: "str" },
};
const ALLOWED: Partial<Record<Key, string[]>> = { mode: ["agent", "direct"], skills: ["default", "on", "off"] };

/** Every `s_*` parameter this module owns, so they can be removed before the current form is written. */
export const PARAM_NAMES = Object.values(FIELDS).map((f) => PREFIX + f.p);

export function formToParams(form: BenchmarkForm, defaults: BenchmarkForm): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, { p, k }] of Object.entries(FIELDS) as [Exclude<Key, "dataset">, { p: string; k: Kind }][]) {
    const v = form[key] as unknown, d = defaults[key] as unknown;
    if (k === "list") { const a = (v as string[]) ?? []; if (a.length && a.join() !== ((d as string[]) ?? []).join()) out[PREFIX + p] = a.join(","); }
    else if (k === "bool") { if (!!v !== !!d) out[PREFIX + p] = v ? "1" : "0"; }
    else if (v !== undefined && v !== null && String(v) !== String(d ?? "")) out[PREFIX + p] = String(v);
  }
  return out;
}

/** The fields found in these parameters (and nothing else), or null when there are none. Values of the wrong type or outside the allowed set are dropped. */
export function paramsToForm(get: (name: string) => string | null): Partial<BenchmarkForm> | null {
  const out: Record<string, unknown> = {};
  for (const [key, { p, k }] of Object.entries(FIELDS)) {
    const raw = get(PREFIX + p);
    if (raw === null) continue;
    if (k === "list") out[key] = raw.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
    else if (k === "bool") out[key] = raw === "1";
    else if (k === "num") { const n = Number(raw); if (Number.isInteger(n) && n >= 1 && n <= 100) out[key] = n; }
    else out[key] = raw.slice(0, 120);
    if (ALLOWED[key as Key] && out[key] !== undefined && !ALLOWED[key as Key]!.includes(out[key] as string)) delete out[key];
  }
  return Object.keys(out).length ? (out as Partial<BenchmarkForm>) : null;
}

export function parseDraft(raw: string | null): Partial<BenchmarkForm> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { dataset?: unknown; params?: Record<string, unknown> };
    if (!v || typeof v !== "object" || !v.params || typeof v.params !== "object") return null;
    const get = (n: string) => (typeof v.params![n] === "string" ? (v.params![n] as string) : null);
    const form = paramsToForm(get) ?? {};
    if (typeof v.dataset === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(v.dataset)) (form as Record<string, unknown>).dataset = v.dataset;
    return Object.keys(form).length ? form : null;
  } catch { return null; }
}

export function loadDraft(): Partial<BenchmarkForm> | null {
  try { return parseDraft(window.localStorage.getItem(DRAFT_KEY)); } catch { return null; }
}
/** An empty form removes the draft. False when the browser would not store it (private window): the page still works, it just cannot remember. */
export function saveDraft(form: BenchmarkForm, defaults: BenchmarkForm): boolean {
  try {
    const params = formToParams(form, defaults);
    if (!Object.keys(params).length) { window.localStorage.removeItem(DRAFT_KEY); return true; }
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ dataset: form.dataset, params }));
    return true;
  } catch { return false; }
}
