"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";

// ── Types ────────────────────────────────────────────────────────────────────
type CaseStatus = "draft" | "in_review" | "approved" | "rejected" | "archived";

interface VersionInfo {
  version: string;
  state: string;
  case_count: number;
  fixture_count: number;
  parent_version: string | null;
  change_summary: string | null;
  approval: { approved_by?: string; approved_at?: string; note?: string | null };
  snapshot_sha256: string;
  published_at: string | null;
}

interface DatasetSummary {
  slug: string;
  name: string;
  workflow: string;
  turn_mode: string;
  status: string;
  latest_version: string | null;
  by_status: Partial<Record<CaseStatus, number>>;
  unpublished_changes: number;
}

interface DatasetDetail extends DatasetSummary {
  description: string | null;
  suggested_version: string;
  facets: { category: string[]; scenario_type: string[] };
  versions: VersionInfo[];
}

interface CaseRow {
  case_key: string;
  title: string | null;
  tier: string;
  status: CaseStatus;
  revision: number;
  category: string | null;
  scenario_type: string | null;
  difficulty: string | null;
  severity: string | null;
  last_published_version: string | null;
  changed_since_publish: boolean;
}

interface CaseDetail {
  case_key: string;
  tier: string;
  status: CaseStatus;
  revision: number;
  content: Record<string, unknown>;
  validation_errors: { loc?: unknown; msg?: string }[] | null;
  approval: { approved_by: string | null; approved_at: string | null; note: string | null };
  changed_since_publish: boolean;
  published_in: { version: string; revision: number; verification: string | null; published_at: string | null }[];
}

interface DiffResult {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  changed: { case_key: string; fields: string[] }[];
  unchanged: number;
}

interface Fixture {
  fixture_key: string;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  description: string | null;
}

interface CaseResult {
  case_key: string;
  tier: string;
  status: CaseStatus;
  revision: number;
  validation_errors: { loc?: unknown; msg?: string }[] | null;
  rejects: { case_id?: string; errors?: { loc?: unknown; msg?: string }[] }[];
}

type Notice = { kind: "ok" | "error"; text: string } | null;

const STATUS_STYLE: Record<CaseStatus, string> = {
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  in_review: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-600 border-red-200",
  archived: "bg-slate-50 text-slate-400 border-slate-200",
};

const STATUS_LABEL: Record<CaseStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Retired",
};

const PAGE_SIZE = 25;

const NEW_CASE_TEMPLATE = {
  case_id: "IND-XXX-001",
  title: "",
  workflow: "individual-insurance",
  stage: "",
  category: "",
  scenario_type: "positive",
  difficulty: "medium",
  severity: "medium",
  input: { messages: [{ role: "user", content: "" }] },
  expected: { summary: "", outcome: "" },
  source: { kind: "manual", reference: "", verification: "pending_domain_approval" },
};

// ── Small helpers ────────────────────────────────────────────────────────────
const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");

const errText = (e: any, fallback: string) => (e && e.message ? String(e.message) : fallback);

const formatErrors = (errs: { loc?: unknown; msg?: string }[] | null | undefined) =>
  (errs ?? []).map((e) => `${Array.isArray(e.loc) ? e.loc.join(".") : String(e.loc ?? "")}: ${e.msg ?? ""}`);

