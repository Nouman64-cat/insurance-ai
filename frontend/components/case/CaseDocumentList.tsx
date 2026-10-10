"use client";

import { useState } from "react";
import { DOCUMENT_TYPES, deleteArtifact, getArtifactUrl, updateArtifact } from "@/app/services/artifacts";

export interface CaseDocument {
  id: string;
  document_type: string;
  file_name: string;
  file_size: number;
  ocr_result: string | null;
  status: string;
}

const fmtSize = (bytes: number) =>
  !bytes ? "—" : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

const ICON = "w-3.5 h-3.5";

/**
 * The files uploaded to a case, each with view / edit / delete. Editing changes the
 * document type (which requirement it counts toward) and the display name; deleting
 * removes the file and reverts any requirement it satisfied to Missing.
 */
export default function CaseDocumentList({
  documents,
  requiredTypes,
  canEdit,
  onChanged,
  onError,
}: {
  documents: CaseDocument[];
  requiredTypes: string[];
  /** False for roles that can't upload (Agents) — they can still view. */
  canEdit: boolean;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ document_type: "", file_name: "" });
  const [busyId, setBusyId] = useState<string | null>(null);

  // The plan's required types first, then the standard list, without repeats.
  const typeOptions = Array.from(new Set([...requiredTypes, ...DOCUMENT_TYPES]));

  const view = async (doc: CaseDocument) => {
    // Open the tab synchronously so the browser doesn't treat it as a popup.
    const tab = window.open("", "_blank");
    try {
      const url = await getArtifactUrl(doc.id);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    } catch (err: any) {
      tab?.close();
      onError(err.message ?? "Couldn't open the document.");
    }
  };

  const startEdit = (doc: CaseDocument) => {
    setEditingId(doc.id);
    setDraft({ document_type: doc.document_type, file_name: doc.file_name });
  };

  const save = async (doc: CaseDocument) => {
    const body: { document_type?: string; file_name?: string } = {};
    if (draft.document_type !== doc.document_type) body.document_type = draft.document_type;
    if (draft.file_name.trim() && draft.file_name.trim() !== doc.file_name) body.file_name = draft.file_name.trim();
    if (!Object.keys(body).length) {
      setEditingId(null);
      return;
    }
    setBusyId(doc.id);
    try {
      await updateArtifact(doc.id, body);
      setEditingId(null);
      onChanged(`Updated "${body.file_name ?? doc.file_name}"${body.document_type ? ` — now filed as ${body.document_type}` : ""}.`);
    } catch (err: any) {
      onError(err.message ?? "Couldn't update the document.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (doc: CaseDocument) => {
    if (!confirm(`Delete "${doc.file_name}" (${doc.document_type})? The file is removed permanently.`)) return;
    setBusyId(doc.id);
    try {
      await deleteArtifact(doc.id);
      onChanged(`Deleted "${doc.file_name}".`);
    } catch (err: any) {
      onError(err.message ?? "Couldn't delete the document.");
    } finally {
      setBusyId(null);
    }
  };

  const iconBtn = "p-1 rounded-md text-slate-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="pt-3 border-t border-slate-100 space-y-1">
      {documents.map((a) => {
        const busy = busyId === a.id;
        if (editingId === a.id) {
          return (
            <div key={a.id} className="rounded-lg border border-blue-200 bg-blue-50/40 p-2.5 space-y-2">
              <input
                value={draft.file_name}
                onChange={(e) => setDraft((d) => ({ ...d, file_name: e.target.value }))}
                maxLength={255}
                aria-label="File name"
                className="w-full bg-white border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <select
                value={draft.document_type}
                onChange={(e) => setDraft((d) => ({ ...d, document_type: e.target.value }))}
                aria-label="Document type"
                className="w-full bg-white border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              >
                {!typeOptions.includes(draft.document_type) && <option value={draft.document_type}>{draft.document_type}</option>}
                {typeOptions.map((t) => (
                  <option key={t} value={t}>{t}{requiredTypes.includes(t) ? " (required)" : ""}</option>
                ))}
              </select>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  disabled={busy}
                  className="px-2.5 py-1 text-[11px] font-semibold text-slate-600 border border-slate-200 bg-white rounded-md hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => save(a)}
                  disabled={busy}
                  className="px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-60"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          );
        }
        return (
          <div key={a.id} className="group flex items-center gap-2 text-xs rounded-md px-1 py-1 -mx-1 hover:bg-slate-50">
            <div className="min-w-0 flex-1">
              <p className="truncate text-slate-700 font-medium" title={a.file_name}>{a.file_name}</p>
              <p className="text-[10px] text-slate-400">{a.document_type} · {fmtSize(a.file_size)}</p>
            </div>
            <span className={`font-semibold flex-shrink-0 ${a.status === "Processing" ? "text-amber-600 animate-pulse" : a.ocr_result ? "text-blue-600" : "text-slate-400"}`}>
              {a.status === "Processing" ? "OCR…" : a.ocr_result ? "OCR done" : a.status}
            </span>
            <div className="flex items-center flex-shrink-0">
              <button type="button" onClick={() => view(a)} disabled={busy} className={`${iconBtn} hover:text-blue-600 hover:bg-blue-50`} title="View">
                <svg className={ICON} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
              </button>
              <button
                type="button"
                onClick={() => startEdit(a)}
                disabled={!canEdit || busy}
                className={`${iconBtn} hover:text-blue-600 hover:bg-blue-50`}
                title={canEdit ? "Edit type / name" : "Currently, you have no access to do this, ask your manager"}
              >
                <svg className={ICON} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" /></svg>
              </button>
              <button
                type="button"
                onClick={() => remove(a)}
                disabled={!canEdit || busy}
                className={`${iconBtn} hover:text-red-600 hover:bg-red-50`}
                title={canEdit ? "Delete" : "Currently, you have no access to do this, ask your manager"}
              >
                {busy ? (
                  <span className="block w-3.5 h-3.5 rounded-full border-2 border-slate-300 border-t-slate-500 animate-spin" />
                ) : (
                  <svg className={ICON} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
