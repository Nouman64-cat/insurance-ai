"use client";

import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import api from "@/app/services/api";

// Formats the document pipeline accepts through this dialog.
const ALLOWED_EXTS = ["pdf", "png", "jpg", "jpeg"];
const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
const OTHER = "Other";

export interface DocumentUploadResult {
  uploaded: string[];
  failed: { type: string; reason: string }[];
}

interface Item {
  file: File;
  type: string;
}

/**
 * Popup shown in the chat for a case's required documents. Pick or drop several
 * files at once (PDF, PNG or JPG); each one is given a document type from the
 * case's required list — pre-filled in order, changeable per file — then they
 * are all uploaded together.
 */
export function DocumentUploadDialog({
  tenantId,
  caseId,
  caseNumber,
  documentTypes,
  onClose,
  onDone,
}: {
  tenantId: string;
  caseId: string;
  caseNumber?: string;
  documentTypes: string[];
  onClose: () => void;
  onDone: (result: DocumentUploadResult) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // In-dialog preview of a chosen file (read locally — nothing is uploaded to
  // view it). The object URL is released when the preview closes.
  const [preview, setPreview] = useState<{ url: string; name: string; isPdf: boolean } | null>(null);
  const openPreview = (file: File) => {
    const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
    setPreview({ url: URL.createObjectURL(file), name: file.name, isPdf });
  };
  const closePreview = () => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  };
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const typeOptions = [...documentTypes, OTHER];

  const addFiles = (list: FileList | File[]) => {
    const rejected: string[] = [];
    const accepted: File[] = [];
    Array.from(list).forEach((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      if (ALLOWED_EXTS.includes(ext)) accepted.push(f);
      else rejected.push(f.name);
    });
    setError(rejected.length ? `Not supported (use PDF, PNG or JPG): ${rejected.join(", ")}` : "");
    if (!accepted.length) return;
    setItems((prev) => {
      // Give each new file the next required document type nobody has claimed
      // yet, so choosing the three files in order labels them correctly.
      const taken = new Set(prev.map((i) => i.type));
      const next = [...prev];
      for (const file of accepted) {
        const free = documentTypes.find((t) => !taken.has(t));
        const type = free ?? OTHER;
        taken.add(type);
        next.push({ file, type });
      }
      return next;
    });
  };

  const submit = async () => {
    if (!items.length) return;
    setUploading(true);
    const result: DocumentUploadResult = { uploaded: [], failed: [] };
    for (const item of items) {
      const form = new FormData();
      form.append("document_type", item.type);
      form.append("file", item.file);
      try {
        await api.post(`/tenants/${tenantId}/cases/${caseId}/artifacts`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120_000,
        });
        result.uploaded.push(item.type);
      } catch (e: any) {
        result.failed.push({
          type: item.type,
          reason: `${item.file.name}: ${e?.response?.data?.detail ?? e?.message ?? "Upload failed"}`,
        });
      }
    }
    setUploading(false);
    onDone(result);
  };

  const covered = new Set(items.map((i) => i.type));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      // A click on the dim background closes the popup only while nothing is
      // chosen. Once files are picked it must not: the system file picker can
      // leave a stray click behind when it closes (e.g. after a double-click on a
      // file), which would otherwise dismiss the popup and throw the files away.
      // Cancel and ✕ still close it.
      onClick={uploading || items.length > 0 ? undefined : onClose}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-slate-800">Upload documents</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {caseNumber ? `Case ${caseNumber} · ` : ""}PDF, PNG or JPG — choose several at once
            </p>
          </div>
          <button onClick={onClose} disabled={uploading} className="text-slate-400 hover:text-slate-600 p-1 -mr-1">✕</button>
        </div>

        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
          {/* What this case still needs, ticked as files are matched to it */}
          <div className="flex flex-wrap gap-2">
            {documentTypes.map((t) => (
              <span
                key={t}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                  covered.has(t)
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-slate-50 text-slate-500 border-slate-200"
                }`}
              >
                {covered.has(t) ? "✓ " : ""}{t}
              </span>
            ))}
          </div>

          <div
            onDragOver={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
            }}
            onClick={() => !uploading && inputRef.current?.click()}
            className={`rounded-xl border-2 cursor-pointer transition-all px-4 py-6 flex flex-col items-center gap-1.5 ${
              dragging ? "border-blue-400 bg-blue-50" : "border-dashed border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/40"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
            />
            <p className="text-sm font-semibold text-slate-700">
              Drop files here or <span className="text-blue-600">browse</span>
            </p>
            <p className="text-[11px] text-slate-400">PDF · PNG · JPG — select as many as you need</p>
          </div>

          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((item, i) => (
                <li key={`${item.file.name}-${i}`} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <span className="truncate text-sm text-slate-700 flex-1" title={item.file.name}>{item.file.name}</span>
                  <button
                    type="button"
                    onClick={() => openPreview(item.file)}
                    title={`View ${item.file.name}`}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-blue-700 bg-white border border-blue-200 rounded-md hover:bg-blue-50 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
                    View
                  </button>
                  <select
                    value={item.type}
                    disabled={uploading}
                    onChange={(e) => setItems((prev) => prev.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                    className="w-40 bg-white border border-slate-200 rounded-md px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400"
                  >
                    {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-red-500 flex-shrink-0 px-1"
                    title="Remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            {items.length
              ? `${items.length} file${items.length > 1 ? "s" : ""} ready`
              : "No files chosen yet"}
          </p>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={uploading}
              className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!items.length || uploading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-all"
            >
              {uploading && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
              {uploading ? "Uploading…" : `Upload${items.length ? ` (${items.length})` : ""}`}
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 p-4"
          onClick={(e) => { e.stopPropagation(); closePreview(); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-800 truncate" title={preview.name}>{preview.name}</p>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={preview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-semibold text-blue-700 hover:underline"
                >
                  Open in new tab
                </a>
                <button onClick={closePreview} className="text-slate-400 hover:text-slate-600 p-1" title="Close preview">✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-slate-100 flex items-center justify-center min-h-[40vh]">
              {preview.isPdf ? (
                <iframe src={preview.url} title={preview.name} className="w-full h-[70vh] border-0 bg-white" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview.url} alt={preview.name} className="max-w-full max-h-[70vh] object-contain" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