function StatusBadge({ status }: { status: CaseStatus }) {
  return (
    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[status]}`}>
      {tx(STATUS_LABEL[status])}
    </span>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label={tx("Close")}>
            ×
          </button>
        </div>
        <div className="p-5 space-y-3">{children}</div>
      </div>
    </div>
  );
}

const inputCls = "w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 bg-white";
const btnPrimary = "px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-all";
const btnGhost = "px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function ErrorBox({ text }: { text: string }) {
  return <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600 whitespace-pre-wrap">{text}</div>;
}

// ── New dataset ──────────────────────────────────────────────────────────────
function NewDatasetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [workflow, setWorkflow] = useState("individual-insurance");
  const [turnMode, setTurnMode] = useState("single_turn");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.post("/eval/datasets", { slug: slug.trim(), name: name.trim(), workflow: workflow.trim(), turn_mode: turnMode, description: description.trim() || null });
      onCreated(slug.trim());
    } catch (e: any) {
      setErr(errText(e, "Could not create the dataset."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={tx("New dataset")} onClose={onClose}>
      <Field label={tx("Slug (lower-case letters, digits, hyphens)")}>
        <input className={inputCls} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="individual-single-turn" />
      </Field>
      <Field label={tx("Name")}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={tx("Workflow")}>
          <input className={inputCls} value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
        </Field>
        <Field label={tx("Turn mode")}>
          <select className={inputCls} value={turnMode} onChange={(e) => setTurnMode(e.target.value)}>
            <option value="single_turn">{tx("Single turn")}</option>
            <option value="multi_turn">{tx("Multi turn")}</option>
          </select>
        </Field>
      </div>
      <Field label={tx("Description (optional)")}>
        <textarea className={inputCls} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {err && <ErrorBox text={err} />}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btnGhost} onClick={onClose}>{tx("Cancel")}</button>
        <button type="button" className={btnPrimary} disabled={busy || !slug.trim() || !name.trim()} onClick={create}>
          {busy ? tx("Creating…") : tx("Create")}
        </button>
      </div>
    </Modal>
  );
}

// ── Upload cases ─────────────────────────────────────────────────────────────
function UploadCasesModal({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: (summary: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState("import");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rejects, setRejects] = useState<string[]>([]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setErr("");
    setRejects([]);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("source_type", sourceType);
      form.append("promote", "true");
      const { data } = await api.post(`/eval/datasets/${slug}/ingest`, form, { headers: { "Content-Type": "multipart/form-data" } });
      const problems: string[] = [
        ...(data.rejects ?? []).map((r: any) => `position ${r.position}: ${r.error}`),
        ...(data.promoted?.rejects ?? []).map((r: any) => `${r.case_id}: ${r.errors?.[0]?.loc ?? ""} ${r.errors?.[0]?.msg ?? ""}`),
      ];
      const summary =
        `${data.created} new, ${data.updated} updated, ${data.rejected} unreadable; ` +
        `${data.promoted?.accepted ?? 0} validated into Silver, ${data.promoted?.rejected ?? 0} failed validation.`;
      if (problems.length) {
        setRejects(problems);
        setErr(summary);
        onDone(summary);
      } else {
        onDone(summary);
        onClose();
      }
    } catch (e: any) {
      setErr(errText(e, "Upload failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={tx("Upload cases")} onClose={onClose}>
      <p className="text-xs text-slate-500">
        {tx("JSONL, JSON or CSV. The file is kept as received, then validated. A case that already exists becomes a new revision and must be approved again.")}
      </p>
      <Field label={tx("File")}>
        <input type="file" accept=".jsonl,.json,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
      </Field>
      <Field label={tx("Source")}>
        <select className={inputCls} value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <option value="import">{tx("Import")}</option>
          <option value="manual">{tx("Manual")}</option>
          <option value="synthetic">{tx("Synthetic")}</option>
          <option value="trace">{tx("Trace")}</option>
        </select>
      </Field>
      {err && <ErrorBox text={err} />}
      {rejects.length > 0 && (
        <ul className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-0.5 max-h-40 overflow-y-auto">
          {rejects.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btnGhost} onClick={onClose}>{tx("Close")}</button>
        <button type="button" className={btnPrimary} disabled={busy || !file} onClick={upload}>
          {busy ? tx("Uploading…") : tx("Upload")}
        </button>
      </div>
    </Modal>
  );
}

// ── Add case ─────────────────────────────────────────────────────────────────
function AddCaseModal({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState(JSON.stringify(NEW_CASE_TEMPLATE, null, 2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const add = async () => {
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch (e: any) {
      setErr(tx("This is not valid JSON: ") + e.message);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const { data } = await api.post<CaseResult>(`/eval/datasets/${slug}/cases`, { content });
      const problems = [...formatErrors(data.validation_errors), ...data.rejects.flatMap((r) => formatErrors(r.errors))];
      if (data.tier !== "silver" || problems.length) {
        setErr(tx("The case was saved but does not validate yet:") + "\n" + problems.join("\n"));
        onDone(`${data.case_key} saved as a draft that needs fixing.`);
      } else {
        onDone(`${data.case_key} added as a draft. Review and approve it, then publish.`);
        onClose();
      }
    } catch (e: any) {
      setErr(errText(e, "Could not add the case."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={tx("Add a case")} onClose={onClose} wide>
      <p className="text-xs text-slate-500">
        {tx("Fill in the case as JSON. It is validated against the golden case schema when you add it.")}
      </p>
      <textarea
        className={`${inputCls} font-mono text-xs`}
        rows={22}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {err && <ErrorBox text={err} />}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btnGhost} onClick={onClose}>{tx("Close")}</button>
        <button type="button" className={btnPrimary} disabled={busy} onClick={add}>
          {busy ? tx("Adding…") : tx("Add case")}
        </button>
      </div>
    </Modal>
  );
}

// ── Case drawer ──────────────────────────────────────────────────────────────
function CaseDrawer({ slug, row, onClose, onChanged }: { slug: string; row: CaseRow; onClose: () => void; onChanged: (text: string) => void }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(async () => {
    setLoadErr("");
    try {
      const { data } = await api.get<CaseDetail>(`/eval/datasets/${slug}/cases/${row.case_key}`, { params: { tier: row.tier } });
      setDetail(data);
      const pretty = JSON.stringify(data.content, null, 2);
      setText(pretty);
      setOriginal(pretty);
    } catch (e: any) {
      setLoadErr(errText(e, "Could not load the case."));
    }
  }, [slug, row.case_key, row.tier]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = text !== original;

  const save = async () => {
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch (e: any) {
      setErr(tx("This is not valid JSON: ") + e.message);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const { data } = await api.put<CaseResult>(`/eval/datasets/${slug}/cases/${row.case_key}`, { content });
      const problems = [...formatErrors(data.validation_errors), ...data.rejects.flatMap((r) => formatErrors(r.errors))];
      onChanged(
        data.tier === "silver"
          ? `${data.case_key} saved as revision ${data.revision}. It is a draft again: approve it, then publish a new version.`
          : `${data.case_key} saved as revision ${data.revision} but does not validate yet.`,
      );
      if (problems.length) setErr(tx("Saved, but it does not validate:") + "\n" + problems.join("\n"));
      await load();
    } catch (e: any) {
      setErr(errText(e, "Could not save the case."));
    } finally {
      setBusy(false);
    }
  };

  const act = async (kind: "approve" | "review" | "reject" | "retire" | "restore") => {
    setBusy(true);
    setErr("");
    try {
      if (kind === "approve") {
        await api.post(`/eval/datasets/${slug}/approve`, { case_keys: [row.case_key], note: note.trim() || null });
      } else {
        const status = { review: "in_review", reject: "rejected", retire: "archived", restore: "draft" }[kind];
        await api.post(`/eval/datasets/${slug}/cases/${row.case_key}/status`, { status, note: note.trim() || null });
      }
      onChanged(`${row.case_key}: done.`);
      setNote("");
      await load();
    } catch (e: any) {
      setErr(errText(e, "That change was refused."));
    } finally {
      setBusy(false);
    }
  };

  const s = detail?.status;
  const inSilver = detail?.tier === "silver";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white z-10 flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-900 font-mono">{row.case_key}</div>
            <div className="text-xs text-slate-500 truncate">{row.title}</div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none" aria-label={tx("Close")}>×</button>
        </div>

        {loadErr && <div className="p-5"><ErrorBox text={loadErr} /></div>}
        {!detail && !loadErr && <div className="p-8 text-xs text-slate-400">{tx("Loading…")}</div>}

        {detail && (
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StatusBadge status={detail.status} />
              <span>{tx("Revision")} {detail.revision}</span>
              {detail.tier !== "silver" && <span className="text-red-600 font-semibold">{tx("Not validated yet (Bronze)")}</span>}
              {detail.changed_since_publish && <span className="text-amber-600 font-semibold">{tx("Changed since the last published version")}</span>}
              {detail.approval.approved_by && (
                <span>
                  {tx("Approved by")} {detail.approval.approved_by} · {fmtDate(detail.approval.approved_at)}
                </span>
              )}
            </div>

            {detail.validation_errors && detail.validation_errors.length > 0 && (
              <ErrorBox text={tx("Validation errors:") + "\n" + formatErrors(detail.validation_errors).join("\n")} />
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-slate-500">{tx("Case (JSON)")}</span>
                {dirty && <span className="text-[11px] text-amber-600 font-semibold">{tx("Unsaved changes")}</span>}
              </div>
              <textarea
                className={`${inputCls} font-mono text-xs`}
                rows={26}
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-[11px] text-slate-400">
                  {tx("Saving creates a new revision, sends the case back to draft and leaves every published version untouched.")}
                </span>
                <div className="flex gap-2 shrink-0">
                  <button type="button" className={btnGhost} disabled={!dirty || busy} onClick={() => setText(original)}>{tx("Revert")}</button>
                  <button type="button" className={btnPrimary} disabled={!dirty || busy} onClick={save}>{busy ? tx("Saving…") : tx("Save")}</button>
                </div>
              </div>
            </div>

            {err && <ErrorBox text={err} />}

            <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/50">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Review")}</div>
              <input className={inputCls} placeholder={tx("Note (optional)")} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                {inSilver && (s === "draft" || s === "in_review") && (
                  <button type="button" className={btnPrimary} disabled={busy || dirty} onClick={() => act("approve")}>{tx("Approve")}</button>
                )}
                {inSilver && s === "draft" && (
                  <button type="button" className={btnGhost} disabled={busy || dirty} onClick={() => act("review")}>{tx("Send to review")}</button>
                )}
                {inSilver && s === "in_review" && (
                  <button type="button" className={btnGhost} disabled={busy || dirty} onClick={() => act("reject")}>{tx("Reject")}</button>
                )}
                {(s === "approved" || s === "rejected") && (
                  <button type="button" className={btnGhost} disabled={busy || dirty} onClick={() => act("restore")}>{tx("Back to draft")}</button>
                )}
                {s === "archived" && (
                  <button type="button" className={btnGhost} disabled={busy} onClick={() => act("restore")}>{tx("Restore")}</button>
                )}
                {s && s !== "archived" && (
                  <button type="button" className="px-3 py-2 text-xs font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40" disabled={busy || dirty} onClick={() => act("retire")}>
                    {tx("Retire from the dataset")}
                  </button>
                )}
              </div>
              {dirty && <div className="text-[11px] text-slate-400">{tx("Save or revert your edits first.")}</div>}
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">{tx("History in published versions")}</div>
              {detail.published_in.length === 0 ? (
                <div className="text-xs text-slate-400">{tx("Not in any published version yet.")}</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th className="py-1 font-semibold">{tx("Version")}</th>
                      <th className="py-1 font-semibold">{tx("Revision")}</th>
                      <th className="py-1 font-semibold">{tx("Ground truth")}</th>
                      <th className="py-1 font-semibold">{tx("Published")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.published_in.map((h) => (
                      <tr key={h.version} className="border-t border-slate-100">
                        <td className="py-1 font-mono">{h.version}</td>
                        <td className="py-1">{h.revision}</td>
                        <td className="py-1">{h.verification ?? "—"}</td>
                        <td className="py-1">{fmtDate(h.published_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Cases tab ────────────────────────────────────────────────────────────────
function CasesTab({ detail, reloadKey, onChanged, onAddCase }: { detail: DatasetDetail; reloadKey: number; onChanged: (text: string) => void; onAddCase: () => void }) {
  const slug = detail.slug;
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [scenario, setScenario] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<CaseRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params: Record<string, string | number | boolean> = { limit: PAGE_SIZE, offset, tier: "silver" };
      if (status) params.status = status;
      if (category) params.category = category;
      if (scenario) params.scenario_type = scenario;
      if (changedOnly) params.changed_only = true;
      if (search.trim()) params.q = search.trim();
      const { data } = await api.get<{ total: number; items: CaseRow[] }>(`/eval/datasets/${slug}/cases`, { params });
      setRows(data.items);
      setTotal(data.total);
    } catch (e: any) {
      setError(errText(e, "Could not load the cases."));
    } finally {
      setLoading(false);
    }
  }, [slug, offset, status, category, scenario, changedOnly, search]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${inputCls} !w-56`} placeholder={tx("Search id or title")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${inputCls} !w-40`} value={status} onChange={(e) => resetPage(setStatus)(e.target.value)}>
          <option value="">{tx("Any status")}</option>
          {(Object.keys(STATUS_LABEL) as CaseStatus[]).map((s) => (
            <option key={s} value={s}>{tx(STATUS_LABEL[s])}</option>
          ))}
        </select>
        <select className={`${inputCls} !w-48`} value={category} onChange={(e) => resetPage(setCategory)(e.target.value)}>
          <option value="">{tx("Any category")}</option>
          {detail.facets.category.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className={`${inputCls} !w-44`} value={scenario} onChange={(e) => resetPage(setScenario)(e.target.value)}>
          <option value="">{tx("Any scenario")}</option>
          {detail.facets.scenario_type.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2">
          <input type="checkbox" checked={changedOnly} onChange={(e) => resetPage(setChangedOnly)(e.target.checked)} />
          {tx("Changed since last publish")}
        </label>
        <div className="flex-1" />
        <button type="button" className={btnGhost} onClick={onAddCase}>{tx("+ Add case")}</button>
      </div>

      {error && <ErrorBox text={error} />}

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 bg-slate-50/70">
              <th className="px-3 py-2 font-semibold">{tx("Case")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Title")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Category")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Scenario")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Severity")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Status")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Rev")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Published")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">{tx("Loading…")}</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">{tx("No cases match.")}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.case_key} className="border-t border-slate-100 hover:bg-blue-50/40 cursor-pointer" onClick={() => setOpen(r)}>
                <td className="px-3 py-2 font-mono font-semibold text-slate-800 whitespace-nowrap">{r.case_key}</td>
                <td className="px-3 py-2 text-slate-600 max-w-md truncate">{r.title}</td>
                <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.category}</td>
                <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.scenario_type}</td>
                <td className="px-3 py-2 text-slate-500">{r.severity}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2 text-slate-500">{r.revision}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.changed_since_publish ? (
                    <span className="text-amber-600 font-semibold">{tx("Changed")}</span>
                  ) : (
                    <span className="text-slate-400">{r.last_published_version ?? "—"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {total === 0 ? tx("0 cases") : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} ${tx("of")} ${total}`}
        </span>
        <div className="flex gap-2">
          <button type="button" className={btnGhost} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{tx("Previous")}</button>
          <button type="button" className={btnGhost} disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{tx("Next")}</button>
        </div>
      </div>

      {open && (
        <CaseDrawer
          slug={slug}
          row={open}
          onClose={() => setOpen(null)}
          onChanged={(text) => {
            onChanged(text);
            load();
          }}
        />
      )}
    </div>
  );
}

