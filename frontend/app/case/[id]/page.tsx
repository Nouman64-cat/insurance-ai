"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

import { DecisionBanner, StatusBadge } from "@/components/StatusBadge";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { fmtCoverage, fmtDob, fmtIncome, type AIDecision } from "@/lib/mock-data";
import api, { summarizerApi } from "@/app/services/api";

// ── Markdown renderer for the AI document summary ────────────────────────────

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h2: ({ children }) => <h2 className="text-xs font-bold text-slate-800 mt-4 mb-1.5 pb-1 border-b border-slate-100 first:mt-0 uppercase tracking-wide">{children}</h2>,
  p: ({ children }) => <p className="text-xs text-slate-600 leading-relaxed mb-2">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 space-y-1 pl-4">{children}</ul>,
  li: ({ children }) => <li className="text-xs text-slate-600 leading-relaxed list-disc">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  GROUP_LIFE: "Group Life",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

const CASE_STATUS_STYLE: Record<string, string> = {
  New: "bg-slate-100 text-slate-600 border-slate-200",
  InProgress: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  Closed: "bg-slate-200 text-slate-700 border-slate-300",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types — mirror GET /tenants/{tenantId}/cases/{id}/detail
// ─────────────────────────────────────────────────────────────────────────────

interface CaseData {
  caseld: string;
  caseNumber: string;
  applicant_id: string;
  policy_id: string | null;
  caseType: string;
  caseStatus: string;
  priorityLevel: string;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
}

interface ApplicantData {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
  is_smoker: boolean;
  height_cm: number;
  weight_kg: number;
}

interface PolicyData {
  id: string;
  product_name: string;
  insurance_type: string;
  coverage_amount: number;
  term_years: number;
  dependent_name: string | null;
  dependent_dob: string | null;
  status: string;
}

interface DocumentChecklist {
  insurance_type: string | null;
  required: string[];
  received: string[];
  missing: string[];
}

interface AssessmentData {
  id: string;
  medical_score: number;
  financial_score: number;
  fraud_probability: number;
  composite_risk_score: number | null;
  ai_decision: AIDecision;
  suggested_loading: number | null;
  reasons: string[];
  created_at: string;
}

interface CaseDetailResponse {
  case: CaseData;
  applicant: ApplicantData | null;
  policy: PolicyData | null;
  document_checklist: DocumentChecklist;
  latest_assessment: AssessmentData | null;
  assessments_count: number;
}

interface ArtifactData {
  id: string;
  document_type: string;
  file_name: string;
  file_size: number;
  ocr_result: string | null;
  status: string;
}

const SUPPORTED_EXTS = ["pdf", "png", "jpg", "jpeg", "tiff", "bmp"];

function fmtFileSize(bytes: number): string {
  if (!bytes) return "—";
  return bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

type StreamStatus = "idle" | "streaming" | "done" | "error";

interface LiveResult {
  completedNodes: string[];
  medicalScore: number | null;
  medicalReasons: string[];
  financialScore: number | null;
  financialReasons: string[];
  fraudProbability: number | null;
  fraudReasons: string[];
  compositeScore: number | null;
  aiDecision: AIDecision | null;
  reasons: string[];
}

const EMPTY_LIVE: LiveResult = {
  completedNodes: [], medicalScore: null, medicalReasons: [],
  financialScore: null, financialReasons: [], fraudProbability: null,
  fraudReasons: [], compositeScore: null, aiDecision: null, reasons: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="data-row">
      <span className="data-key">{label}</span>
      <span className="data-val">{value}</span>
    </div>
  );
}

function SectionCard({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card ${className}`}>
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h3 className="section-label">{title}</h3>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function InitialsAvatar({ name }: { name: string }) {
  const initials = name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="w-14 h-14 rounded-xl bg-blue-700 flex items-center justify-center flex-shrink-0 shadow-sm">
      <span className="text-xl font-bold text-white">{initials}</span>
    </div>
  );
}

function ReasonGroup({ label, score, scoreLabel, reasons, accentColor }: {
  label: string; score: number; scoreLabel: string; reasons: string[]; accentColor: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold uppercase tracking-widest ${accentColor}`}>{label}</span>
        <span className="text-xs text-slate-400 font-mono">({scoreLabel})</span>
      </div>
      <ul className="space-y-1.5">
        {reasons.length === 0 && <li className="text-xs text-slate-400">No factors recorded.</li>}
        {reasons.map((reason, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-slate-300 mt-0.5 flex-shrink-0">•</span>
            <span className="text-xs text-slate-600 leading-relaxed">{reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Spinner({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`} />;
}

function UploadModal({ tenantId, caseId, docTypes, onClose, onUploaded }: {
  tenantId: string; caseId: string; docTypes: string[]; onClose: () => void; onUploaded: () => void;
}) {
  const [docType, setDocType] = useState(docTypes[0] ?? "Other");
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (newFiles: FileList | File[]) => {
    setErr("");
    const valid: File[] = [];
    for (let i = 0; i < newFiles.length; i++) {
      const f = newFiles[i];
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED_EXTS.includes(ext)) {
        setErr(`Unsupported format ".${ext}". Allowed: ${SUPPORTED_EXTS.join(", ").toUpperCase()}`);
        continue;
      }
      valid.push(f);
    }
    setFiles(prev => [...prev, ...valid]);
  };

  const submit = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setErr("");
    const failures: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append("document_type", docType);
      form.append("file", file);
      try {
        await api.post(`/tenants/${tenantId}/cases/${caseId}/artifacts`, form, {
          headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000,
        });
      } catch (e: any) {
        failures.push(`${file.name}: ${e.response?.data?.detail ?? e.message ?? "failed"}`);
      }
    }
    setUploading(false);
    if (failures.length > 0) {
      setErr(failures.join("\n"));
      setFiles([]);
    } else {
      onUploaded();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h3 className="font-bold text-slate-800">Upload Document(s)</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 -mr-1">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-600">Document Type</label>
            <select value={docType} onChange={e => setDocType(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400">
              {[...docTypes, "Other"].filter((v, i, a) => a.indexOf(v) === i).map(t => <option key={t}>{t}</option>)}
            </select>
          </div>

          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files) addFiles(e.dataTransfer.files); }}
            onClick={() => inputRef.current?.click()}
            className={`rounded-xl border-2 cursor-pointer transition-all px-4 py-5 flex flex-col items-center gap-2 ${isDragging ? "border-blue-400 bg-blue-50" : "border-dashed border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/40"}`}
          >
            <input ref={inputRef} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp" multiple
              onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            <p className="text-xs font-semibold text-slate-600">Drop files here or <span className="text-blue-600">browse</span></p>
            <p className="text-[10px] text-slate-400">PDF · PNG · JPG · JPEG · TIFF · BMP</p>
          </div>

          {files.length > 0 && (
            <ul className="space-y-1 max-h-32 overflow-y-auto">
              {files.map((f, i) => (
                <li key={i} className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                  <span className="truncate text-slate-700">{f.name}</span>
                  <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 ml-2">✕</button>
                </li>
              ))}
            </ul>
          )}

          {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-line">{err}</p>}

          <div className="flex justify-end gap-3 pt-1">
            <button onClick={onClose} disabled={uploading} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancel</button>
            <button onClick={submit} disabled={files.length === 0 || uploading} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-all">
              {uploading ? <Spinner /> : null}
              {uploading ? "Uploading…" : "Upload & OCR"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function CasePage({ params }: { params: { id: string } }) {
  const caseId = params.id;
  const [detail, setDetail] = useState<CaseDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<StreamStatus>("idle");
  const [live, setLive] = useState<LiveResult>(EMPTY_LIVE);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [overriding, setOverriding] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [postingNote, setPostingNote] = useState(false);
  const [noteSent, setNoteSent] = useState(false);

  const [artifacts, setArtifacts] = useState<ArtifactData[]>([]);
  const [showUpload, setShowUpload] = useState(false);

  const [docSummary, setDocSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);

  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  const fetchDetail = useCallback(async () => {
    if (!tenantId) return;
    setError(null);
    try {
      const res = await api.get<CaseDetailResponse>(`/tenants/${tenantId}/cases/${caseId}/detail`);
      setDetail(res.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load case.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, caseId]);

  const fetchArtifacts = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.get<ArtifactData[]>(`/tenants/${tenantId}/cases/${caseId}/artifacts`);
      setArtifacts(res.data);
    } catch { /* non-fatal — the case shell above still renders */ }
  }, [tenantId, caseId]);

  useEffect(() => {
    fetchDetail();
    fetchArtifacts();
  }, [fetchDetail, fetchArtifacts]);

  // Poll every 3s while any artifact is still being OCR'd, so status/ocr_result
  // update without a manual refresh — same pattern as the /cases explorer.
  useEffect(() => {
    if (!artifacts.some(a => a.status === "Processing")) return;
    const t = setTimeout(fetchArtifacts, 3000);
    return () => clearTimeout(t);
  }, [artifacts, fetchArtifacts]);

  const summarizeDocuments = async () => {
    const texts = artifacts.filter(a => a.ocr_result).map(a => a.ocr_result as string);
    if (texts.length === 0) return;
    setSummarizing(true);
    setSummarizeError(null);
    try {
      const res = await summarizerApi.post<{ summary: string }>("/summarize/underwriting", { documents: texts });
      setDocSummary(res.data.summary);
    } catch (err: any) {
      setSummarizeError(err.message ?? "Failed to summarize documents.");
    } finally {
      setSummarizing(false);
    }
  };

  // ── Run AI Underwriting (SSE) ────────────────────────────────────────────────

  const runUnderwriting = async () => {
    if (!detail?.applicant || !detail?.policy || !tenantId) return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStatus("streaming");
    setLive(EMPTY_LIVE);
    setStreamError(null);

    const { applicant, policy } = detail;
    const payload = {
      applicant: {
        cnic: applicant.cnic,
        name: applicant.name,
        dob: applicant.dob,
        gender: applicant.gender,
        occupation: applicant.occupation,
        declared_income: applicant.declared_income,
      },
      policy: {
        product_name: policy.product_name,
        insurance_type: policy.insurance_type,
        coverage_amount: policy.coverage_amount,
        term_years: policy.term_years,
        ...(policy.dependent_name ? { dependent_name: policy.dependent_name, dependent_dob: policy.dependent_dob } : {}),
      },
      case_id: caseId,
      ...(docSummary ? { ai_summary: docSummary } : {}),
    };

    try {
      const res = await fetch(`${API_BASE}/evaluate/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(Array.isArray(body.detail) ? body.detail.map((d: any) => d.msg ?? d).join(", ") : body.detail ?? `Gateway returned ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let evt: Record<string, any>;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }

          if (evt.type === "progress") {
            const node = evt.node as string;
            const data = evt.data as Record<string, any>;
            setLive(prev => {
              const next: LiveResult = { ...prev, completedNodes: prev.completedNodes.includes(node) ? prev.completedNodes : [...prev.completedNodes, node] };
              if (node === "medical_scoring") { next.medicalScore = data.medical_score ?? null; next.medicalReasons = data.medical_reasons ?? []; }
              else if (node === "financial_scoring") { next.financialScore = data.financial_score ?? null; next.financialReasons = data.financial_reasons ?? []; }
              else if (node === "fraud_detection") { next.fraudProbability = data.fraud_probability ?? null; next.fraudReasons = data.fraud_reasons ?? []; }
              else if (node === "decision_aggregation") { next.compositeScore = data.composite_risk_score ?? null; next.aiDecision = data.ai_decision ?? null; next.reasons = data.reasons ?? []; }
              return next;
            });
            if (node === "decision_aggregation") setStatus("done");
          } else if (evt.type === "invalid") {
            setStatus("error");
            setStreamError(`Validation failed: ${(evt.errors as string[]).join("; ")}`);
            break outer;
          } else if (evt.type === "error") {
            setStatus("error");
            setStreamError(evt.message ?? "An unexpected error occurred.");
            break outer;
          } else if (evt.type === "saved") {
            // Case/Policy status may have auto-transitioned — refresh the case shell.
            fetchDetail();
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setStatus("error");
      setStreamError(err.message ?? "Connection failed.");
    }
  };

  // ── Manual override (writes to the real CaseHistory audit trail) ────────────

  const overrideStatus = async (newStatus: string) => {
    if (!tenantId) return;
    setOverriding(newStatus);
    try {
      await api.patch(`/tenants/${tenantId}/cases/${caseId}/status`, { status: newStatus });
      await fetchDetail();
    } catch (err: any) {
      setError(err.message ?? "Failed to update case status.");
    } finally {
      setOverriding(null);
    }
  };

  const submitNote = async () => {
    if (!tenantId || !note.trim()) return;
    setPostingNote(true);
    setNoteSent(false);
    try {
      await api.post(`/tenants/${tenantId}/cases/${caseId}/comments`, {
        commentText: note.trim(),
        commentType: "Internal",
        visibilityLevel: "Team",
      });
      setNote("");
      setNoteSent(true);
      setTimeout(() => setNoteSent(false), 3000);
    } catch (err: any) {
      setError(err.message ?? "Failed to post note.");
    } finally {
      setPostingNote(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-screen-2xl mx-auto px-6 py-20 flex flex-col items-center justify-center gap-2">
        <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
        <span className="text-xs text-slate-400">Loading case…</span>
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="max-w-screen-2xl mx-auto px-6 py-10">
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <p className="text-sm font-bold text-red-700 mb-1">Failed to load case</p>
          <p className="text-xs text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const { case: c, applicant, policy, document_checklist: docs } = detail;

  // Prefer the live (just-streamed) result for this session; fall back to the
  // last persisted assessment. Live gives per-category reasons; persisted only
  // has the flat merged `reasons` array (decision_aggregation merges them
  // before writing to the DB), so the two render slightly differently below.
  const hasLive = live.compositeScore !== null;
  const assessment = detail.latest_assessment;
  const hasAny = hasLive || assessment !== null;

  const medicalScore = hasLive ? live.medicalScore! : assessment?.medical_score ?? 0;
  const financialScore = hasLive ? live.financialScore! : assessment?.financial_score ?? 0;
  const fraudProbability = hasLive ? live.fraudProbability! : assessment?.fraud_probability ?? 0;
  const compositeScore = hasLive ? live.compositeScore! : assessment?.composite_risk_score ?? 0;
  const aiDecision = (hasLive ? live.aiDecision : assessment?.ai_decision) ?? null;
  const suggestedLoading = hasLive ? null : assessment?.suggested_loading ?? null;
  const fraudPct = +((fraudProbability ?? 0) * 100).toFixed(1);

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-5">

      {/* ── Breadcrumb & case header ──────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link href="/" className="text-xs text-slate-500 hover:text-blue-700 font-medium transition-colors">← Dashboard</Link>
            <span className="text-slate-300">/</span>
            <span className="text-xs text-slate-400">Cases</span>
            <span className="text-slate-300">/</span>
            <span className="text-xs text-slate-700 font-semibold">{c.caseNumber}</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">{applicant?.name ?? "Unknown Applicant"}</h1>
            {aiDecision && <StatusBadge decision={aiDecision} size="lg" />}
            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold border ${CASE_STATUS_STYLE[c.caseStatus] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
              {c.caseStatus}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            {c.caseNumber} &nbsp;·&nbsp; Opened {new Date(c.createdAt).toLocaleDateString()} via {c.sourceChannel}
            {policy && <>&nbsp;·&nbsp; {policy.product_name} &nbsp;·&nbsp; {fmtCoverage(policy.coverage_amount)} coverage</>}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          <button
            onClick={() => overrideStatus("Pending Documents")}
            disabled={overriding !== null}
            className="px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            {overriding === "Pending Documents" ? <Spinner className="w-3.5 h-3.5 border-slate-400 border-t-slate-700" /> : "Request Info"}
          </button>
          <button
            onClick={() => overrideStatus("Rejected")}
            disabled={overriding !== null}
            className="px-4 py-2 text-sm font-semibold text-red-700 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors"
          >
            {overriding === "Rejected" ? <Spinner className="w-3.5 h-3.5 border-red-300 border-t-red-700" /> : "Override: Decline"}
          </button>
          <button
            onClick={() => overrideStatus("Approved")}
            disabled={overriding !== null}
            className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {overriding === "Approved" ? <Spinner /> : "Override: Approve"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {/* ── Main grid: 3 cols ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── LEFT COLUMN: Applicant + Policy ─────────────────────────────── */}
        <div className="lg:col-span-1 space-y-4">

          {applicant && (
            <div className="card p-5">
              <div className="flex items-center gap-3 mb-4 pb-4 border-b border-slate-100">
                <InitialsAvatar name={applicant.name} />
                <div>
                  <p className="font-bold text-slate-900 leading-tight">{applicant.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{applicant.gender}</p>
                  <p className="text-xs text-blue-600 font-mono mt-0.5">{applicant.cnic}</p>
                </div>
              </div>
              <p className="section-label mb-3">Applicant Details</p>
              <DataRow label="CNIC" value={<span className="font-mono text-sm">{applicant.cnic}</span>} />
              <DataRow label="Date of Birth" value={fmtDob(applicant.dob)} />
              <DataRow label="Gender" value={applicant.gender} />
              <DataRow label="Occupation" value={applicant.occupation} />
              <DataRow label="Declared Annual Income" value={fmtIncome(applicant.declared_income)} />
              <DataRow label="Smoker" value={applicant.is_smoker ? "Yes" : "No"} />
            </div>
          )}

          {policy && (
            <div className="card p-5">
              <p className="section-label mb-3">Policy Details</p>
              <DataRow label="Product" value={INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.product_name} />
              <DataRow label="Coverage Amount" value={fmtCoverage(policy.coverage_amount)} />
              <DataRow label="Policy Term" value={`${policy.term_years} years`} />
              {applicant && (
                <DataRow label="Coverage-to-Income Ratio" value={`${(policy.coverage_amount / applicant.declared_income).toFixed(1)}×`} />
              )}
              <DataRow label="Policy Status" value={policy.status} />

              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="section-label mb-3">Case</p>
                <DataRow label="Case Number" value={c.caseNumber} />
                <DataRow label="Type" value={c.caseType} />
                <DataRow label="Priority" value={c.priorityLevel} />
                <DataRow label="Channel" value={c.sourceChannel} />
              </div>
            </div>
          )}

          {/* Document checklist + upload */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">Documents</p>
              <button onClick={() => setShowUpload(true)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">+ Upload</button>
            </div>
            {docs.required.length === 0 ? (
              <p className="text-xs text-slate-400">No documents required for this plan type.</p>
            ) : (
              <ul className="space-y-1.5 mb-3">
                {docs.required.map(d => {
                  const got = docs.received.includes(d);
                  return (
                    <li key={d} className="flex items-center justify-between text-xs">
                      <span className={got ? "text-slate-700" : "text-slate-400"}>{d}</span>
                      <span className={`font-semibold ${got ? "text-emerald-600" : "text-amber-600"}`}>{got ? "Received" : "Missing"}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {artifacts.length > 0 && (
              <div className="pt-3 border-t border-slate-100 space-y-1.5">
                {artifacts.map(a => (
                  <div key={a.id} className="flex items-center justify-between text-xs">
                    <div className="min-w-0 flex-1 mr-2">
                      <p className="truncate text-slate-700 font-medium">{a.file_name}</p>
                      <p className="text-[10px] text-slate-400">{a.document_type} · {fmtFileSize(a.file_size)}</p>
                    </div>
                    <span className={`font-semibold flex-shrink-0 ${a.status === "Processing" ? "text-amber-600 animate-pulse" : a.ocr_result ? "text-emerald-600" : "text-slate-400"}`}>
                      {a.status === "Processing" ? "OCR…" : a.ocr_result ? "OCR done" : a.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick score summary */}
          {hasAny && (
            <div className="card p-5">
              <p className="section-label mb-3">Score Summary</p>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Medical Risk</span>
                  <span className="font-bold text-slate-900">{medicalScore} / 100</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Financial Risk</span>
                  <span className="font-bold text-slate-900">{financialScore} / 100</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Fraud Probability</span>
                  <span className="font-bold text-slate-900">{fraudPct}%</span>
                </div>
                <div className="h-px bg-slate-100 my-1" />
                <div className="flex justify-between items-center text-sm">
                  <span className="font-semibold text-slate-700">Composite Score</span>
                  <span className="font-extrabold text-slate-900">{compositeScore} / 100</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT COLUMN: Risk assessment + Recommendation ────────────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Document summary — categorized medical/financial/occupational read
              of the uploaded paperwork, generated before underwriting runs. */}
          <div className="card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="section-label">Document Summary (AI)</p>
              <button
                onClick={summarizeDocuments}
                disabled={summarizing || artifacts.filter(a => a.ocr_result).length === 0}
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {summarizing ? <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" /> : null}
                {summarizing ? "Summarizing…" : docSummary ? "Re-summarize" : "Summarize Documents"}
              </button>
            </div>
            {artifacts.filter(a => a.ocr_result).length === 0 && !docSummary && (
              <p className="text-xs text-slate-400">Upload and OCR at least one document to generate a medical / financial / occupational summary.</p>
            )}
            {summarizeError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{summarizeError}</p>}
            {docSummary && <ReactMarkdown components={MD_COMPONENTS}>{docSummary}</ReactMarkdown>}
          </div>

          {!hasAny ? (
            <div className="card p-8 flex flex-col items-center justify-center text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
                <span className="text-2xl">🩺</span>
              </div>
              <p className="text-sm font-semibold text-slate-700">This case hasn't been underwritten yet</p>
              <p className="text-xs text-slate-400 max-w-sm">
                Run the AI underwriting pipeline to score medical, financial, and fraud risk and get a decision recommendation.
              </p>
              <button
                onClick={runUnderwriting}
                disabled={status === "streaming" || !policy || !applicant}
                className="mt-2 flex items-center gap-2 px-5 py-2.5 bg-blue-700 text-white rounded-lg text-sm font-semibold hover:bg-blue-800 disabled:opacity-50 transition-colors shadow-sm"
              >
                {status === "streaming" ? <Spinner /> : null}
                {status === "streaming" ? "Running…" : "Run AI Underwriting"}
              </button>
              {streamError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{streamError}</p>}
            </div>
          ) : (
            <>
              {/* Risk Assessment Scores */}
              <SectionCard title="AI Risk Assessment">
                <div className="space-y-5">
                  <RiskScoreBar label="Medical Risk Score" score={medicalScore} />
                  <RiskScoreBar label="Financial Risk Score" score={financialScore} />
                  <RiskScoreBar label="Fraud Probability" score={fraudPct} valueLabel={`${fraudPct}%`} />
                  <div className="pt-2 border-t border-slate-100">
                    <CompositeScoreRing score={compositeScore} />
                  </div>
                </div>
              </SectionCard>

              {/* AI Recommendation */}
              <div className="card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="section-label">AI Recommendation</p>
                  <button
                    onClick={runUnderwriting}
                    disabled={status === "streaming"}
                    className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    {status === "streaming" ? <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" /> : null}
                    {status === "streaming" ? "Re-running…" : "Re-run Underwriting"}
                  </button>
                </div>

                {aiDecision && <DecisionBanner decision={aiDecision} />}
                {streamError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{streamError}</p>}

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <p className="text-xs text-slate-400 font-medium">Suggested Premium Loading</p>
                    <p className="text-lg font-extrabold text-slate-900 mt-1">
                      {suggestedLoading != null && suggestedLoading > 0 ? `+${suggestedLoading}%` : "N / A"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <p className="text-xs text-slate-400 font-medium">Assessment</p>
                    <p className="text-lg font-extrabold text-blue-700 mt-1">
                      {detail.assessments_count > 0 ? `#${detail.assessments_count}` : "First run"}
                    </p>
                  </div>
                </div>

                {/* Explainability report */}
                <div className="pt-2 border-t border-slate-100">
                  <p className="section-label mb-4">Explainability Report</p>
                  {hasLive ? (
                    <div className="space-y-5">
                      <ReasonGroup label="Medical Risk Factors" score={medicalScore} scoreLabel={`${medicalScore}/100`} reasons={live.medicalReasons} accentColor="text-orange-700" />
                      <ReasonGroup label="Financial Risk Factors" score={financialScore} scoreLabel={`${financialScore}/100`} reasons={live.financialReasons} accentColor="text-blue-700" />
                      <ReasonGroup label="Fraud Assessment" score={fraudPct} scoreLabel={`${fraudPct}% probability`} reasons={live.fraudReasons} accentColor="text-violet-700" />
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {(assessment?.reasons ?? []).map((reason, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-slate-300 mt-0.5 flex-shrink-0">•</span>
                          <span className="text-xs text-slate-600 leading-relaxed">{reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Underwriter notes */}
          <div className="card p-5">
            <p className="section-label mb-3">Underwriter Notes</p>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              className="w-full h-24 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 resize-none placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              placeholder="Add case notes, override justification, or referral comments here…"
            />
            <div className="flex items-center justify-end gap-2 mt-3">
              {noteSent && <span className="text-xs text-emerald-600 font-semibold mr-auto">✓ Posted</span>}
              <button
                onClick={submitNote}
                disabled={postingNote || !note.trim()}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 transition-colors"
              >
                {postingNote ? "Posting…" : "Post Note"}
              </button>
            </div>
          </div>

        </div>
      </div>

      {showUpload && (
        <UploadModal
          tenantId={tenantId}
          caseId={caseId}
          docTypes={docs.required}
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); fetchArtifacts(); fetchDetail(); }}
        />
      )}
    </div>
  );
}
