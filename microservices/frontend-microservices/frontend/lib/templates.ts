// Everything the Templates tab says to the backend, in one place (the page and its integration test import only this module for data).
import api from "@/app/services/api";
import { withReasons } from "@/lib/evalBenchmarks";

export const FIELD_TYPES = ["text", "textarea", "number", "date", "phone", "checkbox", "yes_no", "select", "checklist", "table", "statement", "display"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const TYPE_LABEL: Record<FieldType, string> = {
  text: "Short text", textarea: "Long text", number: "Number", date: "Date", phone: "Phone number", checkbox: "Tick box", yes_no: "Yes / No", select: "Choose one", checklist: "Checklist with details",
  table: "Table (repeated rows)", statement: "Statement to confirm", display: "Filled in by the system",
};
/** What can be ADDED in the editor: the types the forms can draw today. (A checklist, a table and a statement can still be edited where they already exist.) */
export const ADDABLE: FieldType[] = ["text", "textarea", "number", "date", "phone", "checkbox", "yes_no", "select"];

export interface Option { id: string; label: string; value?: string }
export interface Binding { store: "profile" | "details"; key?: string }
export interface Column { id: string; label: string; type: FieldType; options?: Option[] }
export interface Field {
  id: string; label: string; type: FieldType; required?: boolean; help?: string; locked?: boolean;
  options?: Option[]; columns?: Column[]; detail_fields?: Column[]; show_if?: { field: string; equals: string };
  binding?: Binding; placeholder?: string; max_length?: number;
}
export interface Section { id: string; title: string; description?: string | null; stores_in?: string | null; fields: Field[] }
export interface TemplateContent { title: string; intro?: string; sections: Section[]; disclaimers?: string[] }

export interface TemplateSummary {
  key: string; kind: "lead" | "proposal" | "illustration"; group_key: string | null; title: string; description: string | null; status: string;
  published_version: number | null; published_at: string | null; has_draft: boolean; draft_updated_at: string | null; fields: number;
}
export interface VersionInfo { version: number; state: "draft" | "published" | "superseded"; change_note: string | null; created_by: string | null; created_at: string; updated_at: string; published_by: string | null; published_at: string | null; sha256: string }
export interface TemplateDetail {
  key: string; kind: string; group_key: string | null; title: string; description: string | null;
  published: (VersionInfo & { content: TemplateContent }) | null; draft: (VersionInfo & { content: TemplateContent }) | null; versions: VersionInfo[]; draft_problems: string[];
}
export interface Change { change: "added" | "removed" | "edited" | "moved"; what: string; fields?: string[]; before?: unknown; after?: unknown }

export const listTemplates = async () => (await api.get<TemplateSummary[]>("/admin/doc-templates")).data;
export const getTemplate = async (key: string) => (await api.get<TemplateDetail>(`/admin/doc-templates/${key}`)).data;
export const saveDraft = async (key: string, content: TemplateContent, note?: string) => {
  try {
    return (await api.put<{ draft: VersionInfo; publish_problems: string[]; changes: Change[] }>(`/admin/doc-templates/${key}/draft`, { content, change_note: note ?? null })).data;
  } catch (e) { throw withReasons(e); }
};
export const discardDraft = async (key: string) => (await api.delete<{ discarded: boolean }>(`/admin/doc-templates/${key}/draft`)).data;
export const publishTemplate = async (key: string, note: string) => {
  try {
    return (await api.post<{ published: VersionInfo; changes: Change[]; registry: { recorded: boolean; status?: string; error?: string } }>(`/admin/doc-templates/${key}/publish`, { change_note: note })).data;
  } catch (e) { throw withReasons(e); }
};
export const getVersion = async (key: string, n: number) => (await api.get<VersionInfo & { content: TemplateContent }>(`/admin/doc-templates/${key}/versions/${n}`)).data;
export const getDiff = async (key: string, from: string | number, to: string | number = "draft") =>
  (await api.get<{ from: number; to: number; changes: Change[] }>(`/admin/doc-templates/${key}/diff`, { params: { from, to } })).data;
export const restoreVersion = async (key: string, n: number) => (await api.post<{ draft: VersionInfo }>(`/admin/doc-templates/${key}/restore/${n}`)).data;
export const getPublished = async (key: string) => (await api.get<{ key: string; version: number; content: TemplateContent }>(`/doc-templates/${key}`)).data;

// ── editing helpers (pure) ──────────────────────────────────────────────────────────────────────────────────────────────

export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
export const allFieldIds = (c: TemplateContent) => c.sections.flatMap((s) => s.fields.map((f) => f.id));

/** An id for a new field or section: lowercase words joined by underscores, made unique among `taken`. */
export function slugFor(label: string, taken: string[], fallback = "field"): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback).replace(/^[0-9]/, "f_$&").slice(0, 50);
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}

export function newField(type: FieldType, label: string, taken: string[]): Field {
  const f: Field = { id: slugFor(label, taken), label, type, required: false, binding: { store: "details" } };
  if (type === "select") f.options = [{ id: "option_1", label: "Option 1" }, { id: "option_2", label: "Option 2" }];
  if (type === "table") f.columns = [{ id: "column_1", label: "Column 1", type: "text" }];
  if (type === "checklist") { f.options = [{ id: "item_1", label: "Item 1" }]; f.detail_fields = []; }
  return f;
}

export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** Where a field is saved, in words a person can read. */
export const storedAs = (f: Field): string => (f.binding?.store === "profile" ? `customer profile · ${f.binding.key ?? f.id}` : "kept with the customer · custom." + f.id);

export const describeChange = (c: Change): string => {
  const [kind, id] = c.what.split(":");
  const noun = kind === "field" ? "Field" : kind === "section" ? "Section" : "The template's";
  const target = id ?? c.what;
  if (c.change === "added") return `${noun} '${target}' was added`;
  if (c.change === "removed") return `${noun} '${target}' was removed`;
  if (c.change === "moved") return `${noun} '${target}' was moved`;
  return `${noun} '${target}' was edited${c.fields?.length ? ` (${c.fields.filter((f) => f !== "position").join(", ")})` : ""}`;
};