// ── Versions tab ─────────────────────────────────────────────────────────────
function VersionsTab({ detail }: { detail: DatasetDetail }) {
  const published = detail.versions.filter((v) => v.state === "published");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setDiff(null);
    setErr("");
    setTo(published[0]?.version ?? "");
    setFrom(published[1]?.version ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.slug, detail.latest_version]);

  const compare = async () => {
    setBusy(true);
    setErr("");
    setDiff(null);
    try {
      const { data } = await api.get<DiffResult>(`/eval/datasets/${detail.slug}/diff`, { params: { from, to } });
      setDiff(data);
    } catch (e: any) {
      setErr(errText(e, "Could not compare the versions."));
    } finally {
      setBusy(false);
    }
  };

  const download = async (version: string, format: string) => {
    setErr("");
    try {
      const resp = await api.get(`/eval/datasets/${detail.slug}/versions/${version}/export`, { params: { format }, responseType: "blob" });
      const url = URL.createObjectURL(resp.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${detail.slug}-${version}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(errText(e, "Export failed."));
    }
  };

  return (
    <div className="space-y-4">
      {err && <ErrorBox text={err} />}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 bg-slate-50/70">
              <th className="px-3 py-2 font-semibold">{tx("Version")}</th>
              <th className="px-3 py-2 font-semibold">{tx("State")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Cases")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Fixtures")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Published")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Approved by")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Change summary")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Export")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.versions.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">{tx("Nothing published yet.")}</td></tr>
            )}
            {detail.versions.map((v) => (
              <tr key={v.version} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">
                  {v.version}
                  {v.version === detail.latest_version && <span className="ml-2 text-[10px] text-emerald-600 font-semibold">{tx("latest")}</span>}
                </td>
                <td className="px-3 py-2 text-slate-500">{v.state}</td>
                <td className="px-3 py-2 text-slate-500">{v.case_count}</td>
                <td className="px-3 py-2 text-slate-500">{v.fixture_count}</td>
                <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(v.published_at)}</td>
                <td className="px-3 py-2 text-slate-500">{v.approval?.approved_by ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600 max-w-xs truncate" title={v.change_summary ?? ""}>{v.change_summary ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {v.state === "published" &&
                    ["jsonl", "json", "csv"].map((f) => (
                      <button key={f} type="button" className="mr-2 text-blue-600 hover:underline" onClick={() => download(v.version, f)}>
                        {f}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {published.length >= 2 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Compare two versions")}</div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={tx("From")}>
              <select className={`${inputCls} !w-32`} value={from} onChange={(e) => setFrom(e.target.value)}>
                {published.map((v) => (<option key={v.version} value={v.version}>{v.version}</option>))}
              </select>
            </Field>
            <Field label={tx("To")}>
              <select className={`${inputCls} !w-32`} value={to} onChange={(e) => setTo(e.target.value)}>
                {published.map((v) => (<option key={v.version} value={v.version}>{v.version}</option>))}
              </select>
            </Field>
            <button type="button" className={btnPrimary} disabled={busy || !from || !to || from === to} onClick={compare}>
              {busy ? tx("Comparing…") : tx("Compare")}
            </button>
          </div>
          {diff && (
            <div className="space-y-2 text-xs">
              <div className="text-slate-600">
                <b>{diff.changed.length}</b> {tx("changed")} · <b>{diff.added.length}</b> {tx("added")} · <b>{diff.removed.length}</b> {tx("removed")} · {diff.unchanged} {tx("unchanged")}
              </div>
              {diff.added.length > 0 && <div className="text-emerald-700">{tx("Added:")} {diff.added.join(", ")}</div>}
              {diff.removed.length > 0 && <div className="text-red-600">{tx("Removed:")} {diff.removed.join(", ")}</div>}
              {diff.changed.length > 0 && (
                <table className="w-full">
                  <tbody>
                    {diff.changed.map((c) => (
                      <tr key={c.case_key} className="border-t border-slate-100">
                        <td className="py-1 pr-3 font-mono font-semibold text-slate-800 whitespace-nowrap">{c.case_key}</td>
                        <td className="py-1 text-slate-500">{c.fields.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Fixtures tab ─────────────────────────────────────────────────────────────
function FixturesTab({ slug, onChanged }: { slug: string; onChanged: (text: string) => void }) {
  const [rows, setRows] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState("");
  const [kind, setKind] = useState("payload");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Fixture[]>(`/eval/datasets/${slug}/fixtures`);
      setRows(data);
    } catch (e: any) {
      setErr(errText(e, "Could not load the fixtures."));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      const form = new FormData();
      form.append("file", file);
      if (key.trim()) form.append("fixture_key", key.trim());
      form.append("kind", kind);
      if (description.trim()) form.append("description", description.trim());
      const { data } = await api.post(`/eval/datasets/${slug}/fixtures`, form, { headers: { "Content-Type": "multipart/form-data" } });
      onChanged(`Fixture ${data.fixture_key} stored. Publish a new version to pin it.`);
      setFile(null);
      setKey("");
      setDescription("");
      await load();
    } catch (e: any) {
      setErr(errText(e, "Could not store the fixture."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {err && <ErrorBox text={err} />}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 bg-slate-50/70">
              <th className="px-3 py-2 font-semibold">{tx("Fixture")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Kind")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Type")}</th>
              <th className="px-3 py-2 font-semibold">{tx("Size")}</th>
              <th className="px-3 py-2 font-semibold">SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">{tx("Loading…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">{tx("No fixtures.")}</td></tr>}
            {rows.map((f) => (
              <tr key={f.fixture_key} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">{f.fixture_key}</td>
                <td className="px-3 py-2 text-slate-500">{f.kind}</td>
                <td className="px-3 py-2 text-slate-500">{f.content_type}</td>
                <td className="px-3 py-2 text-slate-500">{f.size_bytes} B</td>
                <td className="px-3 py-2 font-mono text-slate-400">{f.sha256.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Add or replace a fixture")}</div>
        <p className="text-xs text-slate-500">
          {tx("A published version keeps the fixture it was published with. A replacement takes effect in the next version you publish.")}
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label={tx("File")}>
            <input type="file" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label={tx("Key (defaults to the file name)")}>
            <input className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label={tx("Kind")}>
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="payload">{tx("Payload (JSON data)")}</option>
              <option value="document">{tx("Document (image or text)")}</option>
            </select>
          </Field>
          <Field label={tx("Description (optional)")}>
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end">
          <button type="button" className={btnPrimary} disabled={busy || !file} onClick={upload}>{busy ? tx("Storing…") : tx("Store fixture")}</button>
        </div>
      </div>
    </div>
  );
}

// ── Publish ──────────────────────────────────────────────────────────────────
function PublishModal({ detail, onClose, onDone }: { detail: DatasetDetail; onClose: () => void; onDone: (text: string) => void }) {
  const [version, setVersion] = useState(detail.suggested_version);
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const approved = detail.by_status.approved ?? 0;
  const left = (detail.by_status.draft ?? 0) + (detail.by_status.in_review ?? 0) + (detail.by_status.rejected ?? 0);

  const publish = async () => {
    setBusy(true);
    setErr("");
    try {
      const { data } = await api.post<VersionInfo>(`/eval/datasets/${detail.slug}/publish`, {
        version: version.trim(),
        change_summary: summary.trim() || null,
        note: note.trim() || null,
      });
      onDone(`Published ${detail.slug} ${data.version} with ${data.case_count} cases.`);
      onClose();
    } catch (e: any) {
      setErr(errText(e, "Publishing failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={tx("Publish a new version")} onClose={onClose}>
      <div className="text-xs text-slate-600 space-y-1">
        <div><b>{approved}</b> {tx("approved cases will be published.")}</div>
        {left > 0 && <div className="text-amber-600">{left} {tx("cases are not approved (draft, in review or rejected) and will be left out.")}</div>}
        {detail.latest_version && <div className="text-slate-400">{tx("Latest published version:")} {detail.latest_version}</div>}
      </div>
      <Field label={tx("Version")}>
        <input className={`${inputCls} font-mono`} value={version} onChange={(e) => setVersion(e.target.value)} />
      </Field>
      <Field label={tx("What changed and why")}>
        <textarea className={inputCls} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={tx("For example: updated the underwriting limits after the rule change")} />
      </Field>
      <Field label={tx("Approval note (optional)")}>
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" className="mt-0.5" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>{tx("I understand a published version is permanent: it cannot be edited or deleted, only replaced by a higher version.")}</span>
      </label>
      {err && <ErrorBox text={err} />}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btnGhost} onClick={onClose}>{tx("Cancel")}</button>
        <button type="button" className={btnPrimary} disabled={busy || !sure || approved === 0 || !version.trim()} onClick={publish}>
          {busy ? tx("Publishing…") : tx("Publish")}
        </button>
      </div>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
type Tab = "cases" | "versions" | "fixtures";
type ModalKind = null | "new" | "upload" | "add" | "publish";

function DatasetsContent() {
  const [authorized, setAuthorized] = useState(true);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [slug, setSlug] = useState("");
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [tab, setTab] = useState<Tab>("cases");
  const [modal, setModal] = useState<ModalKind>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [approving, setApproving] = useState(false);

  const loadList = useCallback(async () => {
    setError("");
    try {
      const { data } = await api.get<DatasetSummary[]>("/eval/datasets");
      setDatasets(data);
      setSlug((cur) => cur || data[0]?.slug || "");
    } catch (e: any) {
      setError(errText(e, "Failed to load the datasets."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async () => {
    if (!slug) {
      setDetail(null);
      return;
    }
    try {
      const { data } = await api.get<DatasetDetail>(`/eval/datasets/${slug}`);
      setDetail(data);
    } catch (e: any) {
      setError(errText(e, "Failed to load the dataset."));
    }
  }, [slug]);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    loadList();
  }, [loadList]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const refresh = async () => {
    await Promise.all([loadList(), loadDetail()]);
    setReloadKey((k) => k + 1);
  };

  const say = (text: string, kind: "ok" | "error" = "ok") => {
    setNotice({ kind, text });
  };

  const changed = (text: string) => {
    say(text);
    refresh();
  };

  const approveAll = async () => {
    if (!detail) return;
    setApproving(true);
    try {
      const { data } = await api.post<{ approved: number }>(`/eval/datasets/${detail.slug}/approve`, { note: null });
      say(`${data.approved} case(s) approved.`);
      await refresh();
    } catch (e: any) {
      say(errText(e, "Approval failed."), "error");
    } finally {
      setApproving(false);
    }
  };

  if (!authorized) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 text-center font-sans min-h-screen">
        <div className="max-w-md p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-xl">
          <h1 className="text-xl font-bold text-white mb-2">{tx("Access Denied")}</h1>
          <p className="text-slate-400 text-sm mb-6">{tx("This page is restricted to platform SuperAdmins.")}</p>
          <a href="/" className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all">
            {tx("Back to app")}
          </a>
        </div>
      </div>
    );
  }

  const pendingReview = detail ? (detail.by_status.draft ?? 0) + (detail.by_status.in_review ?? 0) : 0;

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Golden Datasets")}</h1>
          <p className="text-sm text-slate-500 mt-0.5 max-w-3xl">
            {tx("Keep the evaluation cases in step with the system. Edit or add cases here, approve them, then publish a new version. Published versions never change, so every evaluation run can say exactly which version it used.")}
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => setModal("new")}>{tx("+ New dataset")}</button>
      </div>

      {notice && (
        <div
          className={`text-xs rounded-lg px-3 py-2 border flex items-start justify-between gap-3 ${
            notice.kind === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-red-50 border-red-200 text-red-600"
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" className="opacity-60 hover:opacity-100" onClick={() => setNotice(null)} aria-label={tx("Dismiss")}>×</button>
        </div>
      )}
      {error && <ErrorBox text={error} />}

      {loading ? (
        <div className="py-20 text-center text-xs text-slate-400">{tx("Loading datasets…")}</div>
      ) : datasets.length === 0 ? (
        <div className="py-16 text-center text-sm text-slate-400">{tx("No datasets yet. Create one, then upload cases.")}</div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {datasets.map((d) => {
              const total = Object.values(d.by_status).reduce((a, b) => a + (b ?? 0), 0);
              const active = d.slug === slug;
              return (
                <button
                  key={d.slug}
                  type="button"
                  onClick={() => setSlug(d.slug)}
                  className={`text-left bg-white border rounded-xl px-4 py-3 transition-all ${active ? "border-blue-500 ring-1 ring-blue-500" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <div className="text-sm font-semibold text-slate-800">{d.name}</div>
                  <div className="text-[11px] font-mono text-slate-400">{d.slug}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    <span>{total} {tx("cases")}</span>
                    <span>{d.turn_mode === "multi_turn" ? tx("multi turn") : tx("single turn")}</span>
                    <span>{d.latest_version ? tx("latest ") + d.latest_version : tx("unpublished")}</span>
                    {d.unpublished_changes > 0 && <span className="text-amber-600 font-semibold">{d.unpublished_changes} {tx("unpublished changes")}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {detail && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-xl px-4 py-3">
                <div className="min-w-0 mr-auto">
                  <div className="text-sm font-bold text-slate-900">{detail.name}</div>
                  <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3">
                    <span>{detail.workflow}</span>
                    <span>{tx("latest")} {detail.latest_version ?? "—"}</span>
                    {(Object.keys(STATUS_LABEL) as CaseStatus[]).map((s) =>
                      (detail.by_status[s] ?? 0) > 0 ? (
                        <span key={s}>{detail.by_status[s]} {tx(STATUS_LABEL[s]).toLowerCase()}</span>
                      ) : null,
                    )}
                  </div>
                </div>
                <button type="button" className={btnGhost} onClick={() => setModal("upload")}>{tx("Upload cases")}</button>
                <button type="button" className={btnGhost} disabled={approving || pendingReview === 0} onClick={approveAll}>
                  {approving ? tx("Approving…") : `${tx("Approve all pending")} (${pendingReview})`}
                </button>
                <button type="button" className={btnPrimary} onClick={() => setModal("publish")}>{tx("Publish new version")}</button>
              </div>

              <div className="flex gap-1 border-b border-slate-200">
                {(["cases", "versions", "fixtures"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px ${tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
                  >
                    {t === "cases" ? tx("Cases") : t === "versions" ? tx("Versions") : tx("Fixtures")}
                  </button>
                ))}
              </div>

              {tab === "cases" && <CasesTab detail={detail} reloadKey={reloadKey} onChanged={changed} onAddCase={() => setModal("add")} />}
              {tab === "versions" && <VersionsTab detail={detail} />}
              {tab === "fixtures" && <FixturesTab slug={detail.slug} onChanged={(t) => say(t)} />}
            </div>
          )}
        </>
      )}

      {modal === "new" && (
        <NewDatasetModal
          onClose={() => setModal(null)}
          onCreated={(s) => {
            setModal(null);
            setSlug(s);
            say(`Dataset ${s} created. Upload cases to fill it.`);
            loadList();
          }}
        />
      )}
      {modal === "upload" && detail && <UploadCasesModal slug={detail.slug} onClose={() => setModal(null)} onDone={(t) => changed(t)} />}
      {modal === "add" && detail && <AddCaseModal slug={detail.slug} onClose={() => setModal(null)} onDone={(t) => changed(t)} />}
      {modal === "publish" && detail && <PublishModal detail={detail} onClose={() => setModal(null)} onDone={(t) => changed(t)} />}
    </div>
  );
}

export default function GoldenDatasetsPage() {
  return (
    <Suspense fallback={null}>
      <DatasetsContent />
    </Suspense>
  );
}
