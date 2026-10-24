"use client";

import { useEffect, useMemo, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tx } from "@/lib/i18n/tx";
import {
  ADDABLE, FIELD_TYPES, TYPE_LABEL, allFieldIds, storedAs, clone, describeChange, discardDraft, getDiff, move, newField, publishTemplate, saveDraft, slugFor,
  type Change, type Column, type Field, type FieldType, type Option, type Section, type TemplateContent, type TemplateDetail,
} from "@/lib/templates";

const inputCls = "w-full text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 bg-white";
const btnPrimary = "px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-all";
const btnGhost = "px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
const tiny = "px-1.5 py-0.5 text-[11px] rounded border border-slate-200 text-slate-500 hover:border-slate-300 disabled:opacity-30";

function ColumnsEditor({ label, cols, onChange }: { label: string; cols: Column[]; onChange: (c: Column[]) => void }) {
  const taken = cols.map((c) => c.id);
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold text-slate-500">{label}</div>
      {cols.map((c, i) => (
        <div key={c.id} className="flex gap-1 items-center">
          <input className={inputCls} value={c.label} aria-label={tx("Column label")} onChange={(e) => onChange(cols.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <select className="text-xs border border-slate-200 rounded px-1 py-1.5" value={c.type} onChange={(e) => onChange(cols.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldType } : x)))}>
            {(["text", "number", "date", "yes_no", "select"] as FieldType[]).map((t) => <option key={t} value={t}>{tx(TYPE_LABEL[t])}</option>)}
          </select>
          <button type="button" className={tiny} onClick={() => onChange(cols.filter((_, j) => j !== i))} aria-label={tx("Remove column")}>×</button>
        </div>
      ))}
      <button type="button" className={tiny} onClick={() => onChange([...cols, { id: slugFor("column", taken, "column"), label: "New column", type: "text" }])}>+ {tx("Add column")}</button>
    </div>
  );
}

