"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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

const SOURCE_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  BROKER: "Broker",
  BANCASSURANCE: "Bancassurance",
  CORPORATE_AGENT: "Corporate Agent",
  DIRECT: "Direct",
  DIGITAL: "Digital",
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
  customer_id: string;
  policy_id: string | null;
  caseType: string;
  caseStatus: string;
  priorityLevel: string;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
}

interface AcquisitionSourceData {
  id: string;
  source_type: string;
  name: string;
  code: string;
  partner_name?: string | null;
  city?: string | null;
}

interface CustomerData {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  marital_status?: string;
  occupation: string;
  declared_income: number;
  is_smoker: boolean;
  height_cm: number;
  weight_kg: number;
  details?: Record<string, any>;
  acquisition_source_id?: string | null;
  acquisition_source?: AcquisitionSourceData | null;
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
  medical_reasons?: string[];
  financial_reasons?: string[];
  fraud_reasons?: string[];
  created_at: string;
}

interface OrganizationMemberCase {
  customer_id: string;
  name: string;
  cnic: string | null;
  case_id: string;
  case_number: string;
  case_status: string;
  is_current: boolean;
}

interface CaseDetailResponse {
  case: CaseData;
  customer: CustomerData | null;
  principal_participant_name?: string | null;
  is_principal_participant?: boolean;
  family_relationship?: string | null;
  organization_name?: string | null;
  organization_members?: OrganizationMemberCase[];
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

export interface RiskFactorObject {
  factor: string;
  risk_level: string;
  reason: string;
}

interface LiveResult {
  completedNodes: string[];
  medicalScore: number | null;
  medicalReasons: (string | RiskFactorObject)[];
  financialScore: number | null;
  financialReasons: (string | RiskFactorObject)[];
  fraudProbability: number | null;
  fraudReasons: (string | RiskFactorObject)[];
  compositeScore: number | null;
  aiDecision: AIDecision | null;
  reasons: (string | RiskFactorObject)[];
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

function Accordion({ title, defaultOpen = false, action, children }: { title: string; defaultOpen?: boolean; action?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between py-3 text-left"
        >
          <span className="section-label">{title}</span>
          <svg
            className={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {action && <div className="ml-3 flex-shrink-0">{action}</div>}
      </div>
      {open && <div className="pb-4">{children}</div>}
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

// A reason is a "risk" signal (⚠) or a "clear" signal (✓). The same heuristic
// drives both the list and table views so their symbols stay in sync.
function classifyReason(reason: string): "risk" | "clear" {
  const lower = reason.toLowerCase();
  const isBad = /(high|elevated|suspicious|unverified|irregular|missing|abnormal|poor|inadequate|insufficient|concern|discrepancy|fraud|decline|reject|warning|smoker|hypertension|diabetic|disease|increased|major risk|unstable|severe|critical)/i.test(lower);
  const isGoodExemption = /(low risk|low mortality|no history|no evidence|non-smoker|absence of|no significant|within normal|normal|clear|healthy|verified|stable|acceptable|good|excellent)/i.test(lower);
  return isBad && !isGoodExemption ? "risk" : "clear";
}

// Tidy a raw reason string into something more concise/readable: collapse
// whitespace, strip noise verdicts like "…: no signal", and drop trailing
// punctuation. Keeps the meaningful fact, drops the filler.
function tidyReason(reason: string): string {
  return reason
    .replace(/\s+/g, " ")
    .replace(/\s*[:\-–—]\s*(no signals?|no concerns?|normal|nil|none|n\/a|clear)\.?$/i, "")
    .replace(/[.;,]+$/, "")
    .trim();
}

function ReasonIcon({ kind, className = "w-3.5 h-3.5" }: { kind: "risk" | "clear"; className?: string }) {
  if (kind === "risk") {
    return (
      <svg className={`text-amber-500 flex-shrink-0 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    );
  }
  return (
    <svg className={`text-emerald-500 flex-shrink-0 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

interface ReasonSection {
  label: string;       // full heading, e.g. "Medical Risk Factors"
  short: string;       // compact label for the table, e.g. "Medical"
  icon: string;        // emoji icon for domain
  score: number;
  scoreLabel: string;
  reasons: (string | RiskFactorObject)[];
  accentColor: string;
}

function ReasonGroup({ label, scoreLabel, reasons, accentColor }: {
  label: string; scoreLabel: string; reasons: (string | RiskFactorObject)[]; accentColor: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold uppercase tracking-widest ${accentColor}`}>{label}</span>
        <span className="text-[10px] font-mono text-slate-500 bg-slate-50 border border-slate-100 rounded px-1.5 py-0.5">{scoreLabel}</span>
      </div>
      <ul className="space-y-0.5">
        {reasons.length === 0 && <li className="text-xs text-slate-400 italic px-2.5 py-1">No factors recorded.</li>}
        {reasons.map((reason, i) => {
          const isObj = typeof reason === "object" && reason !== null;
          const factorStr = isObj ? reason.factor : reason;
          const detailStr = isObj ? reason.reason : tidyReason(reason);
          const kind = isObj ? (reason.risk_level.toLowerCase().includes("high") || reason.risk_level.toLowerCase().includes("moderate") ? "risk" : "clear") : classifyReason(reason);

          return (
            <li key={i} className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-slate-50/70 transition-colors">
              <ReasonIcon kind={kind as any} className="w-3.5 h-3.5 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-slate-700 leading-snug">{factorStr}</span>
                <span className="text-[11px] text-slate-500 leading-snug">{detailStr}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Compact tabular alternative to the list view — one concise row per factor,
// with the same ⚠ / ✓ signal symbols and a short category chip.
function ReasonTable({ sections }: { sections: ReasonSection[] }) {
  const rows = sections.flatMap(s =>
    s.reasons.map(reason => {
      const isObj = typeof reason === "object" && reason !== null;
      return {
        short: s.short,
        icon: s.icon,
        accentColor: s.accentColor,
        parameter: isObj ? (reason.parameter || reason.factor) : reason,
        risk_rating: isObj ? (reason.risk_rating || reason.risk_level) : (classifyReason(reason) === "risk" ? "Moderate" : "Low"),
        observation: isObj ? (reason.observation || reason.reason) : tidyReason(reason),
        kind: isObj ? ((reason.risk_rating || reason.risk_level).toLowerCase().includes("high") || (reason.risk_rating || reason.risk_level).toLowerCase().includes("moderate") ? "risk" : "clear") : classifyReason(reason),
      };
    })
  );

  if (rows.length === 0) {
    return <p className="text-xs text-slate-400">No factors recorded.</p>;
  }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500 border-b border-slate-200">
            <th className="py-3 px-3 font-medium w-40">Category</th>
            <th className="py-3 px-3 font-medium w-40">Parameter</th>
            <th className="py-3 px-3 font-medium">Observation</th>
            <th className="py-3 px-3 font-medium w-32">Risk Rating</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-200 last:border-0 align-middle">
              <td className="py-3 px-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{row.icon}</span>
                  <span className={`font-bold uppercase tracking-wide text-xs ${row.accentColor}`}>{row.short}</span>
                </div>
              </td>
              <td className="py-3 px-3 text-slate-800 font-semibold">{row.parameter}</td>
              <td className="py-3 px-3 text-slate-600">{row.observation}</td>
              <td className="py-3 px-3">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${row.risk_rating.toLowerCase().includes("high") ? "bg-red-500" :
                    row.risk_rating.toLowerCase().includes("moderate") ? "bg-amber-500" :
                      row.risk_rating.toLowerCase().includes("info") ? "bg-blue-500" :
                        "bg-emerald-500"
                    }`} />
                  <span className="text-sm text-slate-700">{row.risk_rating}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const [fileItems, setFileItems] = useState<{ file: File, type: string }[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (newFiles: FileList | File[]) => {
    setErr("");
    const valid: { file: File, type: string }[] = [];
    for (let i = 0; i < newFiles.length; i++) {
      const f = newFiles[i];
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED_EXTS.includes(ext)) {
        setErr(`Unsupported format ".${ext}". Allowed: ${SUPPORTED_EXTS.join(", ").toUpperCase()}`);
        continue;
      }
      valid.push({ file: f, type: docType });
    }
    setFileItems(prev => [...prev, ...valid]);
  };

  const submit = async () => {
    if (fileItems.length === 0) return;
    setUploading(true);
    setErr("");
    const failures: string[] = [];
    for (const item of fileItems) {
      const form = new FormData();
      form.append("document_type", item.type);
      form.append("file", item.file);
      try {
        await api.post(`/tenants/${tenantId}/cases/${caseId}/artifacts`, form, {
          headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000,
        });
      } catch (e: any) {
        failures.push(`${item.file.name}: ${e.response?.data?.detail ?? e.message ?? "failed"}`);
      }
    }
    setUploading(false);
    if (failures.length > 0) {
      setErr(failures.join("\n"));
      setFileItems([]);
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
            <label className="block text-xs font-semibold text-slate-600">Default Document Type</label>
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

          {fileItems.length > 0 && (
            <ul className="space-y-2 max-h-48 overflow-y-auto">
              {fileItems.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <span className="truncate text-slate-700 flex-1" title={item.file.name}>{item.file.name}</span>
                  <select
                    value={item.type}
                    onChange={e => {
                      const newItems = [...fileItems];
                      newItems[i].type = e.target.value;
                      setFileItems(newItems);
                    }}
                    className="w-32 bg-white border border-slate-200 rounded-md px-2 py-1 text-[11px] text-slate-600 focus:outline-none focus:border-blue-400"
                  >
                    {[...docTypes, "Other"].filter((v, idx, a) => a.indexOf(v) === idx).map(t => <option key={t}>{t}</option>)}
                  </select>
                  <button onClick={() => setFileItems(prev => prev.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 flex-shrink-0 ml-1">✕</button>
                </li>
              ))}
            </ul>
          )}

          {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-line">{err}</p>}

          <div className="flex justify-end gap-3 pt-1">
            <button onClick={onClose} disabled={uploading} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancel</button>
            <button onClick={submit} disabled={fileItems.length === 0 || uploading} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-all">
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
  const [generatingNote, setGeneratingNote] = useState(false);
  const [noteGenError, setNoteGenError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // AI Analysis view mode — "table" (compact rows, default) or "list" (grouped bullets).
  const [analysisView, setAnalysisView] = useState<"list" | "table">("table");

  const [artifacts, setArtifacts] = useState<ArtifactData[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [downloadingApp, setDownloadingApp] = useState(false);

  const [docSummary, setDocSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);

  // When multiple plans are sent to underwriting together (from the Quotations
  // page), each plan gets its own case. We store the group in sessionStorage so
  // this page can render a dropdown to switch between the plans for a customer.
  const [planGroup, setPlanGroup] = useState<{ caseId: string; planLabel: string; insuranceType: string }[]>([]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("underwriting_group");
      if (!raw) return setPlanGroup([]);
      const parsed = JSON.parse(raw);
      // Only treat as a group if the current case belongs to it.
      if (Array.isArray(parsed) && parsed.some((p) => p?.caseId === caseId)) {
        setPlanGroup(parsed);
      } else {
        setPlanGroup([]);
      }
    } catch {
      setPlanGroup([]);
    }
  }, [caseId]);

  // Per-plan underwriting state for the multi-plan group. Every selected plan is
  // streamed in parallel, so we key the live progress / status / errors by caseId
  // and render whichever plan is currently being viewed.
  const [groupStatuses, setGroupStatuses] = useState<Record<string, StreamStatus>>({});
  const [groupLive, setGroupLive] = useState<Record<string, LiveResult>>({});
  const [groupErrors, setGroupErrors] = useState<Record<string, string | null>>({});
  const groupAbortsRef = useRef<Record<string, AbortController>>({});
  const groupStartedRef = useRef<string | null>(null);

  // Track the currently-viewed case for long-lived background streams whose
  // closures would otherwise capture a stale caseId after the user switches plan.
  const currentCaseIdRef = useRef(caseId);
  useEffect(() => { currentCaseIdRef.current = caseId; }, [caseId]);

  const isGroup = planGroup.length > 1;
  const effStatus = isGroup ? (groupStatuses[caseId] ?? "idle") : status;
  const effLive = isGroup ? (groupLive[caseId] ?? EMPTY_LIVE) : live;
  const hasLive = effLive.compositeScore !== null;

  // Automatically trigger PDF download and note generation when AI underwriting completes
  // ONLY triggers if we just performed a fresh live stream (`hasLive` is true).
  // Prevents downloading on every page load for previously-completed cases.
  const autoTriggeredRef = useRef(false);
  const downloadPDFRef = useRef<(() => void) | null>(null);
  const triggerNotesRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (effStatus === "streaming") {
      autoTriggeredRef.current = false;
    } else if (effStatus === "done" && hasLive && !autoTriggeredRef.current) {
      autoTriggeredRef.current = true;
      setTimeout(() => {
        downloadPDFRef.current?.();
        triggerNotesRef.current?.();
        setShowReportModal(true);
      }, 500);
    }
  }, [effStatus, hasLive]);

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

  const searchParams = useSearchParams();
  const autoRun = searchParams.get("autoRun");
  const router = useRouter();

  // Auto-run underwriting if requested via URL. In group mode the parallel
  // runner below handles every plan, so the single-case path stays out of it.
  useEffect(() => {
    if (isGroup) return;
    const missingDocs = detail?.document_checklist?.missing ?? [];
    if (detail && !loading && status === "idle" && !live.compositeScore && !detail.latest_assessment && missingDocs.length === 0) {
      if (autoRun === "true") {
        // Remove autoRun from URL so we don't re-trigger on refresh
        router.replace(`/case/${caseId}`);
        // Small delay to ensure UI renders first before stream starts
        setTimeout(() => runUnderwriting(), 100);
      }
    }
  }, [detail, loading, status, live.compositeScore, autoRun, caseId, router, isGroup]);

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
    if (!detail?.customer || !detail?.policy || !tenantId) return;

    // Required documents must be uploaded before underwriting can proceed.
    const missingDocs = detail.document_checklist?.missing ?? [];
    if (missingDocs.length > 0) {
      setStatus("idle");
      setStreamError(`Required document(s) missing: ${missingDocs.join(", ")}. Upload them before running underwriting.`);
      return;
    }

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStatus("streaming");
    setLive(EMPTY_LIVE);
    setStreamError(null);

    const { customer, policy } = detail;
    const payload = {
      customer: {
        cnic: customer.cnic,
        name: customer.name,
        dob: customer.dob,
        gender: customer.gender,
        marital_status: customer.marital_status,
        occupation: customer.occupation,
        declared_income: customer.declared_income,
        is_smoker: customer.is_smoker,
        height_cm: customer.height_cm,
        weight_kg: customer.weight_kg,
        details: customer.details,
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

  // ── Run AI Underwriting for one plan in a multi-plan group (SSE) ────────────
  // Same stream as runUnderwriting, but results are written into the per-plan
  // maps so several plans can be underwritten in parallel and viewed on switch.

  const runGroupCase = useCallback(async (targetId: string, force = false) => {
    if (!tenantId) return;

    groupAbortsRef.current[targetId]?.abort();
    const abort = new AbortController();
    groupAbortsRef.current[targetId] = abort;

    setGroupStatuses(s => ({ ...s, [targetId]: "streaming" }));
    setGroupLive(s => ({ ...s, [targetId]: EMPTY_LIVE }));
    setGroupErrors(s => ({ ...s, [targetId]: null }));

    try {
      const dres = await api.get<CaseDetailResponse>(`/tenants/${tenantId}/cases/${targetId}/detail`);
      const d = dres.data;

      // Already underwritten — surface the persisted result instead of re-running.
      if (!force && d.latest_assessment) {
        setGroupStatuses(s => ({ ...s, [targetId]: "done" }));
        if (targetId === currentCaseIdRef.current) setDetail(d);
        return;
      }
      if (!d.customer || !d.policy) {
        setGroupStatuses(s => ({ ...s, [targetId]: "error" }));
        setGroupErrors(s => ({ ...s, [targetId]: "This case has no customer or policy to underwrite." }));
        return;
      }

      // Required documents must be uploaded before this plan can be underwritten
      // — mirror the single-case guard so parallel runs don't slip through.
      const missingDocs = d.document_checklist?.missing ?? [];
      if (missingDocs.length > 0) {
        setGroupStatuses(s => ({ ...s, [targetId]: "error" }));
        setGroupErrors(s => ({ ...s, [targetId]: `Required document(s) missing: ${missingDocs.join(", ")}. Upload them before running underwriting.` }));
        if (targetId === currentCaseIdRef.current) setDetail(d);
        return;
      }

      const { customer, policy } = d;
      const payload = {
        customer: {
          cnic: customer.cnic,
          name: customer.name,
          dob: customer.dob,
          gender: customer.gender,
          marital_status: customer.marital_status,
          occupation: customer.occupation,
          declared_income: customer.declared_income,
          is_smoker: customer.is_smoker,
          height_cm: customer.height_cm,
          weight_kg: customer.weight_kg,
          details: customer.details,
        },
        policy: {
          product_name: policy.product_name,
          insurance_type: policy.insurance_type,
          coverage_amount: policy.coverage_amount,
          term_years: policy.term_years,
          ...(policy.dependent_name ? { dependent_name: policy.dependent_name, dependent_dob: policy.dependent_dob } : {}),
        },
        case_id: targetId,
      };

      const res = await fetch(`${API_BASE}/evaluate/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = Array.isArray(body.detail) ? body.detail.map((x: any) => x.msg ?? x).join(", ") : body.detail ?? `Gateway returned ${res.status}`;
        setGroupStatuses(s => ({ ...s, [targetId]: "error" }));
        setGroupErrors(s => ({ ...s, [targetId]: msg }));
        return;
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
            setGroupLive(s => {
              const prev = s[targetId] ?? EMPTY_LIVE;
              const next: LiveResult = { ...prev, completedNodes: prev.completedNodes.includes(node) ? prev.completedNodes : [...prev.completedNodes, node] };
              if (node === "medical_scoring") { next.medicalScore = data.medical_score ?? null; next.medicalReasons = data.medical_reasons ?? []; }
              else if (node === "financial_scoring") { next.financialScore = data.financial_score ?? null; next.financialReasons = data.financial_reasons ?? []; }
              else if (node === "fraud_detection") { next.fraudProbability = data.fraud_probability ?? null; next.fraudReasons = data.fraud_reasons ?? []; }
              else if (node === "decision_aggregation") { next.compositeScore = data.composite_risk_score ?? null; next.aiDecision = data.ai_decision ?? null; next.reasons = data.reasons ?? []; }
              return { ...s, [targetId]: next };
            });
            if (node === "decision_aggregation") setGroupStatuses(s => ({ ...s, [targetId]: "done" }));
          } else if (evt.type === "invalid") {
            setGroupStatuses(s => ({ ...s, [targetId]: "error" }));
            setGroupErrors(s => ({ ...s, [targetId]: `Validation failed: ${(evt.errors as string[]).join("; ")}` }));
            break outer;
          } else if (evt.type === "error") {
            setGroupStatuses(s => ({ ...s, [targetId]: "error" }));
            setGroupErrors(s => ({ ...s, [targetId]: evt.message ?? "An unexpected error occurred." }));
            break outer;
          } else if (evt.type === "saved") {
            // Refresh the case shell only if this plan is the one on screen.
            if (targetId === currentCaseIdRef.current) fetchDetail();
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setGroupStatuses(s => ({ ...s, [targetId]: "error" }));
      setGroupErrors(s => ({ ...s, [targetId]: err.message ?? "Connection failed." }));
    }
  }, [tenantId, fetchDetail]);

  // Kick off underwriting for every plan in the group in parallel, exactly once.
  useEffect(() => {
    if (!isGroup || !tenantId) return;
    const sig = planGroup.map(p => p.caseId).join(",");
    if (groupStartedRef.current === sig) return;
    groupStartedRef.current = sig;
    planGroup.forEach(p => runGroupCase(p.caseId));
  }, [isGroup, planGroup, tenantId, runGroupCase]);

  // ── Manual override (writes to the real CaseHistory audit trail) ────────────

  const overrideStatus = async (newStatus: string) => {
    if (!tenantId) return;
    setOverriding(newStatus);
    try {
      await api.patch(`/tenants/${tenantId}/cases/${caseId}/status`, { status: newStatus });
      await fetchDetail();
      if (newStatus === "Approved") {
        setSuccessMessage("Case successfully approved and forwarded to Issuance Queue.");
        setTimeout(() => router.push("/policy-issuance"), 1200);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to update case status.");
    } finally {
      setOverriding(null);
    }
  };

  // Ask the summarizer to draft a concise underwriter note from the case
  // context assembled at the call site (customer, policy, scores, decision,
  // reasons). The draft lands in the textarea for review/edit before posting.
  const generateNote = async (context: string) => {
    setGeneratingNote(true);
    setNoteGenError(null);
    try {
      const res = await summarizerApi.post<{ summary: string }>("/summarize/underwriter-note", { context });
      setNote(res.data.summary.trim());
    } catch (err: any) {
      setNoteGenError(err.message ?? "Failed to generate note.");
    } finally {
      setGeneratingNote(false);
    }
  };

  const downloadPDF = async () => {
    if (!customer || (!hasLive && !assessment)) return;
    const { generateAssessmentPDF } = await import("@/lib/pdf-export");

    await generateAssessmentPDF({
      customer_name: customer.name,
      customer_cnic: customer.cnic,
      case_id: caseId,
      created_at: hasLive ? new Date().toISOString() : assessment!.created_at,
      medical_score: medicalScore,
      financial_score: financialScore,
      fraud_probability: fraudProbability,
      composite_risk_score: compositeScore,
      ai_decision: aiDecision ?? "Pending",
      suggested_loading: suggestedLoading,
      reasons: hasLive ? [...medicalReasons, ...financialReasons, ...fraudReasons] : (assessment?.reasons ?? []),
      ai_summary: docSummary ?? null,
      product_name: policy?.product_name ?? null,
    });
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

  // Generate the full application dossier PDF from the current case detail.
  const downloadApplication = async () => {
    if (!detail) return;
    setDownloadingApp(true);
    setError(null);
    try {
      const { generateApplicationPDF } = await import("@/lib/application-pdf");
      await generateApplicationPDF(detail as any);
    } catch (err: any) {
      setError(err.message ?? "Failed to generate application PDF.");
    } finally {
      setDownloadingApp(false);
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

  const { case: c, customer, policy, document_checklist: docs } = detail;

  // Underwriting requires every mandatory document to be uploaded first — the
  // Run / Re-run buttons stay disabled until the checklist has nothing missing.
  const missingRequiredDocs = docs?.missing ?? [];
  const requiredDocsMissing = missingRequiredDocs.length > 0;

  // In a multi-plan group each plan streams in parallel into its own slice of the
  // maps; otherwise fall back to the single-case state. Everything below renders
  // whichever plan is currently on screen.
  const effStreamError = isGroup ? (groupErrors[caseId] ?? null) : streamError;
  const handleRun = () => (isGroup ? runGroupCase(caseId, true) : runUnderwriting());

  // Prefer the live (just-streamed) result for this session; fall back to the
  // last persisted assessment. Live gives per-category reasons; persisted only
  // has the flat merged `reasons` array (decision_aggregation merges them
  // before writing to the DB), so the two render slightly differently below.
  const assessment = detail.latest_assessment;
  const hasAny = hasLive || assessment !== null;

  const medicalScore = hasLive ? effLive.medicalScore! : assessment?.medical_score ?? 0;
  const financialScore = hasLive ? effLive.financialScore! : assessment?.financial_score ?? 0;
  const fraudProbability = hasLive ? effLive.fraudProbability! : assessment?.fraud_probability ?? 0;
  const compositeScore = hasLive ? effLive.compositeScore! : assessment?.composite_risk_score ?? 0;
  const aiDecision = (hasLive ? effLive.aiDecision : assessment?.ai_decision) ?? null;
  const suggestedLoading = hasLive ? null : assessment?.suggested_loading ?? null;
  const fraudPct = +((fraudProbability ?? 0) * 100).toFixed(1);

  // Per-category explainability reasons — from the live stream when available,
  // otherwise from the persisted assessment. Rendering the same Medical /
  // Financial / Fraud breakdown for every plan (single or multi, live or saved)
  // keeps the Explainability Report format identical across the board.
  const medicalReasons = hasLive ? effLive.medicalReasons : (assessment?.medical_reasons ?? []);
  const financialReasons = hasLive ? effLive.financialReasons : (assessment?.financial_reasons ?? []);
  const fraudReasons = hasLive ? effLive.fraudReasons : (assessment?.fraud_reasons ?? []);
  // Legacy assessments predate the per-category columns; fall back to the flat
  // merged list only when no categorized reasons exist at all.
  const hasCategorizedReasons =
    hasLive || medicalReasons.length + financialReasons.length + fraudReasons.length > 0;

  // Single source of truth for the AI Analysis — both the list and table views
  // render from this so the two stay perfectly in sync.
  const reasonSections: ReasonSection[] = [
    { label: "Medical Risk Factors", short: "Medical", icon: "🩺", score: medicalScore, scoreLabel: `${medicalScore}%`, reasons: medicalReasons, accentColor: "text-slate-800" },
    { label: "Financial Risk Factors", short: "Financial", icon: "💰", score: financialScore, scoreLabel: `${financialScore}%`, reasons: financialReasons, accentColor: "text-slate-800" },
    { label: "Fraud Risk Factors", short: "Fraud", icon: "🛡️", score: fraudPct, scoreLabel: `${fraudPct}%`, reasons: fraudReasons, accentColor: "text-slate-800" },
  ];

  // Compact case context handed to the AI note generator — mirrors what the
  // underwriter sees on screen so the drafted note is grounded in real data.
  const buildNoteContext = (): string => {
    const lines: string[] = [];
    if (customer) {
      const age = customer.dob ? Math.floor((Date.now() - new Date(customer.dob).getTime()) / 31557600000) : null;
      lines.push(`Applicant: ${customer.name}${age ? `, age ${age}` : ""}, ${customer.gender}${customer.occupation ? `, ${customer.occupation}` : ""}.`);
      lines.push(`Smoker: ${customer.is_smoker ? "Yes" : "No"}. Declared income: ${customer.declared_income ? fmtIncome(customer.declared_income) : "unknown"}.`);
    }
    if (policy) {
      lines.push(`Policy: ${INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.product_name}, coverage ${fmtCoverage(policy.coverage_amount)}, term ${policy.term_years} years.`);
    }
    if (hasAny) {
      lines.push(`Risk scores — Medical ${medicalScore}%, Financial ${financialScore}%, Fraud ${fraudPct}%, Composite ${compositeScore}%.`);
      if (aiDecision) lines.push(`AI recommended decision: ${aiDecision}${suggestedLoading ? ` with suggested loading ${suggestedLoading}%` : ""}.`);
      const factorLines = reasonSections
        .filter(s => s.reasons.length > 0)
        .map(s => `${s.short} factors: ${s.reasons.join("; ")}.`);
      if (factorLines.length) lines.push(...factorLines);
      else if (assessment?.reasons?.length) lines.push(`Key factors: ${assessment.reasons.join("; ")}.`);
    }
    if (docSummary) lines.push(`Document summary: ${docSummary.replace(/[#*]/g, "").replace(/\s+/g, " ").trim().slice(0, 600)}`);
    return lines.join("\n");
  };

  downloadPDFRef.current = downloadPDF;
  triggerNotesRef.current = () => generateNote(buildNoteContext());

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-5">
      {successMessage && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-top-5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5 text-emerald-100">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <div className="font-semibold text-sm">{successMessage}</div>
        </div>
      )}

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
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">{customer?.name ?? "Unknown Customer"}</h1>
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

        {/* Action buttons — once the case has reached a final decision (either
            via this override or the AI's own Auto Approve/Decline), there's
            nothing left to override, so hide the decision buttons entirely
            rather than let a stale/redundant click re-assert the same status
            and bounce off the policy state machine ("Approved → Approved"). */}
        {c.caseStatus !== "Approved" && c.caseStatus !== "Rejected" && (
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
              disabled={overriding !== null || !hasAny}
              title={!hasAny ? "Run AI Underwriting before approving" : undefined}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {overriding === "Approved" ? <Spinner /> : "Override: Proceed"}
            </button>
          </div>
        )}

        {/* Final step after underwriting — generate the full application dossier */}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          <button
            onClick={downloadApplication}
            disabled={downloadingApp}
            title={hasAny ? "Download the complete application dossier (PDF)" : "Best generated after underwriting — includes whatever detail is available"}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors shadow-sm"
          >
            {downloadingApp ? <Spinner /> : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
              </svg>
            )}
            {downloadingApp ? "Generating…" : "Download Application"}
          </button>
        </div>
      </div>

      {/* ── Plan switcher (multi-plan underwriting group) ─────────────────── */}
      {isGroup && (() => {
        const doneCount = planGroup.filter((p) => groupStatuses[p.caseId] === "done").length;
        const runningCount = planGroup.filter((p) => groupStatuses[p.caseId] === "streaming").length;
        const glyph = (st?: StreamStatus) => (st === "done" ? "✓" : st === "streaming" ? "⏳" : st === "error" ? "⚠" : "•");
        return (
          <div className="card px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3 border-blue-200 bg-blue-50/40">
            <div className="flex items-center gap-2.5 min-w-0 sm:flex-1">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-blue-100 text-blue-700 flex-shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-700 truncate">
                  Underwriting {planGroup.length} plans for {customer?.name ?? "this customer"}
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {runningCount > 0
                    ? `${doneCount} of ${planGroup.length} done · ${runningCount} running in parallel`
                    : `${doneCount} of ${planGroup.length} plans underwritten`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 min-w-0 sm:flex-shrink-0">
              <span className="text-[11px] font-medium text-slate-400 flex-shrink-0 hidden sm:inline">Viewing</span>
              <select
                value={caseId}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next !== caseId) router.push(`/case/${next}`);
                }}
                className="w-full sm:w-72 min-w-0 truncate bg-white border border-slate-200 rounded-lg pl-3 pr-8 py-2 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
              >
                {planGroup.map((p, i) => (
                  <option key={p.caseId} value={p.caseId}>
                    {glyph(groupStatuses[p.caseId])}  {i + 1}. {p.planLabel}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })()}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {/* ── Main grid: 3 cols ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── LEFT COLUMN: Customer + Policy ─────────────────────────────── */}
        <div className="lg:col-span-1 space-y-4">

          {customer && (
            <div className="card p-5">
              <div className="flex items-center gap-3 mb-4 pb-4 border-b border-slate-100">
                <InitialsAvatar name={!detail?.is_principal_participant && detail?.principal_participant_name ? detail.principal_participant_name : customer.name} />
                <div>
                  <p className="font-bold text-slate-900 leading-tight">
                    {!detail?.is_principal_participant && detail?.principal_participant_name ? detail.principal_participant_name : customer.name}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {detail?.principal_participant_name || detail?.is_principal_participant ? "Principal Participant" : customer.gender}
                  </p>
                  <p className="text-xs text-blue-600 font-mono mt-0.5">{(!detail?.principal_participant_name || detail?.is_principal_participant) ? customer.cnic : "Family Group Owner"}</p>
                </div>
              </div>
              {!detail?.is_principal_participant && detail?.principal_participant_name && (
                <div className="mb-4 bg-blue-50 border border-blue-100 rounded-lg p-3">
                  <p className="text-xs font-semibold text-blue-800">Dependent Member</p>
                  <p className="text-xs text-blue-600 mt-0.5 leading-snug">
                    <span className="font-bold">{customer.name}</span> ({detail.family_relationship || "Dependent"}) belongs to <span className="font-bold">{detail.principal_participant_name}</span>'s family policy.
                  </p>
                </div>
              )}
              {detail?.organization_name && (
                <div className="mb-4 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-slate-700">
                    Company: <span className="font-bold">{detail.organization_name}</span>
                  </p>
                  {detail.organization_members && detail.organization_members.length > 1 ? (
                    <>
                      <label className="block text-[11px] font-semibold text-slate-500">Switch to another member of this company</label>
                      <select
                        value={detail.case.caseld ?? ""}
                        onChange={(e) => {
                          const target = e.target.value;
                          if (target && target !== detail.case.caseld) router.push(`/case/${target}`);
                        }}
                        className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs"
                      >
                        {detail.organization_members.map((m) => (
                          <option key={m.case_id} value={m.case_id}>
                            {m.name} — {m.case_number} ({m.case_status})
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <p className="text-xs text-slate-500">No other company members are currently in underwriting.</p>
                  )}
                </div>
              )}

              <Accordion title="Customer Details">
                {detail?.principal_participant_name && (
                  <DataRow label="Member Name" value={customer.name} />
                )}
                {detail?.is_principal_participant && (
                  <DataRow label="Family Role" value="Principal Participant" />
                )}
                <DataRow label="Date of Birth" value={fmtDob(customer.dob)} />
                <DataRow label="Gender" value={customer.gender} />
                <DataRow label="Marital Status" value={customer.marital_status || <span className="text-slate-400 italic">Missing</span>} />
                <DataRow label="Occupation" value={customer.occupation || <span className="text-slate-400 italic">Missing</span>} />
                <DataRow label="Declared Annual Income" value={customer.declared_income ? fmtIncome(customer.declared_income) : <span className="text-slate-400 italic">Missing</span>} />
              </Accordion>

              <Accordion title="Contact Information">
                <DataRow
                  label="Address"
                  value={
                    (() => {
                      const addr = customer.details?.address;
                      if (!addr) return <span className="text-slate-400 italic">Missing</span>;
                      if (typeof addr === "string") return addr;
                      const str = [addr.street_address, addr.area, addr.city, addr.province].filter(Boolean).join(", ");
                      return str || <span className="text-slate-400 italic">Missing</span>;
                    })()
                  }
                />
                <DataRow label="City" value={customer.details?.address?.city || customer.details?.city || <span className="text-slate-400 italic">Missing</span>} />
                <DataRow label="Phone" value={customer.details?.phone || <span className="text-slate-400 italic">Missing</span>} />
                <DataRow label="Email" value={customer.details?.email || <span className="text-slate-400 italic">Missing</span>} />
              </Accordion>

              <Accordion title="Medical & Lifestyle">
                <DataRow label="Smoker" value={customer.is_smoker ? "Yes" : "No"} />
                <DataRow label="Height" value={customer.height_cm ? `${customer.height_cm} cm` : <span className="text-slate-400 italic">Missing</span>} />
                <DataRow label="Weight" value={customer.weight_kg ? `${customer.weight_kg} kg` : <span className="text-slate-400 italic">Missing</span>} />
              </Accordion>

              <Accordion title="Lead Generated By">
                {customer.acquisition_source ? (
                  <>
                    <DataRow label="Source" value={customer.acquisition_source.name} />
                    <DataRow
                      label="Channel"
                      value={
                        <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                          {SOURCE_TYPE_LABELS[customer.acquisition_source.source_type] ?? customer.acquisition_source.source_type}
                        </span>
                      }
                    />
                    {customer.acquisition_source.partner_name && (
                      <DataRow label="Partner" value={customer.acquisition_source.partner_name} />
                    )}
                    <DataRow label="Producer Code" value={<span className="font-mono text-xs">{customer.acquisition_source.code}</span>} />
                  </>
                ) : (
                  <p className="text-xs text-slate-400 italic">Not recorded</p>
                )}
              </Accordion>
            </div>
          )}

          {policy && (
            <div className="card p-5">
              <Accordion title="Policy Details">
                <DataRow label="Product" value={INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.product_name} />
                <DataRow label="Coverage Amount" value={fmtCoverage(policy.coverage_amount)} />
                <DataRow label="Policy Term" value={`${policy.term_years} years`} />
                {customer && (
                  <DataRow label="Coverage-to-Income Ratio" value={`${(policy.coverage_amount / customer.declared_income).toFixed(1)}×`} />
                )}
                <DataRow label="Policy Status" value={policy.status} />
              </Accordion>

              <Accordion title="Case">
                <DataRow label="Case Number" value={c.caseNumber} />
                <DataRow label="Type" value={c.caseType} />
                <DataRow label="Priority" value={c.priorityLevel} />
                <DataRow label="Channel" value={c.sourceChannel} />
              </Accordion>
            </div>
          )}

          {/* Document checklist + upload */}
          <div className="card p-5">
            <Accordion
              title="Documents"
              action={<button onClick={() => setShowUpload(true)} className="text-xs font-semibold text-blue-600 hover:text-blue-700">+ Upload</button>}
            >
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
            </Accordion>
          </div>

          {/* Quick score summary */}
          {hasAny && (
            <div className="card p-5">
              <Accordion title="Score Summary">
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">Medical Risk</span>
                    <span className="font-bold text-slate-900">{medicalScore}%</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">Financial Risk</span>
                    <span className="font-bold text-slate-900">{financialScore}%</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">Fraud Risk</span>
                    <span className="font-bold text-slate-900">{fraudPct}%</span>
                  </div>
                  <div className="h-px bg-slate-100 my-1" />
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-semibold text-slate-700">Composite Score</span>
                    <span className="font-extrabold text-slate-900">{compositeScore}%</span>
                  </div>
                </div>
              </Accordion>
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
              <p className="text-xs text-slate-400">Upload and OCR document(s) to generate a medical / financial / occupational summary.</p>
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
                onClick={handleRun}
                disabled={effStatus === "streaming" || !policy || !customer || requiredDocsMissing}
                title={requiredDocsMissing ? `Upload required document(s) first: ${missingRequiredDocs.join(", ")}` : undefined}
                className="mt-2 flex items-center gap-2 px-5 py-2.5 bg-blue-700 text-white rounded-lg text-sm font-semibold hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {effStatus === "streaming" ? <Spinner /> : null}
                {effStatus === "streaming" ? "Running…" : "Run AI Underwriting"}
              </button>
              {requiredDocsMissing && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 max-w-sm">
                  Required document{missingRequiredDocs.length > 1 ? "s" : ""} missing: <span className="font-semibold">{missingRequiredDocs.join(", ")}</span>. Upload {missingRequiredDocs.length > 1 ? "them" : "it"} to enable underwriting.
                </p>
              )}
              {effStreamError && !requiredDocsMissing && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{effStreamError}</p>}
            </div>
          ) : (
            <>
              {/* Risk Assessment Scores */}
              <SectionCard title="AI Risk Assessment">
                <div className="space-y-5">
                  <RiskScoreBar label="Medical Risk Score" score={medicalScore} valueLabel={`${medicalScore}%`} />
                  <RiskScoreBar label="Financial Risk Score" score={financialScore} valueLabel={`${financialScore}%`} />
                  <RiskScoreBar label="Fraud Risk Score" score={fraudPct} valueLabel={`${fraudPct}%`} />
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
                    onClick={handleRun}
                    disabled={effStatus === "streaming" || requiredDocsMissing}
                    title={requiredDocsMissing ? `Upload required document(s) first: ${missingRequiredDocs.join(", ")}` : undefined}
                    className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {effStatus === "streaming" ? <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" /> : null}
                    {/* {effStatus === "streaming" ? "Re-running…" : "Re-run Underwriting"} */}
                  </button>
                </div>

                {aiDecision && <DecisionBanner decision={aiDecision} />}
                {effStreamError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{effStreamError}</p>}



                {/* Explainability report — list (grouped) or table (compact) view */}
                <div className="pt-2 border-t border-slate-100">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-bold uppercase tracking-widest text-slate-700">AI Analysis</p>
                    {hasCategorizedReasons && (
                      <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                        <button
                          onClick={() => setAnalysisView("list")}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${analysisView === "list" ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                          </svg>
                          List
                        </button>
                        <button
                          onClick={() => setAnalysisView("table")}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${analysisView === "table" ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M12 4v16M4 4h16v16H4z" />
                          </svg>
                          Table
                        </button>
                      </div>
                    )}
                  </div>
                  {hasCategorizedReasons ? (
                    analysisView === "list" ? (
                      <div className="space-y-5">
                        {reasonSections.map(s => (
                          <ReasonGroup key={s.label} label={s.label} scoreLabel={s.scoreLabel} reasons={s.reasons} accentColor={s.accentColor} />
                        ))}
                      </div>
                    ) : (
                      <ReasonTable sections={reasonSections} />
                    )
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

                  {/* Download PDF for this specific plan */}
                  {assessment && (
                    <div className="mt-5 flex justify-end">
                      <button
                        onClick={downloadPDF}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors shadow-sm"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
                        </svg>
                        Download PDF Report
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Underwriter notes */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">Underwriter Notes</p>
              <button
                onClick={() => generateNote(buildNoteContext())}
                disabled={generatingNote || !hasAny}
                title={hasAny ? "Draft a note from the case details with AI" : "Run underwriting first to generate a note"}
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {generatingNote
                  ? <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" />
                  : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>}
                {generatingNote ? "Generating…" : "Generate with AI"}
              </button>
            </div>
            {noteGenError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{noteGenError}</p>}
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              className="w-full h-24 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 resize-none placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              placeholder="Add case notes, override justification, or referral comments here — or click Generate with AI for a draft…"
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

      {/* ── AI Assessment Report Modal ────────────────────────────────────── */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 lg:p-8 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-auto">

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-4">
                <img src="/rizvi.png" alt="Rizviz" className="h-8" />
                <div className="h-6 w-px bg-slate-300"></div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900 tracking-tight">AI Underwriting Assessment</h2>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">Applicant: {customer?.name} &nbsp;·&nbsp; Case: {c.caseNumber}</p>
                </div>
              </div>
              <button onClick={() => setShowReportModal(false)} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-full transition-colors focus:outline-none">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Body */}
            <div className="p-6 md:p-8 space-y-8 bg-white overflow-y-auto max-h-[75vh]">

              {/* Hero Decision Section */}
              <div className="flex flex-col items-center justify-center text-center space-y-3 pb-8 border-b border-slate-100">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Final AI Decision</h3>
                {aiDecision ? (
                  <div className="scale-125 transform-origin-center my-1">
                    <StatusBadge decision={aiDecision} size="lg" />
                  </div>
                ) : (
                  <span className="text-xl font-bold text-slate-400 my-1">Pending</span>
                )}
                {suggestedLoading !== null && (
                  <p className="text-sm font-semibold text-amber-800 bg-amber-50 px-4 py-1.5 rounded-full border border-amber-200/50 mt-2 shadow-sm">
                    Suggested Loading: +{suggestedLoading}%
                  </p>
                )}

                <div className="w-full max-w-lg mt-8">
                  <div className="flex justify-between items-end mb-2">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Composite Risk</span>
                    <span className="text-3xl font-black text-slate-900 tracking-tighter">{compositeScore}%</span>
                  </div>
                  <div className="h-3.5 w-full bg-slate-100 rounded-full overflow-hidden shadow-inner">
                    <div
                      className={`h-full rounded-full transition-all duration-1000 ${compositeScore <= 30 ? "bg-emerald-500" :
                        compositeScore <= 70 ? "bg-amber-500" : "bg-red-500"
                        }`}
                      style={{ width: `${compositeScore}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {reasonSections.map((section, idx) => (
                  <div key={idx} className="bg-slate-50/80 rounded-2xl border border-slate-200/60 p-6 flex flex-col text-left shadow-sm">
                    <div className="flex justify-between items-start mb-4">
                      <span className="text-[11px] font-extrabold text-slate-500 uppercase tracking-widest">{section.label}</span>
                      <span className={`text-2xl font-black ${section.accentColor}`}>{section.scoreLabel}</span>
                    </div>

                    <ul className="w-full space-y-2.5">
                      {section.reasons.length > 0 ? (
                        section.reasons.map((r, rIdx) => {
                          const isObj = typeof r === "object" && r !== null;
                          const text = isObj ? `${r.parameter || r.factor}: ${r.observation || r.reason}` : (r as string);
                          return (
                            <li key={rIdx} className="text-[13px] text-slate-700 flex items-start gap-2.5 leading-relaxed">
                              <span className={`mt-[3px] font-bold ${section.accentColor}`}>•</span> {text.replace(/\*\*/g, "")}
                            </li>
                          );
                        })
                      ) : (
                        <li className="text-[13px] text-slate-400 italic py-2">No significant risk factors flagged.</li>
                      )}
                    </ul>
                  </div>
                ))}
              </div>

            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 bg-slate-50 border-t border-slate-200/80">
              <span className="text-xs text-slate-500 font-medium">
                Generated {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={downloadPDF}
                  className="px-5 py-2.5 text-[13px] font-bold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 shadow-sm transition-all flex items-center gap-2 focus:ring-2 focus:ring-slate-200"
                >
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  Save PDF
                </button>
                <button
                  onClick={() => setShowReportModal(false)}
                  className="px-6 py-2.5 text-[13px] font-bold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 shadow-sm shadow-blue-600/20 transition-all focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                >
                  Done
                </button>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
