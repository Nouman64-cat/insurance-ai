"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import { OCR_BASE_URL, SUMMARIZER_BASE_URL } from "@/app/services/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type OcrStatus = "idle" | "ready" | "processing" | "done" | "error";
type SummaryStatus = "idle" | "processing" | "done" | "error";
type ActiveTab = "extracted" | "summary";

interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

const SUPPORTED = ["pdf", "png", "jpg", "jpeg", "tiff", "bmp"] as const;
const IMAGE_PREVIEW = ["png", "jpg", "jpeg", "bmp"];

const PRICE_INPUT_PER_M = 0.15;
const PRICE_OUTPUT_PER_M = 0.6;

function calcCost(usage: TokenUsage) {
  const i = (usage.input / 1_000_000) * PRICE_INPUT_PER_M;
  const o = (usage.output / 1_000_000) * PRICE_OUTPUT_PER_M;
  return { input: i, output: o, total: i + o };
}

function getExt(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function fmtSize(bytes: number) {
  return bytes < 1_048_576
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function fmtCost(n: number) {
  return n < 0.000001 ? "<$0.000001" : `$${n.toFixed(6)}`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SpinnerIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ── Extension style map ───────────────────────────────────────────────────────

const EXT_STYLE: Record<string, { chip: string; icon: string; glyph: string }> =
{
  pdf: {
    chip: "bg-red-100 text-red-700",
    icon: "text-red-400",
    glyph: "PDF",
  },
  png: {
    chip: "bg-sky-100 text-sky-700",
    icon: "text-sky-400",
    glyph: "PNG",
  },
  jpg: {
    chip: "bg-amber-100 text-amber-700",
    icon: "text-amber-400",
    glyph: "JPG",
  },
  jpeg: {
    chip: "bg-amber-100 text-amber-700",
    icon: "text-amber-400",
    glyph: "JPG",
  },
  tiff: {
    chip: "bg-teal-100 text-teal-700",
    icon: "text-teal-400",
    glyph: "TIF",
  },
  bmp: {
    chip: "bg-purple-100 text-purple-700",
    icon: "text-purple-400",
    glyph: "BMP",
  },
};

function extStyle(ext: string) {
  return (
    EXT_STYLE[ext] ?? {
      chip: "bg-slate-100 text-slate-600",
      icon: "text-slate-400",
      glyph: ext.toUpperCase().slice(0, 3),
    }
  );
}

// ── Doc card (in queue) ───────────────────────────────────────────────────────

function DocCard({
  file,
  index,
  isActive,
  onSelect,
  onRemove,
}: {
  file: File;
  index: number;
  isActive: boolean;
  onSelect: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  const ext = getExt(file.name);
  const s = extStyle(ext);

  return (
    <div
      className={`
        relative flex-shrink-0 w-[92px] flex flex-col rounded-xl border-2 cursor-pointer
        transition-all duration-200 group overflow-hidden
        ${isActive
          ? "border-blue-400 bg-blue-50 shadow-md shadow-blue-100"
          : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
        }
      `}
      onClick={() => onSelect(index)}
      role="button"
      aria-label={file.name}
    >
      {/* Remove button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(index);
        }}
        className={`
          absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full flex items-center justify-center
          transition-all duration-150
          ${isActive
            ? "bg-blue-200 text-blue-700 opacity-100"
            : "bg-slate-200 text-slate-500 opacity-0 group-hover:opacity-100"
          }
          hover:bg-red-100 hover:text-red-600
        `}
        title={`Remove ${file.name}`}
      >
        <XIcon className="w-2 h-2" />
      </button>

      {/* Ext chip */}
      <div className="px-2 pt-2.5">
        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${s.chip}`}
        >
          {s.glyph}
        </span>
      </div>

      {/* Doc icon */}
      <div className={`flex items-center justify-center py-2 ${s.icon}`}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-9 h-9"
        >
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </div>

      {/* Name + size */}
      <div className="px-2 pb-2.5 flex flex-col gap-0.5">
        <p
          className={`text-[10px] font-semibold leading-tight line-clamp-2 ${isActive ? "text-blue-700" : "text-slate-700"}`}
        >
          {file.name}
        </p>
        <p className="text-[9px] text-slate-400">{fmtSize(file.size)}</p>
      </div>

      {/* Active indicator bar */}
      {isActive && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400 rounded-b-xl" />
      )}
    </div>
  );
}

// ── Upload card (always last in queue) ────────────────────────────────────────

function UploadCard({
  onClick,
  isDragging,
}: {
  onClick: () => void;
  isDragging: boolean;
}) {
  return (
    <div
      onClick={onClick}
      role="button"
      aria-label="Add document"
      className={`
        flex-shrink-0 w-[92px] flex flex-col items-center justify-center gap-1.5
        rounded-xl border-2 border-dashed cursor-pointer transition-all duration-150
        ${isDragging
          ? "border-blue-400 bg-blue-50"
          : "border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/50"
        }
      `}
    >
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors
        ${isDragging ? "bg-blue-200 text-blue-600" : "bg-slate-200 text-slate-500 group-hover:bg-blue-100 group-hover:text-blue-600"}`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </div>
      <p className="text-[10px] font-semibold text-slate-500 text-center leading-tight px-1">
        Add doc
      </p>
    </div>
  );
}

// ── Document Preview ──────────────────────────────────────────────────────────

function DocumentPreview({
  file,
  objectURL,
}: {
  file: File;
  objectURL: string;
}) {
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
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={objectURL}
        alt="Document preview"
        className="w-full h-full object-contain rounded-lg"
      />
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 h-full text-slate-400">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-10 h-10 opacity-30"
      >
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <p className="text-xs font-medium text-slate-600">{file.name}</p>
      <p className="text-xs text-slate-400">
        {ext.toUpperCase()} — no browser preview
      </p>
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────────────

const OCR_STATUS: Record<
  OcrStatus,
  { label: string; color: string; dot: string }
> = {
  idle: {
    label: "Awaiting upload",
    color: "text-slate-500 bg-slate-100 border-slate-200",
    dot: "bg-slate-400",
  },
  ready: {
    label: "Ready to process",
    color: "text-amber-700 bg-amber-50 border-amber-200",
    dot: "bg-amber-400",
  },
  processing: {
    label: "Processing…",
    color: "text-blue-700 bg-blue-50 border-blue-200",
    dot: "bg-blue-400 animate-pulse",
  },
  done: {
    label: "Extraction done",
    color: "text-emerald-700 bg-emerald-50 border-emerald-200",
    dot: "bg-emerald-400",
  },
  error: {
    label: "Error",
    color: "text-red-700 bg-red-50 border-red-200",
    dot: "bg-red-400",
  },
};

function OcrStatusBadge({ status }: { status: OcrStatus }) {
  const cfg = OCR_STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${cfg.color}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Token / Cost Bar ──────────────────────────────────────────────────────────

function TokenCostBar({ usage }: { usage: TokenUsage }) {
  const cost = calcCost(usage);
  const displayTotal = usage.input + usage.output;

  return (
    <div className="border-t border-slate-100 bg-slate-50 px-5 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3 h-3 text-violet-500"
          >
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            Tokens
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="text-slate-500">In</span>
            <span className="font-semibold text-slate-800">
              {usage.input.toLocaleString()}
            </span>
          </span>
          <span className="text-slate-300">·</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-slate-500">Out</span>
            <span className="font-semibold text-slate-800">
              {usage.output.toLocaleString()}
            </span>
          </span>
          <span className="text-slate-300">·</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
            <span className="text-slate-500">Total</span>
            <span className="font-semibold text-slate-800">
              {displayTotal.toLocaleString()}
            </span>
          </span>
        </div>
      </div>
      <span className="h-3 w-px bg-slate-200 hidden sm:block" />
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3 h-3 text-amber-500"
          >
            <line x1="12" y1="1" x2="12" y2="23" />
            <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
          </svg>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            Cost
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="text-slate-500">In</span>
            <span className="font-semibold text-slate-700">
              {fmtCost(cost.input)}
            </span>
          </span>
          <span className="text-slate-300">·</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-slate-500">Out</span>
            <span className="font-semibold text-slate-700">
              {fmtCost(cost.output)}
            </span>
          </span>
          <span className="text-slate-300">·</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-slate-500">Total</span>
            <span className="font-bold text-amber-700">
              {fmtCost(cost.total)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OcrPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [objectURLs, setObjectURLs] = useState<Record<number, string>>({});
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>("idle");
  const [result, setResult] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrCopied, setOcrCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>("extracted");
  const [extractedDocuments, setExtractedDocuments] = useState<string[]>([]);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryTokenUsage, setSummaryTokenUsage] = useState<TokenUsage | null>(
    null,
  );
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [maxWords, setMaxWords] = useState("");
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const pdfReportRef = useRef<HTMLDivElement>(null);

  // Rebuild object-URL map whenever the file list changes
  useEffect(() => {
    Object.values(objectURLs).forEach(URL.revokeObjectURL);
    const map: Record<number, string> = {};
    files.forEach((f, i) => {
      map[i] = URL.createObjectURL(f);
    });
    setObjectURLs(map);
    return () => {
      Object.values(map).forEach(URL.revokeObjectURL);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // Scroll queue to the right when new files are added
  useEffect(() => {
    if (queueRef.current && files.length > 0) {
      queueRef.current.scrollTo({
        left: queueRef.current.scrollWidth,
        behavior: "smooth",
      });
    }
  }, [files.length]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const arr = Array.from(incoming);
    const invalid = arr.filter(
      (f) => !(SUPPORTED as readonly string[]).includes(getExt(f.name)),
    );
    if (invalid.length > 0) {
      setOcrError(
        `Unsupported: "${getExt(invalid[0].name)}". Accepted: ${SUPPORTED.join(", ").toUpperCase()}`,
      );
      setOcrStatus("error");
      return;
    }
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => `${f.name}-${f.size}`));
      const fresh = arr.filter((f) => !existing.has(`${f.name}-${f.size}`));
      return [...prev, ...fresh];
    });
    setOcrStatus("ready");
    setResult(null);
    setTokenUsage(null);
    setOcrError(null);
    setSummary(null);
    setSummaryTokenUsage(null);
    setSummaryStatus("idle");
    setSummaryError(null);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = "";
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        setOcrStatus("idle");
        setPreviewIdx(0);
      } else setPreviewIdx((p) => Math.min(p, next.length - 1));
      return next;
    });
  };

  const reset = () => {
    setFiles([]);
    setPreviewIdx(0);
    setOcrStatus("idle");
    setResult(null);
    setTokenUsage(null);
    setOcrError(null);
    setExtractedDocuments([]);
    setSummary(null);
    setSummaryTokenUsage(null);
    setSummaryStatus("idle");
    setSummaryError(null);
    setActiveTab("extracted");
  };

  const runOCR = async () => {
    if (!files.length) return;
    setOcrStatus("processing");
    setOcrError(null);
    setResult(null);
    setTokenUsage(null);
    setSummary(null);
    setSummaryTokenUsage(null);
    setSummaryStatus("idle");

    try {
      const sections: string[] = [];
      const documents: string[] = [];
      const total = { input: 0, output: 0, total: 0 };

      for (const f of files) {
        const form = new FormData();
        form.append("file", f);

        const response = await fetch(`${OCR_BASE_URL}/extract/stream`, {
          method: "POST",
          body: form,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => response.statusText);
          throw new Error(detail || "OCR request failed");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fileText = "";
        let fileDone = false;

        while (!fileDone) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // SSE events are separated by double newlines
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;

            let evt: { type: string; text?: string; token_usage?: TokenUsage; message?: string };
            try {
              evt = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (evt.type === "chunk" && evt.text) {
              fileText += evt.text;
              // Show completed files + current file streaming live
              setResult([...sections, `=== ${f.name} ===\n${fileText}`].join("\n\n"));
            } else if (evt.type === "done" && evt.token_usage) {
              total.input += evt.token_usage.input;
              total.output += evt.token_usage.output;
              total.total += evt.token_usage.total;
              fileDone = true;
            } else if (evt.type === "error") {
              throw new Error(evt.message ?? "OCR processing failed.");
            }
          }
        }

        sections.push(`=== ${f.name} ===\n${fileText}`);
        documents.push(fileText);
      }

      setExtractedDocuments(documents);
      setResult(sections.join("\n\n"));
      setTokenUsage(total);
      setOcrStatus("done");
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : "OCR processing failed.");
      setOcrStatus("error");
    }
  };

  const runSummarizer = async () => {
    if (!extractedDocuments.length) return;
    setSummaryStatus("processing");
    setSummaryError(null);
    setSummary(null);
    setSummaryTokenUsage(null);
    setActiveTab("summary");

    try {
      const body: { documents: string[]; max_words?: number } = {
        documents: extractedDocuments,
      };
      const parsed = parseInt(maxWords, 10);
      if (!isNaN(parsed) && parsed > 0) body.max_words = parsed;

      const response = await fetch(`${SUMMARIZER_BASE_URL}/summarize/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => response.statusText);
        throw new Error(detail || "Summarization request failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let summaryText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;

          let evt: { type: string; text?: string; token_usage?: TokenUsage; message?: string };
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (evt.type === "chunk" && evt.text) {
            summaryText += evt.text;
            setSummary(summaryText);
          } else if (evt.type === "done" && evt.token_usage) {
            setSummaryTokenUsage(evt.token_usage);
            setSummaryStatus("done");
          } else if (evt.type === "error") {
            throw new Error(evt.message ?? "Summarization failed.");
          }
        }
      }
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Summarization failed.");
      setSummaryStatus("error");
    }
  };

  const copyOcr = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    setOcrCopied(true);
    setTimeout(() => setOcrCopied(false), 2000);
  };

  const copySummary = async () => {
    if (!summary) return;
    await navigator.clipboard.writeText(summary);
    setSummaryCopied(true);
    setTimeout(() => setSummaryCopied(false), 2000);
  };

  const handleDownloadPdf = async () => {
    if (!summary || !pdfReportRef.current) return;
    setIsGeneratingPdf(true);

    const wrapper = pdfReportRef.current.parentElement as HTMLElement;

    try {
      // Reveal so html2canvas captures the full content
      wrapper.style.height = "auto";
      wrapper.style.overflow = "visible";
      wrapper.style.position = "fixed";
      wrapper.style.top = "-9999px";

      // Wait for all images to fully load before measuring positions
      await Promise.all(
        Array.from(pdfReportRef.current.querySelectorAll("img")).map(img =>
          (img as HTMLImageElement).complete
            ? Promise.resolve()
            : new Promise(r => { img.onload = r; img.onerror = r; })
        )
      );
      await new Promise(r => setTimeout(r, 80));

      // Record every image element's position relative to the container TOP,
      // in DOM pixels, before html2canvas runs. This is the ground truth we
      // use to avoid splitting — no pixel heuristics needed.
      const containerTop = pdfReportRef.current.getBoundingClientRect().top;
      const imgBandsDom = Array.from(pdfReportRef.current.querySelectorAll("img")).map(img => {
        const r = img.getBoundingClientRect();
        return { top: r.top - containerTop, bottom: r.bottom - containerTop };
      });

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas" as never) as Promise<{ default: (el: HTMLElement, opts: object) => Promise<HTMLCanvasElement> }>,
        import("jspdf") as Promise<{ jsPDF: new (opts: object) => { internal: { pageSize: { getWidth(): number; getHeight(): number } }; addPage(): void; addImage(d: string, f: string, x: number, y: number, w: number, h: number): void; save(n: string): void } }>,
      ]);

      const canvas = await html2canvas(pdfReportRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: 794,
        backgroundColor: "#ffffff",
      });

      const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();   // 210 mm
      const pageH = pdf.internal.pageSize.getHeight();  // 297 mm
      const margin = 15;
      const contentW = pageW - 2 * margin;  // 180 mm
      const contentH = pageH - 2 * margin;  // 267 mm

      const canvasW = canvas.width;
      const canvasH = canvas.height;
      const domScale = canvasW / 794; // matches html2canvas scale (2)
      const pageCanvasPx = (contentH / contentW) * canvasW;

      // Convert DOM image bands to canvas pixels with a small safety buffer
      const imgBands = imgBandsDom.map(b => ({
        top: Math.floor(b.top * domScale) - 8,
        bottom: Math.ceil(b.bottom * domScale) + 8,
      }));

      const ctx = canvas.getContext("2d")!;

      const findSafeSplitY = (startY: number, targetY: number): number => {
        // Pass 1 — DOM-aware: if the boundary lands inside an image element,
        // snap to just before that image. Never fooled by image content.
        for (const band of imgBands) {
          if (targetY > band.top && targetY < band.bottom) {
            const before = band.top - 4;
            if (before > startY) return before;
          }
        }

        // Pass 2 — pixel scan for text: walk backward up to 15% of the page
        // height looking for an all-light row (gap between paragraphs).
        // Rows that fall inside an image band are skipped so dark images
        // cannot confuse the scanner.
        const searchPx = Math.floor(pageCanvasPx * 0.15);
        for (let y = Math.floor(targetY); y >= Math.max(startY + 1, Math.floor(targetY - searchPx)); y--) {
          if (imgBands.some(b => y >= b.top && y <= b.bottom)) continue;
          const row = ctx.getImageData(0, y, canvasW, 1).data;
          let light = true;
          for (let i = 0; i < row.length; i += 4) {
            if (row[i] < 230 || row[i + 1] < 230 || row[i + 2] < 230) { light = false; break; }
          }
          if (light) return y;
        }

        return Math.floor(targetY);
      };

      let yPx = 0;
      let page = 0;
      while (yPx < canvasH) {
        if (page > 0) pdf.addPage();
        const targetEnd = Math.min(yPx + pageCanvasPx, canvasH);
        const splitY = targetEnd >= canvasH ? canvasH : findSafeSplitY(yPx, targetEnd);
        const sliceH = splitY - yPx;

        const slice = document.createElement("canvas");
        slice.width = canvasW;
        slice.height = Math.ceil(sliceH);
        const sCtx = slice.getContext("2d")!;
        sCtx.fillStyle = "#ffffff";
        sCtx.fillRect(0, 0, slice.width, slice.height);
        sCtx.drawImage(canvas, 0, yPx, canvasW, sliceH, 0, 0, canvasW, sliceH);

        const sliceHmm = (sliceH / pageCanvasPx) * contentH;
        pdf.addImage(slice.toDataURL("image/jpeg", 0.95), "JPEG", margin, margin, contentW, Math.min(sliceHmm, contentH));

        yPx = splitY;
        page++;
      }

      let filename = "AI_Summary.pdf";
      if (files.length > 0) {
        const cleanName = files[0].name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
        filename = files.length === 1
          ? `AI_Summary_${cleanName}.pdf`
          : `AI_Summary_${cleanName}_and_${files.length - 1}_others.pdf`;
      }

      pdf.save(filename);
    } catch (err) {
      console.error("Failed to generate PDF:", err);
      alert("Failed to generate PDF: " + (err as Error).message);
    } finally {
      wrapper.style.height = "0";
      wrapper.style.overflow = "hidden";
      wrapper.style.position = "absolute";
      wrapper.style.top = "0";
      setIsGeneratingPdf(false);
    }
  };

  const wordCount = result
    ? result.trim().split(/\s+/).filter(Boolean).length
    : 0;
  const charCount = result ? result.length : 0;
  const summaryWordCount = summary
    ? summary.trim().split(/\s+/).filter(Boolean).length
    : 0;

  const activeFile = files[previewIdx] ?? null;
  const activeURL = objectURLs[previewIdx] ?? null;

  return (
    <>
      <style>{`
        .queue-scroll::-webkit-scrollbar {
          height: 6px;
        }
        .queue-scroll::-webkit-scrollbar-track {
          background: rgb(241, 245, 249);
        }
        .queue-scroll::-webkit-scrollbar-thumb {
          background: rgb(203, 213, 225);
          border-radius: 3px;
        }
        .queue-scroll::-webkit-scrollbar-thumb:hover {
          background: rgb(148, 163, 184);
        }
      `}</style>
      <div className="flex flex-col h-full p-6 gap-5">
        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              OCR Engine
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Extract and summarize insurance documents using our OCR and AI
              processing pipeline.
            </p>
          </div>
          <OcrStatusBadge status={ocrStatus} />
        </div>

        {/* ── Main grid ───────────────────────────────────────────────────────── */}
        <div className="flex flex-1 gap-5 min-h-0">
          {/* ── Left panel ──────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 w-[360px] flex-shrink-0">
            {/* ── Document queue ──────────────────────────────────────────── */}
            <div
              className={`
              rounded-xl border-2 transition-colors duration-150
              ${isDragging
                  ? "border-blue-400 bg-blue-50"
                  : files.length === 0
                    ? "border-dashed border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/20"
                    : "border-slate-200 bg-white"
                }
            `}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
                multiple
                onChange={handleInputChange}
              />

              {files.length === 0 ? (
                /* Empty drop zone */
                <button
                  className="w-full flex flex-col items-center justify-center gap-2.5 py-8 cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-6 h-6 text-slate-400"
                    >
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-slate-700">
                      Drop documents here, or{" "}
                      <span className="text-blue-600 underline underline-offset-2">
                        browse
                      </span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      PDF · PNG · JPG · JPEG · TIFF · BMP
                    </p>
                  </div>
                </button>
              ) : (
                /* Loaded — horizontal scrollable card queue */
                <div className="p-2.5">
                  {/* Queue header */}
                  <div className="flex items-center justify-between mb-2 px-0.5">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      Queue · {files.length} doc{files.length !== 1 ? "s" : ""}
                    </span>
                    <button
                      onClick={reset}
                      className="text-[10px] font-semibold text-slate-400 hover:text-red-500 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>

                  {/* Scrollable card row */}
                  <div
                    ref={queueRef}
                    className="queue-scroll flex gap-2 overflow-x-auto pb-2 scroll-smooth"
                    style={{
                      scrollbarWidth: "thin",
                      scrollbarColor: "rgb(203, 213, 225) rgb(248, 250, 252)",
                    }}
                  >
                    {files.map((f, i) => (
                      <DocCard
                        key={`${f.name}-${f.size}-${f.lastModified}`}
                        file={f}
                        index={i}
                        isActive={i === previewIdx}
                        onSelect={setPreviewIdx}
                        onRemove={removeFile}
                      />
                    ))}

                    {/* Upload card — always last */}
                    <UploadCard
                      onClick={() => fileInputRef.current?.click()}
                      isDragging={isDragging}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ── Document preview ─────────────────────────────────────────── */}
            <div className="flex-1 min-h-0 rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
              {activeFile && activeURL ? (
                <>
                  {/* Preview label */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50">
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${extStyle(getExt(activeFile.name)).chip}`}
                    >
                      {extStyle(getExt(activeFile.name)).glyph}
                    </span>
                    <p className="text-xs font-medium text-slate-600 truncate flex-1">
                      {activeFile.name}
                    </p>
                    <span className="text-[10px] text-slate-400 flex-shrink-0">
                      {fmtSize(activeFile.size)}
                    </span>
                  </div>
                  <div className="w-full h-[calc(100%-33px)] p-2">
                    <DocumentPreview file={activeFile} objectURL={activeURL} />
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-400">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-10 h-10 opacity-25"
                  >
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                  <p className="text-xs font-medium">
                    Document preview will appear here
                  </p>
                </div>
              )}
            </div>

            {/* ── Action buttons ───────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <button
                onClick={runOCR}
                disabled={!files.length || ocrStatus === "processing"}
                className={`
                w-full flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl
                text-sm font-semibold tracking-wide transition-all duration-150
                ${!files.length || ocrStatus === "processing"
                    ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700 shadow-md hover:shadow-lg active:scale-[0.98]"
                  }
              `}
              >
                {ocrStatus === "processing" ? (
                  <>
                    <SpinnerIcon /> Running OCR Engine…
                  </>
                ) : (
                  <>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-4 h-4"
                    >
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Run OCR Engine
                    {files.length > 0 && (
                      <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500/30">
                        {files.length}
                      </span>
                    )}
                  </>
                )}
              </button>

              {ocrStatus === "done" && (
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={50}
                    max={2000}
                    placeholder="Max words (optional)"
                    value={maxWords}
                    onChange={(e) => setMaxWords(e.target.value)}
                    className="flex-1 min-w-0 text-sm py-2.5 px-3 rounded-xl border border-slate-200
                    bg-white text-slate-700 placeholder-slate-400
                    focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent"
                  />
                  <button
                    onClick={runSummarizer}
                    disabled={summaryStatus === "processing"}
                    className={`
                    flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl
                    text-sm font-semibold transition-all duration-150 flex-shrink-0
                    ${summaryStatus === "processing"
                        ? "bg-violet-100 text-violet-400 cursor-not-allowed"
                        : "bg-violet-600 text-white hover:bg-violet-700 shadow-md hover:shadow-lg active:scale-[0.98]"
                      }
                  `}
                  >
                    {summaryStatus === "processing" ? (
                      <SpinnerIcon />
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-4 h-4"
                      >
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                    )}
                    Summarize
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Right panel ─────────────────────────────────────────────────── */}
          <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            {/* Tab bar */}
            <div className="flex border-b border-slate-100">
              <button
                onClick={() => setActiveTab("extracted")}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === "extracted"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4"
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                Extracted Text
                {ocrStatus === "done" && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600">
                    {wordCount.toLocaleString()}w
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab("summary")}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === "summary"
                  ? "border-violet-500 text-violet-600"
                  : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                AI Summary
                {summaryStatus === "done" && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-600">
                    {summaryWordCount.toLocaleString()}w
                  </span>
                )}
              </button>

              <div className="ml-auto flex items-center gap-3 px-4">
                {activeTab === "extracted" && result && (
                  <>
                    <span className="text-xs text-slate-400">
                      {charCount.toLocaleString()} chars
                    </span>
                    <button
                      onClick={copyOcr}
                      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg
                      border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      {ocrCopied ? <CheckIcon /> : <CopyIcon />}
                      {ocrCopied ? "Copied!" : "Copy"}
                    </button>
                  </>
                )}
                {activeTab === "summary" && summary && (
                  <div className="flex gap-2">
                    <button
                      onClick={handleDownloadPdf}
                      disabled={isGeneratingPdf}
                      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg
                      border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors bg-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isGeneratingPdf ? <SpinnerIcon /> : (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="w-4 h-4 text-red-500"
                        >
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                        </svg>
                      )}
                      {isGeneratingPdf ? "Generating..." : "Extract to PDF"}
                    </button>
                    <button
                      onClick={copySummary}
                      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg
                      border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors bg-white"
                    >
                      {summaryCopied ? <CheckIcon /> : <CopyIcon />}
                      {summaryCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {activeTab === "extracted" && tokenUsage && (
              <TokenCostBar usage={tokenUsage} />
            )}
            {activeTab === "summary" && summaryTokenUsage && (
              <TokenCostBar usage={summaryTokenUsage} />
            )}

            <div className="flex-1 min-h-0 overflow-auto p-5">
              {/* Extracted Text tab */}
              {activeTab === "extracted" && (
                <>
                  {ocrStatus === "idle" && (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-12 h-12 opacity-25"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <p className="text-sm font-medium">
                        Upload a document and run OCR to see results
                      </p>
                    </div>
                  )}
                  {ocrStatus === "ready" && (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-12 h-12 opacity-35"
                      >
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      <p className="text-sm font-medium text-slate-500">
                        {files.length} doc{files.length !== 1 ? "s" : ""} queued —
                        click{" "}
                        <span className="font-bold text-blue-600">
                          Run OCR Engine
                        </span>{" "}
                        to extract
                      </p>
                    </div>
                  )}
                  {ocrStatus === "processing" && !result && (
                    <div className="flex flex-col items-center justify-center h-full gap-4">
                      <div className="relative">
                        <div className="w-14 h-14 rounded-full border-4 border-blue-100 border-t-blue-500 animate-spin" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
                        </div>
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-semibold text-slate-700">
                          Processing {files.length} doc
                          {files.length !== 1 ? "s" : ""}…
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          Your documents are being scanned and processed
                        </p>
                      </div>
                    </div>
                  )}
                  {ocrStatus === "processing" && result && (
                    <div className="flex flex-col h-full gap-3">
                      <div className="flex items-center gap-2 px-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
                        <span className="text-xs font-semibold text-blue-600">
                          Streaming — text appears as it is extracted
                        </span>
                      </div>
                      <pre className="flex-1 overflow-auto text-sm text-slate-800 whitespace-pre-wrap break-words leading-relaxed font-mono">
                        {result}
                      </pre>
                    </div>
                  )}
                  {ocrStatus === "error" && ocrError && (
                    <div className="flex flex-col items-center justify-center h-full gap-3">
                      <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="w-6 h-6 text-red-500"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                      </div>
                      <div className="text-center max-w-sm">
                        <p className="text-sm font-semibold text-red-700">
                          OCR Failed
                        </p>
                        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                          {ocrError}
                        </p>
                      </div>
                      <button
                        onClick={runOCR}
                        className="mt-2 text-xs font-semibold text-blue-600 hover:text-blue-700 underline underline-offset-2"
                      >
                        Try again
                      </button>
                    </div>
                  )}
                  {ocrStatus === "done" && result && (
                    <pre className="text-sm text-slate-800 whitespace-pre-wrap break-words leading-relaxed font-mono">
                      {result}
                    </pre>
                  )}
                </>
              )}

              {/* AI Summary tab */}
              {activeTab === "summary" && (
                <>
                  {summaryStatus === "idle" && (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-12 h-12 opacity-25"
                      >
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                      <p className="text-sm font-medium text-center max-w-xs">
                        {ocrStatus !== "done" ? (
                          <>
                            Run OCR first, then click{" "}
                            <span className="font-bold text-violet-600">
                              Summarize
                            </span>
                          </>
                        ) : (
                          <>
                            Click{" "}
                            <span className="font-bold text-violet-600">
                              Summarize
                            </span>{" "}
                            in the left panel
                          </>
                        )}
                      </p>
                    </div>
                  )}
                  {summaryStatus === "processing" && !summary && (
                    <div className="flex flex-col items-center justify-center h-full gap-4">
                      <div className="relative">
                        <div className="w-14 h-14 rounded-full border-4 border-violet-100 border-t-violet-500 animate-spin" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-3 h-3 rounded-full bg-violet-500 animate-pulse" />
                        </div>
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-semibold text-slate-700">
                          Summarizing document…
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          Extracted text is being analyzed
                        </p>
                      </div>
                    </div>
                  )}
                  {summaryStatus === "processing" && summary && (
                    <div className="flex flex-col h-full gap-3">
                      <div className="flex items-center gap-2 px-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse flex-shrink-0" />
                        <span className="text-xs font-semibold text-violet-600">
                          Streaming — summary appears as it is generated
                        </span>
                      </div>
                      <div className="flex-1 overflow-auto text-sm text-slate-800 leading-relaxed">
                        <ReactMarkdown
                          components={{
                            h1: ({ node, ...props }) => <h1 className="text-lg font-bold text-slate-900 mt-4 mb-2 first:mt-0" {...props} />,
                            h2: ({ node, ...props }) => <h2 className="text-base font-bold text-slate-900 mt-3 mb-1.5 first:mt-0" {...props} />,
                            h3: ({ node, ...props }) => <h3 className="text-sm font-bold text-slate-900 mt-2 mb-1 first:mt-0" {...props} />,
                            p: ({ node, ...props }) => <p className="mb-2.5 last:mb-0 text-slate-700 leading-relaxed" {...props} />,
                            ul: ({ node, ...props }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-slate-700" {...props} />,
                            ol: ({ node, ...props }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-slate-700" {...props} />,
                            li: ({ node, ...props }) => <li className="mb-0.5 text-slate-700" {...props} />,
                            strong: ({ node, ...props }) => <strong className="font-semibold text-slate-900" {...props} />,
                            em: ({ node, ...props }) => <em className="italic text-slate-800" {...props} />,
                            code: ({ node, ...props }) => <code className="bg-slate-100 rounded px-1 py-0.5 font-mono text-xs text-red-600" {...props} />,
                            blockquote: ({ node, ...props }) => (
                              <blockquote className="border-l-4 border-slate-200 pl-3 italic my-2 text-slate-500" {...props} />
                            ),
                          }}
                        >
                          {summary}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  {summaryStatus === "error" && summaryError && (
                    <div className="flex flex-col items-center justify-center h-full gap-3">
                      <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="w-6 h-6 text-red-500"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                      </div>
                      <div className="text-center max-w-sm">
                        <p className="text-sm font-semibold text-red-700">
                          Summarization Failed
                        </p>
                        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                          {summaryError}
                        </p>
                      </div>
                      <button
                        onClick={runSummarizer}
                        className="mt-2 text-xs font-semibold text-violet-600 hover:text-violet-700 underline underline-offset-2"
                      >
                        Try again
                      </button>
                    </div>
                  )}
                  {summaryStatus === "done" && summary && (
                    <div className="text-sm text-slate-800 leading-relaxed">
                      <ReactMarkdown
                        components={{
                          h1: ({ node, ...props }) => <h1 className="text-lg font-bold text-slate-900 mt-4 mb-2 first:mt-0" {...props} />,
                          h2: ({ node, ...props }) => <h2 className="text-base font-bold text-slate-900 mt-3 mb-1.5 first:mt-0" {...props} />,
                          h3: ({ node, ...props }) => <h3 className="text-sm font-bold text-slate-900 mt-2 mb-1 first:mt-0" {...props} />,
                          p: ({ node, ...props }) => <p className="mb-2.5 last:mb-0 text-slate-700 leading-relaxed" {...props} />,
                          ul: ({ node, ...props }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-slate-700" {...props} />,
                          ol: ({ node, ...props }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-slate-700" {...props} />,
                          li: ({ node, ...props }) => <li className="mb-0.5 text-slate-700" {...props} />,
                          strong: ({ node, ...props }) => <strong className="font-semibold text-slate-900" {...props} />,
                          em: ({ node, ...props }) => <em className="italic text-slate-800" {...props} />,
                          code: ({ node, ...props }) => <code className="bg-slate-100 rounded px-1 py-0.5 font-mono text-xs text-red-600" {...props} />,
                          blockquote: ({ node, ...props }) => (
                            <blockquote className="border-l-4 border-slate-200 pl-3 italic my-2 text-slate-500" {...props} />
                          ),
                        }}
                      >
                        {summary}
                      </ReactMarkdown>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Hidden container for PDF rendering */}
      <div style={{ position: "absolute", left: 0, top: 0, width: "850px", height: 0, overflow: "hidden" }}>
        <div
          ref={pdfReportRef}
          style={{ width: "794px" }}
          className="p-10 bg-white text-slate-800 font-sans"
        >
          {/* Header styling */}
          <div className="border-b-2 border-slate-200 pb-4 mb-6">
            <div className="flex justify-between items-end">
              <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                  <span className="text-blue-600">insurance</span>
                  <span className="text-slate-400 font-normal">-ai</span>
                </h1>
                <p className="text-xs text-slate-500 font-medium tracking-wide uppercase mt-1">
                  AI Summary Report
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-[10px] text-slate-400 font-semibold uppercase">Confidentiality</p>
                <p className="text-xs font-bold text-red-600">INTERNAL USE ONLY</p>
              </div>
            </div>
          </div>

          {/* Metadata Grid */}
          <div className="bg-slate-50 rounded-xl p-4 mb-6 border border-slate-100 grid grid-cols-2 gap-y-3 gap-x-6 text-xs">
            <div>
              <span className="text-slate-400 font-semibold block uppercase tracking-wider text-[10px]">Report Date</span>
              <span suppressHydrationWarning className="text-slate-700 font-medium">
                {new Date().toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
              </span>
            </div>
            <div>
              <span className="text-slate-400 font-semibold block uppercase tracking-wider text-[10px]">Generated By</span>
              <span className="text-slate-700 font-medium">Saira Reviewer (Senior Underwriter)</span>
            </div>
            <div className="col-span-2">
              <span className="text-slate-400 font-semibold block uppercase tracking-wider text-[10px]">Source Documents</span>
              <span className="text-slate-700 font-medium break-all">
                {files.map(f => f.name).join(", ")}
              </span>
            </div>
          </div>

          {/* Summary sections interleaved with source images */}
          <div className="prose prose-slate max-w-none text-sm leading-relaxed text-slate-800">
            {summary && (() => {
              const mdComponents = {
                h1: ({ node, ...props }: React.ComponentPropsWithoutRef<"h1"> & { node?: unknown }) => <h1 className="text-xl font-bold text-slate-900 mt-6 mb-3 border-b border-slate-100 pb-1" style={{ pageBreakAfter: "avoid" }} {...props} />,
                h2: ({ node, ...props }: React.ComponentPropsWithoutRef<"h2"> & { node?: unknown }) => <h2 className="text-lg font-bold text-slate-900 mt-5 mb-2" style={{ pageBreakAfter: "avoid" }} {...props} />,
                h3: ({ node, ...props }: React.ComponentPropsWithoutRef<"h3"> & { node?: unknown }) => <h3 className="text-base font-bold text-slate-900 mt-4 mb-1.5" style={{ pageBreakAfter: "avoid" }} {...props} />,
                p: ({ node, ...props }: React.ComponentPropsWithoutRef<"p"> & { node?: unknown }) => <p className="mb-3 text-slate-700 leading-relaxed" {...props} />,
                ul: ({ node, ...props }: React.ComponentPropsWithoutRef<"ul"> & { node?: unknown }) => <ul className="list-disc pl-5 mb-4 space-y-1.5 text-slate-700" style={{ pageBreakInside: "avoid" }} {...props} />,
                ol: ({ node, ...props }: React.ComponentPropsWithoutRef<"ol"> & { node?: unknown }) => <ol className="list-decimal pl-5 mb-4 space-y-1.5 text-slate-700" style={{ pageBreakInside: "avoid" }} {...props} />,
                li: ({ node, ...props }: React.ComponentPropsWithoutRef<"li"> & { node?: unknown }) => <li className="mb-0.5 text-slate-700" {...props} />,
                strong: ({ node, ...props }: React.ComponentPropsWithoutRef<"strong"> & { node?: unknown }) => <strong className="font-semibold text-slate-900" {...props} />,
                em: ({ node, ...props }: React.ComponentPropsWithoutRef<"em"> & { node?: unknown }) => <em className="italic text-slate-800" {...props} />,
                code: ({ node, ...props }: React.ComponentPropsWithoutRef<"code"> & { node?: unknown }) => <code className="bg-slate-100 rounded px-1 py-0.5 font-mono text-xs text-red-600" {...props} />,
                blockquote: ({ node, ...props }: React.ComponentPropsWithoutRef<"blockquote"> & { node?: unknown }) => (
                  <blockquote className="border-l-4 border-slate-200 pl-3 italic my-3 text-slate-500 bg-slate-50 py-1 pr-2 rounded-r" style={{ pageBreakInside: "avoid" }} {...props} />
                ),
              };

              // Split summary into per-document sections (split before each "## " heading at line start)
              const sections = summary.split(/(?=^## )/m).filter(s => s.trim());

              return sections.map((section, i) => {
                const file = files[i];
                const isImage = file && IMAGE_PREVIEW.includes(getExt(file.name));
                return (
                  // Force a new page before every document section except the first
                  <div key={i} style={{ pageBreakBefore: i > 0 ? "always" : "auto", paddingTop: i > 0 ? "8px" : "0" }}>
                    <ReactMarkdown components={mdComponents}>{section}</ReactMarkdown>
                    {isImage && (
                      // Keep label + image together; cap height so it never bleeds across two pages
                      <div style={{ pageBreakInside: "avoid", marginTop: "16px", marginBottom: "8px" }}>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Source Image</p>
                          <p className="text-[10px] text-slate-400">{file.name} · {fmtSize(file.size)}</p>
                        </div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={objectURLs[i]}
                          alt={file.name}
                          crossOrigin="anonymous"
                          style={{
                            width: "100%",
                            maxHeight: "620px",
                            height: "auto",
                            objectFit: "contain",
                            borderRadius: "8px",
                            border: "1px solid #e2e8f0",
                            display: "block",
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>

          {/* Footer inside element (for the end of the report) */}
          <div className="border-t border-slate-200 mt-8 pt-4 text-center text-[10px] text-slate-400" style={{ pageBreakInside: "avoid" }}>
            <p className="font-semibold">insurance-ai Underwriting Portal — AI Document Processing Pipeline</p>
            <p className="mt-1">Adamjee Life Assurance Co. Ltd. · Strictly Confidential</p>
          </div>
        </div>
      </div>
    </>
  );
}
