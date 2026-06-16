"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { ocrApi } from "@/app/services/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Status = "idle" | "ready" | "processing" | "done" | "error";

interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

const SUPPORTED = ["pdf", "png", "jpg", "jpeg", "tiff", "bmp"] as const;
const IMAGE_PREVIEW = ["png", "jpg", "jpeg", "bmp"];

// Gemini 2.5 Flash pricing (per 1M tokens)
const PRICE_INPUT_PER_M  = 0.15;
const PRICE_OUTPUT_PER_M = 0.60;

function calcCost(usage: TokenUsage) {
  const input  = (usage.input  / 1_000_000) * PRICE_INPUT_PER_M;
  const output = (usage.output / 1_000_000) * PRICE_OUTPUT_PER_M;
  return { input, output, total: input + output };
}

function getExt(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10 text-slate-400">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 text-blue-400">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── Document Preview ──────────────────────────────────────────────────────────

function DocumentPreview({ file, objectURL }: { file: File; objectURL: string }) {
  const ext = getExt(file.name);

  if (ext === "pdf") {
    return (
      <iframe
        src={objectURL}
        title="PDF Preview"
        className="w-full h-full rounded-lg border border-slate-200 bg-white"
      />
    );
  }

  if (IMAGE_PREVIEW.includes(ext)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={objectURL}
        alt="Document preview"
        className="w-full h-full object-contain rounded-lg"
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full text-slate-500">
      <FileIcon />
      <p className="text-sm font-medium text-slate-700">{file.name}</p>
      <p className="text-xs text-slate-400">
        {ext.toUpperCase()} — browser preview not available
      </p>
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<Status, { label: string; color: string; dot: string }> = {
  idle:       { label: "Awaiting upload",   color: "text-slate-500 bg-slate-100",             dot: "bg-slate-400" },
  ready:      { label: "Ready to process",  color: "text-amber-700 bg-amber-50 border-amber-200",  dot: "bg-amber-400" },
  processing: { label: "Processing…",       color: "text-blue-700 bg-blue-50 border-blue-200",     dot: "bg-blue-400 animate-pulse" },
  done:       { label: "Extraction done",   color: "text-emerald-700 bg-emerald-50 border-emerald-200", dot: "bg-emerald-400" },
  error:      { label: "Error",             color: "text-red-700 bg-red-50 border-red-200",         dot: "bg-red-400" },
};

function StatusBadge({ status }: { status: Status }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${cfg.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OcrPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [objectURL, setObjectURL] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
    }

    if (files.length > 0) {
      const first = files[0];
      setPreviewFile(first);
      setObjectURL(URL.createObjectURL(first));
    } else {
      setPreviewFile(null);
      setObjectURL(null);
    }

    return () => {
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
      }
    };
  }, [files]);

  const selectFiles = useCallback((pickedFiles: FileList | File[]) => {
    const fileArray = Array.from(pickedFiles);
    if (fileArray.length === 0) return;

    const invalid = fileArray.filter((file) => {
      const ext = getExt(file.name);
      return !(SUPPORTED as readonly string[]).includes(ext);
    });

    if (invalid.length > 0) {
      setError(
        `Unsupported format "${getExt(invalid[0].name)}". Accepted: ${SUPPORTED.join(", ").toUpperCase()}`
      );
      setStatus("error");
      return;
    }

    setFiles(fileArray);
    setStatus("ready");
    setResult(null);
    setTokenUsage(null);
    setError(null);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      selectFiles(e.dataTransfer.files);
    }
  }, [selectFiles]);

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      selectFiles(e.target.files);
    }
    e.target.value = "";
  };

  const removeFile = (index: number) => {
    setFiles((current: File[]) => {
      const next = current.filter((_, i) => i !== index);
      if (next.length === 0) {
        setStatus("idle");
      }
      return next;
    });
  };

  const runOCR = async () => {
    if (files.length === 0) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setTokenUsage(null);

    try {
      const extractedSections: string[] = [];
      const totalUsage = { input: 0, output: 0, total: 0 };

      for (const selectedFile of files) {
        const form = new FormData();
        form.append("file", selectedFile);

        const res = await ocrApi.post<{
          filename: string;
          extracted_text: string;
          token_usage: TokenUsage;
        }>("/extract", form);

        extractedSections.push(`=== ${selectedFile.name} ===\n${res.data.extracted_text}`);
        totalUsage.input += res.data.token_usage.input;
        totalUsage.output += res.data.token_usage.output;
        totalUsage.total += res.data.token_usage.total;
      }

      setResult(extractedSections.join("\n\n"));
      setTokenUsage(totalUsage);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "OCR processing failed.");
      setStatus("error");
    }
  };

  const copyToClipboard = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setFiles([]);
    setStatus("idle");
    setResult(null);
    setTokenUsage(null);
    setError(null);
  };

  const wordCount = result ? result.trim().split(/\s+/).filter(Boolean).length : 0;
  const charCount = result ? result.length : 0;

  return (
    <div className="flex flex-col h-full p-6 gap-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">OCR Engine</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload an insurance document to extract text using Gemini 2.5 Flash.
          </p>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* ── Main grid ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 gap-6 min-h-0">

        {/* ── Left panel: Upload + Preview ──────────────────────────────── */}
        <div className="flex flex-col gap-4 w-[420px] flex-shrink-0">

          {/* Upload zone */}
          <div
            className={`
              relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed
              transition-colors duration-150 cursor-pointer
              ${isDragging
                ? "border-blue-400 bg-blue-50"
                : files.length > 0
                  ? "border-slate-300 bg-slate-50 hover:border-blue-300"
                  : "border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"
              }
              ${files.length > 0 ? "py-4" : "py-10"}
            `}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            aria-label="Upload document"
          >
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
              multiple
              onChange={handleInputChange}
            />
            {files.length > 0 ? (
              <div className="w-full">
                <div className="flex items-center gap-3 px-4">
                  <FileIcon />
                  <div className="overflow-hidden">
                    <p className="text-sm font-semibold text-slate-800 truncate">
                      {files.length} document{files.length === 1 ? "" : "s"} selected
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {files.length} file{files.length === 1 ? "" : "s"} · {getExt(files[0].name).toUpperCase()}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); reset(); }}
                    className="ml-auto flex-shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Clear all files"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div className="mt-3 space-y-2 px-4">
                  {files.map((f, index) => (
                    <div key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <div className="min-w-[48px]">
                        <span className="text-xs font-medium text-slate-500">{getExt(f.name).toUpperCase()}</span>
                      </div>
                      <div className="min-w-0 overflow-hidden">
                        <p className="text-sm font-medium text-slate-700 truncate">{f.name}</p>
                        <p className="text-xs text-slate-400">
                          {(f.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                        className="ml-auto flex-shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title={`Remove ${f.name}`}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <UploadIcon />
                <div className="text-center">
                  <p className="text-sm font-semibold text-slate-700">
                    Drop documents here, or{" "}
                    <span className="text-blue-600 underline underline-offset-2">browse</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    PDF, PNG, JPG, JPEG, TIFF, BMP
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Document preview */}
          <div className="flex-1 min-h-0 rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            {previewFile && objectURL ? (
              <div className="w-full h-full p-2">
                <DocumentPreview file={previewFile} objectURL={objectURL} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10 opacity-40">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <line x1="10" y1="9" x2="8" y2="9" />
                </svg>
                <p className="text-xs font-medium">Document preview will appear here</p>
              </div>
            )}
          </div>

          {/* Run button */}
          <button
            onClick={runOCR}
            disabled={files.length === 0 || status === "processing"}
            className={`
              w-full flex items-center justify-center gap-2.5 py-3 px-5 rounded-xl
              text-sm font-semibold tracking-wide transition-all duration-150
              ${files.length === 0 || status === "processing"
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700 shadow-md hover:shadow-lg active:scale-[0.98]"
              }
            `}
          >
            {status === "processing" ? (
              <>
                <SpinnerIcon />
                Running OCR Engine…
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                Run OCR Engine
              </>
            )}
          </button>
        </div>

        {/* ── Right panel: Extracted Text ────────────────────────────────── */}
        <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">

          {/* Panel header */}
          <div className="flex flex-col border-b border-slate-100">
            <div className="flex items-center justify-between px-5 py-3.5">
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-500">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <span className="text-sm font-semibold text-slate-700">Extracted Text</span>
              </div>
              {result && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400">
                    {wordCount.toLocaleString()} words · {charCount.toLocaleString()} chars
                  </span>
                  <button
                    onClick={copyToClipboard}
                    className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg
                      border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300
                      transition-colors"
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              )}
            </div>

            {/* Token usage + cost bar */}
            {tokenUsage && (() => {
              const cost = calcCost(tokenUsage);
              const totalTokens = tokenUsage.input + tokenUsage.output;
              const fmt  = (n: number) => n < 0.000001 ? "<$0.000001" : `$${n.toFixed(6)}`;
              return (
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">

                  {/* Tokens section */}
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center gap-1.5">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-violet-500">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                      </svg>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Tokens</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                        <span className="text-slate-500">In</span>
                        <span className="font-semibold text-slate-800">{tokenUsage.input.toLocaleString()}</span>
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        <span className="text-slate-500">Out</span>
                        <span className="font-semibold text-slate-800">{tokenUsage.output.toLocaleString()}</span>
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                        <span className="text-slate-500">Total</span>
                        <span className="font-semibold text-slate-800">{totalTokens.toLocaleString()}</span>
                      </span>
                    </div>
                  </div>

                  <span className="h-3 w-px bg-slate-200 hidden sm:block" />

                  {/* Cost section */}
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center gap-1.5">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-amber-500">
                        <line x1="12" y1="1" x2="12" y2="23" />
                        <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
                      </svg>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Cost</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                        <span className="text-slate-500">In</span>
                        <span className="font-semibold text-slate-700">{fmt(cost.input)}</span>
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        <span className="text-slate-500">Out</span>
                        <span className="font-semibold text-slate-700">{fmt(cost.output)}</span>
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span className="text-slate-500">Total</span>
                        <span className="font-bold text-amber-700">{fmt(cost.total)}</span>
                      </span>
                    </div>
                  </div>

                </div>
              );
            })()}
          </div>

          {/* Panel body */}
          <div className="flex-1 min-h-0 overflow-auto p-5">
            {status === "idle" && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 opacity-30">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <p className="text-sm font-medium">Upload a document and run OCR to see results</p>
              </div>
            )}

            {status === "ready" && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 opacity-40">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <p className="text-sm font-medium text-slate-500">
                  Document ready — click <span className="font-bold text-blue-600">Run OCR Engine</span> to extract text
                </p>
              </div>
            )}

            {status === "processing" && (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <div className="relative">
                  <div className="w-14 h-14 rounded-full border-4 border-blue-100 border-t-blue-500 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
                  </div>
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-slate-700">Gemini 2.5 Flash is reading your document…</p>
                  <p className="text-xs text-slate-400 mt-1">This may take a few seconds</p>
                </div>
              </div>
            )}

            {status === "error" && error && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-red-500">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                </div>
                <div className="text-center max-w-sm">
                  <p className="text-sm font-semibold text-red-700">OCR Failed</p>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">{error}</p>
                </div>
                <button
                  onClick={runOCR}
                  className="mt-2 text-xs font-semibold text-blue-600 hover:text-blue-700 underline underline-offset-2"
                >
                  Try again
                </button>
              </div>
            )}

            {status === "done" && result && (
              <pre className="text-sm text-slate-800 whitespace-pre-wrap break-words leading-relaxed font-mono">
                {result}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
