"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import api from "@/app/services/api";

// The same guided upload the case page shows in pre-underwriting (frontend/app/case/[id]/page.tsx, UploadModal):
// one card per document the plan requires, marked Complete once the case has it, drop or browse onto the card a file
// belongs to, an "Additional document" card, a progress header, and a preview. Opened from the chat so the two
// places look and behave alike. Files go to the same endpoint, so the case page picks them up unchanged.

const SUPPORTED_EXTS = ["pdf", "png", "jpg", "jpeg", "tiff", "bmp"];
const EXTRA_DOC_TYPES = ["Bank Statement", "Tax Return", "X-Ray", "MRI Scan", "Policy Form", "Child's Birth Certificate", "Other"];

export interface DocumentUploadResult {
  uploaded: string[];
  failed: { type: string; reason: string }[];
}

interface Item {
  file: File;
  type: string;
}

function Spinner({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`} />;
}

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
  /** The documents the case is still missing (what the chat asked for). */
  documentTypes: string[];
  onClose: () => void;
  onDone: (result: DocumentUploadResult) => void;
}) {
  // All the documents the plan requires, and which of them the case still lacks. The chat only passes the missing
  // ones, so the full list is read from the case; until it arrives the missing ones stand in for both.
  const [docTypes, setDocTypes] = useState<string[]>(documentTypes);
  const [missingTypes, setMissingTypes] = useState<string[]>(documentTypes);
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/tenants/${tenantId}/cases/${caseId}/detail`)
      .then((res) => {
        if (cancelled) return;
        const checklist = res.data?.document_checklist;
        const required: string[] = checklist?.required ?? [];
        if (required.length) {
          setDocTypes(required);
          setMissingTypes(checklist?.missing ?? documentTypes);
        }
      })
      .catch(() => { /* keep what the chat passed in */ });
    return () => { cancelled = true; };
  }, [tenantId, caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [fileItems, setFileItems] = useState<Item[]>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [extraType, setExtraType] = useState(() => EXTRA_DOC_TYPES.find((t) => !documentTypes.includes(t)) ?? "Other");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  // Preview of a chosen file, read locally: nothing is uploaded to view it.
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

  const missing = new Set(missingTypes);
  const isComplete = (t: string) => !missing.has(t) || fileItems.some((i) => i.type === t);
  const doneCount = docTypes.filter((t) => !missing.has(t)).length;
  const nextMissing = docTypes.find((t) => missing.has(t) && !fileItems.some((i) => i.type === t));

  const addFiles = (newFiles: FileList | File[], type: string) => {
    setErr("");
    const valid: Item[] = [];
    Array.from(newFiles).forEach((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED_EXTS.includes(ext)) {
        setErr(`Unsupported format ".${ext}". Allowed: ${SUPPORTED_EXTS.join(", ").toUpperCase()}`);
        return;
      }
      valid.push({ file: f, type });
    });
    setFileItems((prev) => [...prev, ...valid]);
  };

  const submit = async () => {
    if (fileItems.length === 0) return;
    setUploading(true);
    setErr("");
    const result: DocumentUploadResult = { uploaded: [], failed: [] };
    for (const item of fileItems) {
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
        result.failed.push({ type: item.type, reason: `${item.file.name}: ${e?.response?.data?.detail ?? e?.message ?? "Upload failed"}` });
      }
    }
    setUploading(false);
    onDone(result);
  };

  const dropProps = (type: string) => ({
    onDragOver: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(type); },
    onDragLeave: () => setDragOver((d) => (d === type ? null : d)),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(null);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files, type);
    },
  });

  const stagedList = (type: string) => {
    const items = fileItems.map((item, i) => ({ item, i })).filter(({ item }) => item.type === type);
    if (!items.length) return null;
    return (
      <ul className="mt-2.5 space-y-1.5">
        {items.map(({ item, i }) => (
          <li key={i} className="flex items-center gap-2 text-[11px] bg-white border border-slate-200 rounded-md px-2 py-1.5">
            <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
            <span className="truncate text-slate-700 flex-1" title={item.file.name}>{item.file.name}</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); openPreview(item.file); }} className="text-blue-600 font-semibold hover:underline flex-shrink-0">View</button>
            <button type="button" onClick={(e) => { e.stopPropagation(); setFileItems((prev) => prev.filter((_, j) => j !== i)); }} className="text-slate-400 hover:text-red-500 flex-shrink-0" title="Remove">✕</button>
          </li>
        ))}
      </ul>
    );
  };

  const fileInput = (type: string) => (
    <input
      ref={(el) => { inputs.current[type] = el; }}
      type="file"
      className="sr-only"
      accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
      multiple
      onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addFiles(e.target.files, type); e.target.value = ""; }}
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden my-8" onClick={(e) => e.stopPropagation()}>
        {/* Header with progress */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-800">
              Upload Documents{caseNumber ? <span className="ml-2 text-xs font-medium text-slate-400">{caseNumber}</span> : null}
            </h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 -mr-1" aria-label="Close">✕</button>
          </div>
          {docTypes.length > 0 ? (
            <div className="mt-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600">
                  <span className="font-bold text-slate-800">{doneCount} of {docTypes.length}</span> required documents complete
                </span>
                {nextMissing ? (
                  <span className="text-amber-700 font-semibold">Next: {nextMissing}</span>
                ) : (
                  <span className="text-emerald-600 font-semibold">All required documents covered</span>
                )}
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(doneCount / docTypes.length) * 100}%` }} />
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500 mt-1">This plan doesn&apos;t require specific documents — add any supporting files below.</p>
          )}
        </div>

        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
          {/* One card per required document */}
          {docTypes.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {docTypes.map((type) => {
                const alreadyHave = !missing.has(type);
                const complete = isComplete(type);
                const isNext = type === nextMissing;
                const staged = fileItems.some((i) => i.type === type);
                return (
                  <div
                    key={type}
                    {...dropProps(type)}
                    onClick={() => inputs.current[type]?.click()}
                    className={`relative rounded-xl border-2 p-3.5 cursor-pointer transition-all ${
                      dragOver === type
                        ? "border-blue-400 bg-blue-50"
                        : complete
                        ? "border-emerald-200 bg-emerald-50/50 hover:border-emerald-300"
                        : isNext
                        ? "border-amber-300 bg-amber-50/50 hover:border-amber-400 ring-2 ring-amber-200/60"
                        : "border-dashed border-slate-300 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/30"
                    }`}
                  >
                    {fileInput(type)}
                    <div className="flex items-start gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${complete ? "bg-emerald-500 text-white" : "bg-white border border-slate-200 text-slate-400"}`}>
                        {complete ? (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                        ) : (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-slate-800">{type}</p>
                          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                            alreadyHave ? "bg-emerald-100 text-emerald-700" : staged ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"
                          }`}>
                            {alreadyHave ? "Complete" : staged ? "Ready to upload" : "Required"}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {alreadyHave
                            ? "Already on file — drop here to add a newer copy."
                            : staged
                            ? "Will be uploaded when you press Upload."
                            : "Drop the file here or click to browse."}
                        </p>
                      </div>
                    </div>
                    {stagedList(type)}
                  </div>
                );
              })}
            </div>
          )}

          {/* Anything else */}
          <div
            {...dropProps(extraType)}
            onClick={() => inputs.current[extraType]?.click()}
            className={`rounded-xl border-2 border-dashed p-3.5 cursor-pointer transition-all ${dragOver === extraType ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-blue-300 hover:bg-blue-50/30"}`}
          >
            {fileInput(extraType)}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white border border-slate-200 text-slate-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-700">Additional document</p>
                <p className="text-[11px] text-slate-500">Optional supporting files — choose the type, then drop or click.</p>
              </div>
              <select
                value={extraType}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setExtraType(e.target.value)}
                className="bg-white border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-700 focus:outline-none focus:border-blue-400"
              >
                {EXTRA_DOC_TYPES.filter((t) => !docTypes.includes(t)).map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            {EXTRA_DOC_TYPES.filter((t) => !docTypes.includes(t)).map((t) => <div key={t}>{stagedList(t)}</div>)}
          </div>

          <p className="text-[10px] text-slate-400 text-center">PDF · PNG · JPG · JPEG · TIFF · BMP — each file is read by OCR after upload.</p>

          {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-line">{err}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {fileItems.length ? `${fileItems.length} file${fileItems.length === 1 ? "" : "s"} ready` : "No files added yet"}
          </span>
          <div className="flex gap-3">
            <button onClick={onClose} disabled={uploading} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancel</button>
            <button onClick={submit} disabled={fileItems.length === 0 || uploading} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-all">
              {uploading ? <Spinner /> : null}
              {uploading ? "Uploading…" : `Upload${fileItems.length ? ` ${fileItems.length}` : ""} & OCR`}
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 p-4"
          onClick={(e) => { e.stopPropagation(); closePreview(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-800 truncate" title={preview.name}>{preview.name}</p>
              <div className="flex items-center gap-3 flex-shrink-0">
                <a href={preview.url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-blue-700 hover:underline">Open in new tab</a>
                <button type="button" onClick={closePreview} className="text-slate-400 hover:text-slate-600 p-1" title="Close preview">✕</button>
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
