"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { tx } from "@/lib/i18n/tx";
import { loadViews, storeViews, withView, withoutView, type SavedView } from "@/lib/savedViews";

const field = "w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900";

/** The list and the form, apart from where they live, so they can be drawn and checked on their own. */
export function SavedViewsPanel({ views, name, onName, onSave, onOpen, onDelete, onCopy, note }: {
  views: SavedView[]; name: string; onName: (s: string) => void; onSave: () => void; onOpen: (v: SavedView) => void; onDelete: (v: SavedView) => void; onCopy: () => void; note: string | null;
}) {
  return (
    <div className="w-72 space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900" role="dialog" aria-label={tx("Saved views")} data-testid="saved-views-panel">
      <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400" htmlFor="sv-name">{tx("Save this page as")}</label>
        <div className="flex gap-1.5"><input id="sv-name" className={field} value={name} maxLength={60} placeholder={tx("e.g. Failing agent cases, 30 days")} onChange={(e) => onName(e.target.value)} />
          <button type="submit" disabled={!name.trim()} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{tx("Save")}</button></div>
        <p className="text-[10px] text-slate-400">{tx("Keeps the mode, filters and window as they are now. Stored in this browser only.")}</p>
      </form>
      {note && <p className="text-[11px] text-amber-700" role="status">{note}</p>}
      {views.length === 0 ? <p className="py-2 text-center text-[11px] text-slate-400" data-testid="saved-views-empty">{tx("No saved views yet.")}</p> : (
        <ul className="max-h-60 space-y-1 overflow-y-auto" data-testid="saved-views-list">{views.map((v) => (
          <li key={v.name} className="flex items-center gap-1 rounded-lg border border-slate-100 px-2 py-1.5 dark:border-slate-800">
            <button type="button" onClick={() => onOpen(v)} className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-slate-800 hover:text-blue-700 dark:text-slate-100" title={v.href}>{v.name}</button>
            <button type="button" onClick={() => onDelete(v)} aria-label={`${tx("Delete the saved view")} ${v.name}`} className="rounded px-1.5 text-slate-400 hover:text-red-600">×</button>
          </li>))}
        </ul>
      )}
      <button type="button" onClick={onCopy} className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:border-sky-400 dark:border-slate-700 dark:text-slate-300">{tx("Copy a link to this page")}</button>
    </div>
  );
}

export default function SavedViews() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (open) { setViews(loadViews()); setNote(null); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const here = () => `${window.location.pathname}${window.location.search}`;
  const save = () => {
    const next = withView(views, name, here());
    if (next === views) return;
    if (storeViews(next)) { setViews(next); setName(""); setNote(null); } else setNote(tx("This browser would not store it (private window or blocked site data)."));
  };
  const remove = (v: SavedView) => { const next = withoutView(views, v.name); if (storeViews(next)) setViews(next); else setNote(tx("This browser would not store the change.")); };
  const copy = () => { try { navigator.clipboard.writeText(`${window.location.origin}${here()}`).then(() => setNote(tx("Link copied.")), () => setNote(tx("Could not copy the link."))); } catch { setNote(tx("Could not copy the link.")); } };
  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" data-testid="saved-views-button"
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-sky-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{tx("Views")}</button>
      {open && <div className="absolute right-0 top-full z-40 mt-1.5"><SavedViewsPanel views={views} name={name} onName={setName} onSave={save} onOpen={(v) => { setOpen(false); router.push(v.href); }} onDelete={remove} onCopy={copy} note={note} /></div>}
    </div>
  );
}
