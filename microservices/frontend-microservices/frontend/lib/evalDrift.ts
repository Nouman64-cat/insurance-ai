// Everything the Drift Monitor page says to the backend, in one place (the integration test drives exactly these calls). No React in here.
import api from "@/app/services/api";

export type DriftState = "open" | "in_review" | "accepted" | "rejected" | "dismissed" | "cleared";
export type DriftAction = "start" | "accept" | "reject" | "dismiss" | "reopen";

export interface DriftItem {
  id: string; key: string; kind: string; severity: "critical" | "high" | "medium" | "low"; state: DriftState; summary: string; dataset: string | null;
  affected_cases: string[]; detail: Record<string, any>; registry_item: string | null; from_version: number | null; to_version: number | null;
  times_seen: number; opened_at: string; last_seen_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null;
  expected: Record<string, unknown> | null; expected_source: string | null; needs_expected: boolean;
}
export interface DriftHistory { at: string; from: string | null; to: string; by: string; note: string | null }
export interface DriftOverview {
  by_state: Record<string, number>; open: number; open_by_kind: Record<string, number>; open_by_severity: Record<string, number>;
  last_scan: { scan_id: string; at: string; dataset: string | null; version: string | null; counts: Record<string, number> } | null; oldest_open_since: string | null;
}
export interface ScanRow { scan_id: string; dataset: string | null; version: string | null; source: string; counts: Record<string, number>; created_at: string }
export interface ScanJob { id: string; state: string; dataset: string | null; version: string | null; error: string | null; created_at: string; finished_at: string | null }
export interface WatchedItem { key: string; type: string; title: string; source: string | null; status: string; version: number | null; versions: number; last_change: string | null; dependent_cases: number }
export interface WatchedVersion { version: number; captured_at: string; captured_from: string; fingerprint: string; diff: { path: string; before: unknown; after: unknown; change: string }[] }
export interface KnowledgeRow { template: string; title: string; published_version: number; assistant_knows: number | null; current: boolean }

export const KIND_LABEL: Record<string, string> = {
  rule_changed: "Rule changed", oracle_error: "Check could not run", unconfirmed: "Unconfirmed answer", unpinned: "No pinned check", review_due: "Review due",
  coverage_gap: "Coverage gap", proposal: "Suggested case", config_changed: "Product changed", behaviour_changed: "Behaviour changed", performance_changed: "Performance changed", input_shift: "Input shift",
};

export const getOverview = async () => (await api.get<DriftOverview>("/eval/drift/overview")).data;
export const listItems = async (p: { state?: string; kind?: string; severity?: string; q?: string } = {}) =>
  (await api.get<{ total: number; items: DriftItem[] }>("/eval/drift/items", { params: { limit: 300, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) } })).data;
export const getItem = async (id: string) => (await api.get<DriftItem & { history: DriftHistory[] }>(`/eval/drift/items/${id}`)).data;
export const decide = async (id: string, action: DriftAction, note?: string, expected?: Record<string, unknown>) =>
  (await api.post<DriftItem>(`/eval/drift/items/${id}/${action}`, { note: note || undefined, expected: expected || undefined })).data;
export const getDraft = async (id: string) => (await api.get<{ draft: Record<string, any>; next: string }>(`/eval/drift/items/${id}/draft`)).data;
export const listScans = async () => (await api.get<{ scans: ScanRow[]; jobs: ScanJob[] }>("/eval/drift/scans")).data;
export const scanNow = async (dataset?: string) => (await api.post<{ registry: { watched: number; changed: number }; job: { id: string } | null; note: string | null }>("/eval/drift/scans", dataset ? { dataset } : {})).data;
export const getRegistry = async () => (await api.get<{ items: WatchedItem[] }>("/eval/drift/registry")).data.items;
export const getVersions = async (key: string) => (await api.get<{ key: string; title: string; dependents: { dataset: string; version: string; case_id: string; severity: string }[]; versions: WatchedVersion[] }>("/eval/drift/registry/versions", { params: { key } })).data;
export const getKnowledge = async () => (await api.get<{ templates: KnowledgeRow[] }>("/eval/drift/knowledge-base")).data.templates;
export const syncKnowledge = async () => (await api.post<{ synced: Record<string, { status: string; reason?: string; error?: string }> }>("/eval/drift/knowledge-base/sync")).data;

/** The expected value a reviewer typed, as JSON. Anything that is not valid JSON is kept as plain text. */
export function parseExpected(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { text: t };
  }
}