function FieldRow({ f, earlier, onChange, onDelete, onMove, first, last }: {
  f: Field; earlier: Field[]; onChange: (f: Field) => void; onDelete: () => void; onMove: (d: number) => void; first: boolean; last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<Field>) => onChange({ ...f, ...patch });
  const optionsText = (f.options ?? []).map((o) => o.label).join("\n");
  const setOptions = (text: string) => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const used: string[] = [];
    const existing = f.options ?? [];
    const sameCount = lines.length === existing.length;
    set({ options: lines.map((label, i) => {
      // Rewording an option keeps what it stores: by position when the number of options is unchanged, otherwise by matching wording.
      const keep = (sameCount ? existing[i] : existing.find((o) => o.label === label)) as Option | undefined;
      if (keep && !used.includes(keep.id)) { used.push(keep.id); return { ...keep, label } as Option; }
      const id = slugFor(label, [...used, ...existing.map((o) => o.id)], "option");
      used.push(id);
      return { id, label, value: label } as Option;
    }) });
  };
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-2.5" data-testid={`field-${f.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} flex-1 min-w-[12rem]`} value={f.label} aria-label={tx("Field label")} onChange={(e) => set({ label: e.target.value })} />
        {f.binding?.store === "profile" && <span className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200" title={tx("Part of the form itself")}>{tx("built-in")}</span>}
        {f.locked ? (
          <span className="text-[11px] text-slate-500 px-2 py-1 rounded bg-slate-100 border border-slate-200" title={tx("The product depends on this field: its wording can change, but it cannot be removed or change type.")}>{tx(TYPE_LABEL[f.type])} · 🔒</span>
        ) : (
          <select className="text-xs border border-slate-200 rounded px-1.5 py-1.5" value={f.type} aria-label={tx("Field type")}
            onChange={(e) => { const t = e.target.value as FieldType; const base = newField(t, f.label, []); set({ type: t, options: base.options, columns: base.columns, detail_fields: base.detail_fields }); }}>
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{tx(TYPE_LABEL[t])}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={!!f.required} onChange={(e) => set({ required: e.target.checked })} />{tx("Required")}</label>
        <button type="button" className={tiny} onClick={() => onMove(-1)} disabled={first} aria-label={tx("Move up")}>↑</button>
        <button type="button" className={tiny} onClick={() => onMove(1)} disabled={last} aria-label={tx("Move down")}>↓</button>
        <button type="button" className={tiny} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? tx("Less") : tx("More")}</button>
        <button type="button" className={`${tiny} text-red-600`} onClick={onDelete} disabled={!!f.locked} title={f.locked ? tx("Locked: the product depends on this field") : tx("Remove this field")} aria-label={tx("Remove field")}>🗑</button>
      </div>
      {open && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 text-xs">
          <div className="text-slate-400">{tx("Field id")}: <code>{f.id}</code> · {tx("Saved as")}: <code data-testid="stored-as">{storedAs(f)}</code></div>
          <input className={inputCls} placeholder={tx("Help text shown under the question")} value={f.help ?? ""} onChange={(e) => set({ help: e.target.value })} />
          {(f.type === "text" || f.type === "textarea" || f.type === "phone") && (
            <div className="flex gap-2 sm:col-span-2">
              <input className={inputCls} placeholder={tx("Placeholder (example shown in the box)")} value={f.placeholder ?? ""} onChange={(e) => set({ placeholder: e.target.value })} />
              <input className={`${inputCls} max-w-[10rem]`} inputMode="numeric" placeholder={tx("Max length")} value={f.max_length ?? ""} onChange={(e) => set({ max_length: e.target.value ? Number(e.target.value) : undefined })} />
            </div>
          )}
          {(f.type === "select" || f.type === "checklist") && (
            <label className="sm:col-span-2 text-slate-500">{tx("Options, one per line")}
              <textarea className={`${inputCls} mt-1`} rows={Math.min(8, Math.max(3, (f.options ?? []).length + 1))} defaultValue={optionsText} onBlur={(e) => setOptions(e.target.value)} />
            </label>
          )}
          {f.type === "table" && <div className="sm:col-span-2"><ColumnsEditor label={tx("Columns")} cols={f.columns ?? []} onChange={(columns) => set({ columns })} /></div>}
          {f.type === "checklist" && <div className="sm:col-span-2"><ColumnsEditor label={tx("Details asked for each ticked item")} cols={f.detail_fields ?? []} onChange={(detail_fields) => set({ detail_fields })} /></div>}
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2 text-slate-500">
            {tx("Show only if")}
            <select className="border border-slate-200 rounded px-1.5 py-1" value={f.show_if?.field ?? ""} onChange={(e) => set({ show_if: e.target.value ? { field: e.target.value, equals: f.show_if?.equals ?? "Yes" } : undefined })}>
              <option value="">{tx("always")}</option>
              {earlier.map((e) => <option key={e.id} value={e.id}>{e.label.slice(0, 60)}</option>)}
            </select>
            {f.show_if && <>{tx("is")} <input className="border border-slate-200 rounded px-1.5 py-1 w-24" value={f.show_if.equals} onChange={(e) => set({ show_if: { field: f.show_if!.field, equals: e.target.value } })} /></>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function TemplateEditor({ detail, onReload, onNotice }: { detail: TemplateDetail; onReload: () => void; onNotice: (n: { kind: "ok" | "error"; text: string }) => void }) {
  const source = detail.draft?.content ?? detail.published?.content;
  const [content, setContent] = useState<TemplateContent>(() => clone(source as TemplateContent));
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState<string[]>(detail.draft_problems);
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [removeSection, setRemoveSection] = useState<number | null>(null);
  const [addType, setAddType] = useState<Record<string, FieldType>>({});
  const [addLabel, setAddLabel] = useState<Record<string, string>>({});

  useEffect(() => {
    setContent(clone((detail.draft?.content ?? detail.published?.content) as TemplateContent));
    setDirty(false);
    setProblems(detail.draft_problems);
    setNote("");
    if (detail.draft) getDiff(detail.key, detail.published?.version ?? "draft", "draft").then((d) => setChanges(d.changes)).catch(() => setChanges([]));
    else setChanges([]);
  }, [detail]);

  const edit = (fn: (c: TemplateContent) => void) => { const c = clone(content); fn(c); setContent(c); setDirty(true); };
  const taken = useMemo(() => allFieldIds(content), [content]);

  async function save() {
    setBusy(true);
    try {
      const r = await saveDraft(detail.key, content);
      setProblems(r.publish_problems); setChanges(r.changes); setDirty(false);
      onNotice({ kind: "ok", text: r.publish_problems.length ? tx("Draft saved. It cannot be published yet: see the list below.") : tx("Draft saved. Nobody else sees it until you publish.") });
      onReload();
    } catch (e) { onNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not save." }); } finally { setBusy(false); }
  }
  async function discard() {
    setBusy(true);
    try { await discardDraft(detail.key); onNotice({ kind: "ok", text: tx("Draft discarded.") }); onReload(); }
    catch (e) { onNotice({ kind: "error", text: e instanceof Error ? e.message : "Could not discard." }); } finally { setBusy(false); }
  }
  async function publish() {
    if (note.trim().length < 3) { setNoteError(tx("Write why the template is changing (at least a few words).")); return; }
    setBusy(true);
    try {
      const r = await publishTemplate(detail.key, note.trim());
      setPublishing(false);
      onNotice({ kind: "ok", text: `${tx("Published as version")} ${r.published.version}. ${r.registry.recorded ? tx("The change was recorded for the evaluation team.") : tx("Saved; the change will be recorded at the next scan.")}` });
      onReload();
    } catch (e) { setNoteError(e instanceof Error ? e.message : "Could not publish."); } finally { setBusy(false); }
  }

  const canPublish = !!detail.draft && !dirty && problems.length === 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="mr-auto min-w-0">
          <h2 className="text-sm font-bold text-slate-900">{detail.title}</h2>
          <p className="text-[11px] text-slate-500">
            {detail.published ? `${tx("Published version")} ${detail.published.version}` : tx("Not published")}
            {detail.draft ? ` · ${tx("draft in progress")}` : ""}{dirty ? ` · ${tx("unsaved changes")}` : ""}
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={save} disabled={busy || !dirty}>{tx("Save draft")}</button>
        {detail.draft && <button type="button" className={btnGhost} onClick={discard} disabled={busy}>{tx("Discard draft")}</button>}
        <button type="button" className={btnPrimary} onClick={() => { setNoteError(null); setPublishing(true); }} disabled={busy || !canPublish} title={canPublish ? "" : tx("Save a valid draft first")}>{tx("Publish")}</button>
      </div>

      {detail.key === "lead_acquisition" && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800" data-testid="lead-note">
          <b>{tx("How this reaches the forms:")}</b>{" "}
          {tx("Fields and sections you ADD here appear on the agent's Add Customer form, the customer portal's walk-in form and the lead details as soon as you publish (open forms pick them up within seconds). Their answers are checked and saved with the customer. Tabs take the names given here. The original fields (marked built-in) are part of the forms themselves: changing or removing them here does not change the forms yet.")}
        </div>
      )}
      {detail.key === "proposal" && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800" data-testid="proposal-note">
          <b>{tx("How this reaches the customer e-application:")}</b>{" "}
          {tx("Questions you ADD here appear at the end of the matching step of the e-application (a new section becomes a new step before the declaration). Answers are checked, saved with the application, and the required ones must be answered before it can be submitted. The original questions are part of the form itself: changing or removing them here does not change the form yet.")}
        </div>
      )}
      {problems.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert" data-testid="problems">
          <b>{tx("This draft cannot be published yet:")}</b>
          <ul className="list-disc pl-5 mt-1">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {changes.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs" open>
          <summary className="cursor-pointer font-semibold text-slate-700">{changes.length} {tx("changes compared with the published version")}</summary>
          <ul className="mt-1 space-y-0.5 text-slate-600" data-testid="changes">{changes.slice(0, 40).map((c, i) => <li key={i}>{describeChange(c)}</li>)}</ul>
        </details>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Title")}
          <input className={`${inputCls} mt-1`} value={content.title} onChange={(e) => edit((c) => { c.title = e.target.value; })} />
        </label>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Introduction")}
          <textarea className={`${inputCls} mt-1`} rows={2} value={content.intro ?? ""} onChange={(e) => edit((c) => { c.intro = e.target.value; })} />
        </label>
      </section>

      {content.sections.map((s: Section, si: number) => {
        const before = content.sections.slice(0, si).flatMap((x) => x.fields);
        return (
          <section key={s.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2" data-testid={`section-${s.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputCls} flex-1 min-w-[12rem] font-semibold`} value={s.title} aria-label={tx("Section title")} onChange={(e) => edit((c) => { c.sections[si].title = e.target.value; })} />
              <button type="button" className={tiny} disabled={si === 0} onClick={() => edit((c) => { c.sections = move(c.sections, si, si - 1); })} aria-label={tx("Move section up")}>↑</button>
              <button type="button" className={tiny} disabled={si === content.sections.length - 1} onClick={() => edit((c) => { c.sections = move(c.sections, si, si + 1); })} aria-label={tx("Move section down")}>↓</button>
              <button type="button" className={`${tiny} text-red-600`} onClick={() => setRemoveSection(si)} aria-label={tx("Remove section")}>🗑</button>
            </div>
            <input className={inputCls} placeholder={tx("Short description (optional)")} value={s.description ?? ""} onChange={(e) => edit((c) => { c.sections[si].description = e.target.value; })} />
            <ul className="space-y-1.5">
              {s.fields.map((f, fi) => (
                <FieldRow key={f.id} f={f} earlier={[...before, ...s.fields.slice(0, fi)]} first={fi === 0} last={fi === s.fields.length - 1}
                  onChange={(nf) => edit((c) => { c.sections[si].fields[fi] = nf; })}
                  onDelete={() => edit((c) => { c.sections[si].fields.splice(fi, 1); })}
                  onMove={(d) => edit((c) => { c.sections[si].fields = move(c.sections[si].fields, fi, fi + d); })} />
              ))}
            </ul>
            <div className="flex flex-wrap gap-2 items-center">
              <input className={`${inputCls} max-w-xs`} placeholder={tx("New field label")} value={addLabel[s.id] ?? ""} onChange={(e) => setAddLabel({ ...addLabel, [s.id]: e.target.value })} aria-label={tx("New field label")} />
              <select className="text-xs border border-slate-200 rounded px-1.5 py-1.5" value={addType[s.id] ?? "text"} onChange={(e) => setAddType({ ...addType, [s.id]: e.target.value as FieldType })} aria-label={tx("New field type")}>
                {ADDABLE.map((t) => <option key={t} value={t}>{tx(TYPE_LABEL[t])}</option>)}
              </select>
              <button type="button" className={btnGhost} disabled={!(addLabel[s.id] ?? "").trim()}
                onClick={() => { edit((c) => { c.sections[si].fields.push(newField(addType[s.id] ?? "text", (addLabel[s.id] ?? "").trim(), taken)); }); setAddLabel({ ...addLabel, [s.id]: "" }); }}>+ {tx("Add field")}</button>
            </div>
          </section>
        );
      })}
      <button type="button" className={btnGhost} onClick={() => edit((c) => { c.sections.push({ id: slugFor("new section", c.sections.map((x) => x.id), "section"), title: "New section", fields: [] }); })}>+ {tx("Add section")}</button>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Disclaimers, one per line")}
          <textarea className={`${inputCls} mt-1`} rows={3} value={(content.disclaimers ?? []).join("\n")} onChange={(e) => edit((c) => { c.disclaimers = e.target.value.split("\n").filter((l) => l.trim()); })} />
        </label>
      </section>

      {removeSection !== null && (
        <ConfirmDialog title={tx("Remove this section?")} confirmLabel={tx("Remove section")} onCancel={() => setRemoveSection(null)} onConfirm={() => { edit((c) => { c.sections.splice(removeSection, 1); }); setRemoveSection(null); }}>
          <p className="text-sm text-slate-600">{tx("The section and all its fields are removed from this draft. Nothing changes for anyone until you publish, and fields the product depends on cannot be removed when publishing.")}</p>
        </ConfirmDialog>
      )}
      {publishing && (
        <ConfirmDialog title={tx("Publish this template?")} confirmLabel={tx("Publish")} busy={busy} onCancel={() => setPublishing(false)} onConfirm={publish}>
          <div className="space-y-2">
            <p className="text-sm text-slate-600">{tx("From now on this becomes the live version. The change is recorded with your name and reason, and the evaluation team is told which tests depend on it.")}</p>
            {changes.length > 0 && <ul className="text-xs text-slate-500 list-disc pl-5 max-h-32 overflow-y-auto">{changes.slice(0, 12).map((c, i) => <li key={i}>{describeChange(c)}</li>)}</ul>}
            <textarea className={inputCls} rows={3} placeholder={tx("Why is the template changing?")} value={note} onChange={(e) => { setNote(e.target.value); setNoteError(null); }} aria-label={tx("Reason for the change")} />
            {noteError && <p className="text-xs text-red-600" role="alert">{noteError}</p>}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
