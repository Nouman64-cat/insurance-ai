"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import api from "@/app/services/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Applicant {
  id: string;
  cnic: string;
  name: string;
}

interface CaseItem {
  caseld: string;
  caseNumber: string;
  applicant_id: string;
  caseType: string;
  caseStatus: string;
  priorityLevel: string;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
}

interface Artifact {
  id: string;
  case_id: string;
  applicant_id: string;
  document_type: string;
  file_name: string;
  file_size: number;
  file_type: string;
  storage_url: string;
  download_url: string;
  ocr_result: string;
  ocr_confidence_score: number;
  authenticity_score: number;
  quality_score: number;
  tampered_flag: boolean;
  status: string;
  created_at: string;
}

type View = "applicants" | "cases" | "documents";

// ── Constants ────────────────────────────────────────────────────────────────

const CASE_TYPE_OPTIONS = ["Underwriting", "Claim", "Inquiry"];
const PRIORITY_OPTIONS = ["Low", "Normal", "High", "Critical"];
const CHANNEL_OPTIONS = ["Online", "Agent", "Branch"];
const STATUS_OPTIONS = ["New", "InProgress", "Pending Documents", "Under Review", "Approved", "Rejected", "Closed"];
const DOCUMENT_TYPES = ["CNIC", "Salary Slip", "Medical Report", "X-Ray", "MRI Scan", "Bank Statement", "Tax Return", "Policy Form", "Claim Form", "Other"];
const SUPPORTED_EXTS = ["pdf", "png", "jpg", "jpeg", "tiff", "bmp"];

const STATUS_CHIP: Record<string, string> = {
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
  InProgress: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200",
  New: "bg-slate-100 text-slate-600 border-slate-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  Closed: "bg-slate-200 text-slate-700 border-slate-300",
  Accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Re-submission Requested": "bg-amber-50 text-amber-700 border-amber-200",
  Processing: "bg-blue-50 text-blue-700 border-blue-200",
};

const PRIORITY_COLOR: Record<string, string> = {
  Critical: "text-red-600",
  High: "text-orange-500",
  Normal: "text-slate-500",
  Low: "text-slate-400",
};

const FILE_COLOR: Record<string, { bg: string; ext: string; dot: string }> = {
  pdf:  { bg: "bg-red-500",    ext: "PDF", dot: "bg-red-400" },
  png:  { bg: "bg-sky-500",    ext: "PNG", dot: "bg-sky-400" },
  jpg:  { bg: "bg-amber-500",  ext: "JPG", dot: "bg-amber-400" },
  jpeg: { bg: "bg-amber-500",  ext: "JPG", dot: "bg-amber-400" },
  tiff: { bg: "bg-teal-500",   ext: "TIF", dot: "bg-teal-400" },
  bmp:  { bg: "bg-purple-500", ext: "BMP", dot: "bg-purple-400" },
};
const FILE_COLOR_DEFAULT = { bg: "bg-slate-400", ext: "DOC", dot: "bg-slate-300" };

function getExt(name: string) { return name?.split(".").pop()?.toLowerCase() ?? ""; }
function fmtSize(bytes: number) {
  if (!bytes) return "—";
  return bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SpinnerIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function FolderSvg({ color = "#F59E0B", accent = "#D97706", size = 56 }: { color?: string; accent?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none">
      <rect x="2" y="16" width="52" height="34" rx="4" fill={color} />
      <path d="M2 20c0-2.21 1.79-4 4-4h18l4 5H50a4 4 0 014 4v25a4 4 0 01-4 4H6a4 4 0 01-4-4V20z" fill={color} />
      <path d="M2 25h52v25a4 4 0 01-4 4H6a4 4 0 01-4-4V25z" fill={accent} opacity="0.25" />
      <rect x="2" y="25" width="52" height="2" fill={accent} opacity="0.3" />
    </svg>
  );
}

function FileSvg({ ext, size = 52 }: { ext: string; size?: number }) {
  const fc = FILE_COLOR[ext] ?? FILE_COLOR_DEFAULT;
  return (
    <svg width={size} height={size} viewBox="0 0 52 56" fill="none">
      <path d="M6 2h28l12 12v38a4 4 0 01-4 4H6a4 4 0 01-4-4V6a4 4 0 014-4z" fill="#F8FAFC" stroke="#E2E8F0" strokeWidth="1.5" />
      <path d="M34 2l12 12H38a4 4 0 01-4-4V2z" fill="#E2E8F0" />
      <rect x="10" y="26" width="32" height="3" rx="1.5" fill="#CBD5E1" />
      <rect x="10" y="32" width="24" height="3" rx="1.5" fill="#CBD5E1" />
      <rect x="10" y="38" width="28" height="3" rx="1.5" fill="#CBD5E1" />
      <rect x="10" y="44" width="18" height="3" rx="1.5" fill="#E2E8F0" />
      <rect x="6" y="14" width="20" height="10" rx="2" className={fc.bg} fill="currentColor" />
      <text x="16" y="22" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="monospace">{fc.ext}</text>
    </svg>
  );
}

// ── Explorer item card ────────────────────────────────────────────────────────

interface ExplorerItemProps {
  id: string;
  icon: React.ReactNode;
  name: string;
  line2?: React.ReactNode;
  badge?: React.ReactNode;
  isSelected: boolean;
  onSingleClick: () => void;
  onDoubleClick: () => void;
  actions?: React.ReactNode;
}

function ExplorerItem({ id, icon, name, line2, badge, isSelected, onSingleClick, onDoubleClick, actions }: ExplorerItemProps) {
  return (
    <div
      className={`group relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl cursor-pointer transition-all duration-100 select-none ${
        isSelected
          ? "bg-blue-100 ring-2 ring-blue-400 ring-offset-1"
          : "hover:bg-slate-100"
      }`}
      onClick={onSingleClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Hover action overlay */}
      {actions && (
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
          {actions}
        </div>
      )}

      {/* Icon */}
      <div className="flex items-center justify-center w-16 h-12">
        {icon}
      </div>

      {/* Label */}
      <div className="w-full text-center space-y-0.5">
        <p className="text-[11px] font-semibold text-slate-800 leading-tight line-clamp-2 break-words">{name}</p>
        {line2 && <div className="text-[10px] text-slate-400 leading-tight">{line2}</div>}
        {badge && <div className="flex justify-center mt-0.5">{badge}</div>}
      </div>
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Breadcrumb({ view, applicant, caseItem, onGoApplicants, onGoCases }: {
  view: View;
  applicant: Applicant | null;
  caseItem: CaseItem | null;
  onGoApplicants: () => void;
  onGoCases: () => void;
}) {
  return (
    <nav className="flex items-center gap-1 text-sm min-w-0 overflow-x-auto">
      <button onClick={onGoApplicants} className={`font-semibold whitespace-nowrap transition-colors ${view === "applicants" ? "text-slate-800" : "text-blue-600 hover:text-blue-700"}`}>
        Applicants
      </button>
      {applicant && (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-slate-400 flex-shrink-0">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <button onClick={onGoCases} className={`font-semibold truncate max-w-[180px] transition-colors ${view === "cases" ? "text-slate-800" : "text-blue-600 hover:text-blue-700"}`}>
            {applicant.name}
          </button>
        </>
      )}
      {caseItem && (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-slate-400 flex-shrink-0">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="font-semibold text-slate-800 truncate max-w-[180px]">{caseItem.caseNumber}</span>
        </>
      )}
    </nav>
  );
}

// ── Confidence bar ────────────────────────────────────────────────────────────

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold text-slate-700">{pct}%</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Small icon buttons ────────────────────────────────────────────────────────

function IBtn({ title, onClick, danger = false, children }: { title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick(e); }}
      className={`w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold shadow-sm transition-colors ${
        danger
          ? "bg-red-100 text-red-600 hover:bg-red-200 border border-red-200"
          : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ icon, title, subtitle, action }: { icon: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-16">
      <div className="opacity-20">{icon}</div>
      <div className="text-center">
        <p className="text-sm font-semibold text-slate-600">{title}</p>
        {subtitle && <p className="text-xs text-slate-400 mt-1 max-w-xs">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Modals ────────────────────────────────────────────────────────────────────

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div>
            <h3 className="font-bold text-slate-800">{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors p-1 -mr-1 -mt-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function CreateCaseModal({ applicant, onClose, onCreated }: { applicant: Applicant; onClose: () => void; onCreated: () => void }) {
  const [caseType, setCaseType] = useState("Underwriting");
  const [priority, setPriority] = useState("Normal");
  const [channel, setChannel] = useState("Online");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setSubmitting(true);
    setErr("");
    try {
      await api.post(`/tenants/${tenantId}/cases`, {
        applicant_id: applicant.id,
        caseType,
        priorityLevel: priority,
        sourceChannel: channel,
      });
      onCreated();
    } catch (err: any) {
      setErr(err.response?.data?.detail ?? "Failed to create case.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="New Case" subtitle={`Applicant: ${applicant.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Case Type">
          <select value={caseType} onChange={e => setCaseType(e.target.value)} className={SELECT}>
            {CASE_TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={e => setPriority(e.target.value)} className={SELECT}>
            {PRIORITY_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Source Channel">
          <select value={channel} onChange={e => setChannel(e.target.value)} className={SELECT}>
            {CHANNEL_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </Field>
        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={submitting} className={BTN_PRIMARY}>
            {submitting ? <SpinnerIcon /> : "Create Case"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditCaseModal({ caseItem, onClose, onSaved }: { caseItem: CaseItem; onClose: () => void; onSaved: () => void }) {
  const [priority, setPriority] = useState(caseItem.priorityLevel);
  const [status, setStatus] = useState(caseItem.caseStatus);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setSubmitting(true);
    setErr("");
    try {
      const tasks: Promise<any>[] = [];
      if (priority !== caseItem.priorityLevel) {
        tasks.push(api.put(`/tenants/${tenantId}/cases/${caseItem.caseld}`, { priorityLevel: priority }));
      }
      if (status !== caseItem.caseStatus) {
        tasks.push(api.patch(`/tenants/${tenantId}/cases/${caseItem.caseld}/status`, { status }));
      }
      await Promise.all(tasks);
      onSaved();
    } catch (err: any) {
      setErr(err.response?.data?.detail ?? "Failed to update case.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Edit Case" subtitle={caseItem.caseNumber} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Priority">
          <select value={priority} onChange={e => setPriority(e.target.value)} className={SELECT}>
            {PRIORITY_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={e => setStatus(e.target.value)} className={SELECT}>
            {STATUS_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </Field>
        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        <p className="text-[10px] text-slate-400">Status changes are appended to the immutable CaseHistory audit trail.</p>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={submitting || (priority === caseItem.priorityLevel && status === caseItem.caseStatus)} className={BTN_PRIMARY}>
            {submitting ? <SpinnerIcon /> : "Save Changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface SelectedFile {
  file: File;
  docType: string;
}

function UploadModal({ caseItem, onClose, onUploaded }: { caseItem: CaseItem; onClose: () => void; onUploaded: (artifacts: Artifact[]) => void }) {
  const [docType, setDocType] = useState("CNIC");
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (newFiles: FileList | File[]) => {
    setErr("");
    const validFiles: SelectedFile[] = [];
    for (let i = 0; i < newFiles.length; i++) {
      const f = newFiles[i];
      const ext = getExt(f.name);
      if (!SUPPORTED_EXTS.includes(ext)) {
        setErr(`Unsupported format ".${ext}". Allowed: ${SUPPORTED_EXTS.join(", ").toUpperCase()}`);
        continue;
      }
      if (!files.some(existing => existing.file.name === f.name && existing.file.size === f.size)) {
        validFiles.push({ file: f, docType: docType });
      }
    }
    if (validFiles.length > 0) {
      setFiles(prev => [...prev, ...validFiles]);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(e.target.files);
    }
    e.target.value = "";
  };

  const removeFile = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setUploading(true);
    setErr("");
    
    const results: Artifact[] = [];
    const errors: string[] = [];
    
    for (const f of files) {
      const form = new FormData();
      form.append("document_type", f.docType);
      form.append("file", f.file);
      try {
        const res = await api.post(
          `/tenants/${tenantId}/cases/${caseItem.caseld}/artifacts`,
          form,
          { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 }
        );
        results.push(res.data);
      } catch (err: any) {
        errors.push(`${f.file.name}: ${err.response?.data?.detail ?? err.message ?? "failed"}`);
      }
    }
    
    if (results.length > 0) {
      try {
        const existing = JSON.parse(localStorage.getItem("insurance_ai_processing_docs") || "[]");
        const newItems = results.map(r => ({ id: r.id, name: r.file_name }));
        localStorage.setItem("insurance_ai_processing_docs", JSON.stringify([...existing, ...newItems]));
        window.dispatchEvent(new Event("insurance_ai_new_processing"));
      } catch (e) {
        console.error("Failed to update global processing docs list", e);
      }
    }

    if (errors.length > 0) {
      setErr(`Some uploads failed:\n${errors.join("\n")}`);
      if (results.length > 0) {
        setFiles(prev => prev.filter(f => errors.some(e => e.includes(f.file.name))));
      }
    } else {
      onUploaded(results);
    }
    setUploading(false);
  };

  return (
    <ModalShell title="Upload Document(s)" subtitle={`Case: ${caseItem.caseNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Default Document Type (for new selections)">
          <select value={docType} onChange={e => setDocType(e.target.value)} className={SELECT}>
            {DOCUMENT_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`rounded-xl border-2 cursor-pointer transition-all px-4 py-5 flex flex-col items-center gap-2 ${
            isDragging ? "border-blue-400 bg-blue-50" : "border-dashed border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/40"
          }`}
        >
          <input ref={inputRef} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp" onChange={handleInput} multiple />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-400">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className="text-xs font-semibold text-slate-600">Drop files here or <span className="text-blue-600">browse</span></p>
          <p className="text-[10px] text-slate-400">PDF · PNG · JPG · JPEG · TIFF · BMP</p>
        </div>

        {/* Selected files list */}
        {files.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Selected Files ({files.length})</p>
            <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white shadow-sm">
              {files.map((f, idx) => (
                <div key={idx} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3.5 py-3 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <FileSvg ext={getExt(f.file.name)} size={24} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-700 truncate text-xs">{f.file.name}</p>
                      <p className="text-[10px] text-slate-400">{fmtSize(f.file.size)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <select
                      value={f.docType}
                      onChange={e => {
                        const newType = e.target.value;
                        setFiles(prev => prev.map((item, i) => i === idx ? { ...item, docType: newType } : item));
                      }}
                      className="px-2 py-1 text-[11px] border border-slate-200 rounded bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {DOCUMENT_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeFile(idx); }}
                      className="w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors border border-slate-100 hover:border-red-100"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-line">{err}</p>}

        {uploading && (
          <div className="flex items-center gap-2 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            <SpinnerIcon className="w-3.5 h-3.5" />
            Uploading to S3 and running OCR — this may take up to 30 seconds…
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} disabled={uploading} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={files.length === 0 || uploading} className={BTN_PRIMARY}>
            {uploading ? <SpinnerIcon /> : <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload &amp; OCR
            </>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ArtifactDetailModal({ artifact: initial, tenantId, onClose, onUpdate }: { artifact: Artifact; tenantId: string; onClose: () => void; onUpdate?: (a: Artifact) => void }) {
  const [artifact, setArtifact] = useState(initial);
  const [loading, setLoading] = useState(!initial.download_url);

  // Fetch fresh presigned URL on open if it wasn't included
  useEffect(() => {
    if (!initial.download_url) {
      api.get(`/tenants/${tenantId}/artifacts/${initial.id}`)
        .then(r => setArtifact(r.data))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [initial.id, tenantId, initial.download_url]);

  // Poll every 3 s while OCR is still pending — modal has its own copy of the artifact
  // so it must poll independently rather than waiting for the parent to push updates.
  useEffect(() => {
    if (artifact.status !== "Processing") return;
    const t = setTimeout(async () => {
      try {
        const res = await api.get(`/tenants/${tenantId}/artifacts/${artifact.id}`);
        const fresh: Artifact = res.data;
        setArtifact(fresh);
        onUpdate?.(fresh);
      } catch { /* ignore transient errors */ }
    }, 3000);
    return () => clearTimeout(t);
  }, [artifact.status, artifact.id, tenantId, onUpdate]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!artifact.ocr_result) return;
    await navigator.clipboard.writeText(artifact.ocr_result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusCls = STATUS_CHIP[artifact.status] ?? "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-3 min-w-0">
            <FileSvg ext={getExt(artifact.file_name ?? "")} size={36} />
            <div className="min-w-0">
              <p className="font-bold text-slate-800 truncate">{artifact.file_name}</p>
              <p className="text-xs text-slate-500">{artifact.document_type} · {fmtSize(artifact.file_size)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-3">
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${statusCls}`}>{artifact.status}</span>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors p-1">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto max-h-[70vh]">
          {loading ? (
            <div className="flex items-center justify-center py-8"><SpinnerIcon className="w-6 h-6 text-slate-400" /></div>
          ) : (
            <>
              {/* Scores */}
              <div className="space-y-2.5">
                <ScoreBar label="OCR Confidence" value={artifact.ocr_confidence_score} color="bg-blue-500" />
                <ScoreBar label="Authenticity" value={artifact.authenticity_score} color="bg-emerald-500" />
                <ScoreBar label="Quality" value={artifact.quality_score} color="bg-violet-500" />
              </div>

              {/* Meta */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider font-bold mb-0.5">File Type</p>
                  <p className="font-medium text-slate-700">{artifact.file_type}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider font-bold mb-0.5">Uploaded</p>
                  <p className="font-medium text-slate-700">{new Date(artifact.created_at).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider font-bold mb-0.5">Tamper Flag</p>
                  <p className={`font-semibold ${artifact.tampered_flag ? "text-red-600" : "text-emerald-600"}`}>
                    {artifact.tampered_flag ? "⚠ Flagged" : "Clean"}
                  </p>
                </div>
              </div>

              {/* Download */}
              {artifact.download_url && (
                <a
                  href={artifact.download_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-slate-700 hover:bg-white transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download from S3 (1h link)
                </a>
              )}

              {/* OCR text */}
              {artifact.ocr_result && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Extracted Text</p>
                    <button onClick={copy} className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 flex items-center gap-1">
                      {copied ? "✓ Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-relaxed font-mono bg-slate-50 border border-slate-200 rounded-lg p-4 max-h-56 overflow-y-auto">
                    {artifact.ocr_result}
                  </pre>
                </div>
              )}

              {!artifact.ocr_result && artifact.status === "Processing" && (
                <div className="flex flex-col items-center gap-2 py-6">
                  <SpinnerIcon className="w-5 h-5 text-blue-400" />
                  <p className="text-xs text-slate-400">OCR in progress — extracting text…</p>
                </div>
              )}

              {!artifact.ocr_result && artifact.status !== "Processing" && (
                <p className="text-xs text-slate-400 text-center py-4">No OCR text extracted for this document.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EditArtifactModal({ artifact, tenantId, onClose, onSaved }: { artifact: Artifact; tenantId: string; onClose: () => void; onSaved: (a: Artifact) => void }) {
  const [docType, setDocType] = useState(artifact.document_type);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setErr("");
    try {
      const res = await api.patch(`/tenants/${tenantId}/artifacts/${artifact.id}`, { document_type: docType });
      onSaved(res.data);
    } catch (err: any) {
      setErr(err.response?.data?.detail ?? "Failed to update.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Edit Document" subtitle={artifact.file_name ?? ""} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Document Type">
          <select value={docType} onChange={e => setDocType(e.target.value)} className={SELECT}>
            {DOCUMENT_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={submitting || docType === artifact.document_type} className={BTN_PRIMARY}>
            {submitting ? <SpinnerIcon /> : "Save"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ConfirmDeleteModal({ title, message, onConfirm, onCancel, deleting }: { title: string; message: string; onConfirm: () => void; onCancel: () => void; deleting: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-red-600">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-slate-800">{title}</h3>
              <p className="text-sm text-slate-500 mt-1">{message}</p>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={onCancel} disabled={deleting} className={BTN_GHOST}>Cancel</button>
            <button onClick={onConfirm} disabled={deleting} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50 transition-all">
              {deleting ? <SpinnerIcon /> : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Form helpers ──────────────────────────────────────────────────────────────

const SELECT = "w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400";
const BTN_PRIMARY = "flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm";
const BTN_GHOST = "px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg border border-transparent transition-colors";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-slate-600">{label}</label>
      {children}
    </div>
  );
}

// ── Case folder color by status ───────────────────────────────────────────────

function caseFolderColor(status: string): { color: string; accent: string } {
  switch (status) {
    case "Approved": return { color: "#34D399", accent: "#059669" };
    case "Rejected": return { color: "#F87171", accent: "#DC2626" };
    case "Pending Documents": return { color: "#FBBF24", accent: "#D97706" };
    case "Under Review":
    case "InProgress": return { color: "#60A5FA", accent: "#2563EB" };
    case "Closed": return { color: "#94A3B8", accent: "#64748B" };
    default: return { color: "#A5B4FC", accent: "#6366F1" };
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface ToastMsg { id: number; text: string; ok: boolean }

function ToastBanner({ toasts, onDismiss }: { toasts: ToastMsg[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg text-sm font-semibold border cursor-pointer select-none transition-all
            ${t.ok
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-amber-50 border-amber-200 text-amber-800"}`}
        >
          {t.ok ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CasesPage() {
  const [view, setView] = useState<View>("applicants");
  const [activeApplicant, setActiveApplicant] = useState<Applicant | null>(null);
  const [activeCase, setActiveCase] = useState<CaseItem | null>(null);

  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  const [loadingMain, setLoadingMain] = useState(true);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Modals
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [editingCase, setEditingCase] = useState<CaseItem | null>(null);
  const [deletingCase, setDeletingCase] = useState<CaseItem | null>(null);
  const [deletingCaseInProgress, setDeletingCaseInProgress] = useState(false);

  const [showUpload, setShowUpload] = useState(false);
  const [viewingArtifact, setViewingArtifact] = useState<Artifact | null>(null);
  const [editingArtifact, setEditingArtifact] = useState<Artifact | null>(null);
  const [deletingArtifact, setDeletingArtifact] = useState<Artifact | null>(null);
  const [deletingArtifactInProgress, setDeletingArtifactInProgress] = useState(false);

  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);
  const showToast = useCallback((text: string, ok: boolean) => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, text, ok }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  // Poll every 3 s while any artifact in the current case view is "Processing".
  // useEffect re-runs whenever artifacts changes so the timeout always resets to
  // 3 s from the last state change, creating a natural retry loop that stops the
  // moment nothing is Processing.
  useEffect(() => {
    if (view !== "documents" || !tenantId) return;
    const processing = artifacts.filter(a => a.status === "Processing");
    if (processing.length === 0) return;

    const t = setTimeout(async () => {
      const results = await Promise.allSettled(
        processing.map(a =>
          api.get(`/tenants/${tenantId}/artifacts/${a.id}`).then(r => r.data as Artifact)
        )
      );
      const updated = results
        .filter((r): r is PromiseFulfilledResult<Artifact> => r.status === "fulfilled")
        .map(r => r.value);
      if (updated.length > 0) {
        setArtifacts(prev => prev.map(a => updated.find(u => u.id === a.id) ?? a));
      }
    }, 3000);

    return () => clearTimeout(t);
  }, [artifacts, view, tenantId]);

  // Load applicants + all cases once
  useEffect(() => {
    setLoadingMain(true);
    Promise.all([
      api.get(`/tenants/${tenantId}/applicants`),
      api.get(`/tenants/${tenantId}/cases`),
    ]).then(([aRes, cRes]) => {
      setApplicants(aRes.data);
      setCases(cRes.data);
    }).catch(err => setError(err.message ?? "Failed to load."))
      .finally(() => setLoadingMain(false));
  }, [tenantId]);

  const fetchArtifacts = useCallback(async (caseId: string) => {
    setLoadingDocs(true);
    try {
      const res = await api.get(`/tenants/${tenantId}/cases/${caseId}/artifacts`);
      setArtifacts(res.data);
    } catch { setArtifacts([]); }
    finally { setLoadingDocs(false); }
  }, [tenantId]);

  // Navigation helpers
  const openApplicant = (applicant: Applicant) => {
    setActiveApplicant(applicant);
    setActiveCase(null);
    setArtifacts([]);
    setSelectedId(null);
    setView("cases");
  };

  const openCase = (c: CaseItem) => {
    setActiveCase(c);
    setSelectedId(null);
    setView("documents");
    fetchArtifacts(c.caseld);
  };

  const goToApplicants = () => {
    setView("applicants");
    setActiveApplicant(null);
    setActiveCase(null);
    setSelectedId(null);
    setArtifacts([]);
  };

  const goToCases = () => {
    setView("cases");
    setActiveCase(null);
    setSelectedId(null);
    setArtifacts([]);
  };

  // CRUD handlers
  const handleDeleteCase = async () => {
    if (!deletingCase) return;
    setDeletingCaseInProgress(true);
    try {
      await api.delete(`/tenants/${tenantId}/cases/${deletingCase.caseld}`);
      setCases(prev => prev.filter(c => c.caseld !== deletingCase.caseld));
      setDeletingCase(null);
    } catch (err: any) {
      alert(err.response?.data?.detail ?? "Failed to delete case.");
    } finally {
      setDeletingCaseInProgress(false);
    }
  };

  const handleDeleteArtifact = async () => {
    if (!deletingArtifact) return;
    setDeletingArtifactInProgress(true);
    try {
      await api.delete(`/tenants/${tenantId}/artifacts/${deletingArtifact.id}`);
      setArtifacts(prev => prev.filter(a => a.id !== deletingArtifact.id));
      if (selectedId === deletingArtifact.id) setSelectedId(null);
      setDeletingArtifact(null);
    } catch (err: any) {
      alert(err.response?.data?.detail ?? "Failed to delete document.");
    } finally {
      setDeletingArtifactInProgress(false);
    }
  };

  const casesForApplicant = activeApplicant
    ? cases.filter(c => c.applicant_id === activeApplicant.id)
    : [];

  const selectedArtifact = artifacts.find(a => a.id === selectedId) ?? null;

  // Status bar text
  const statusText = (() => {
    if (view === "applicants") return `${applicants.length} applicant${applicants.length !== 1 ? "s" : ""}`;
    if (view === "cases") return `${casesForApplicant.length} case${casesForApplicant.length !== 1 ? "s" : ""}`;
    if (view === "documents") {
      const base = `${artifacts.length} document${artifacts.length !== 1 ? "s" : ""}`;
      if (selectedArtifact) return `${base}  ·  ${selectedArtifact.file_name}  ·  ${fmtSize(selectedArtifact.file_size)}  ·  ${selectedArtifact.document_type}  ·  ${selectedArtifact.status}`;
      return base;
    }
    return "";
  })();

  return (
    <div className="flex flex-col h-full bg-slate-50">

      <ToastBanner toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />

      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 px-5 py-3 bg-white border-b border-slate-200 flex-shrink-0">
        {/* Back + breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          {view !== "applicants" && (
            <button
              onClick={view === "documents" ? goToCases : goToApplicants}
              className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors flex-shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-600">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <Breadcrumb
            view={view}
            applicant={activeApplicant}
            caseItem={activeCase}
            onGoApplicants={goToApplicants}
            onGoCases={goToCases}
          />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {view === "cases" && activeApplicant && (
            <button onClick={() => setShowCreateCase(true)} className={BTN_PRIMARY}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Case
            </button>
          )}
          {view === "documents" && activeCase && (
            <button onClick={() => setShowUpload(true)} className={BTN_PRIMARY}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload Document
            </button>
          )}
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0">
        {error && (
          <div className="m-5 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>
        )}

        {loadingMain ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3 text-slate-400">
              <SpinnerIcon className="w-8 h-8" />
              <p className="text-sm font-medium">Loading…</p>
            </div>
          </div>
        ) : (
          <div className="p-5">

            {/* ── Applicants grid ───────────────────────────────────────────── */}
            {view === "applicants" && (
              applicants.length === 0 ? (
                <EmptyState
                  icon={<FolderSvg size={72} />}
                  title="No applicants yet"
                  subtitle="Create an applicant first to start managing cases."
                />
              ) : (
                <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
                  {applicants.map(app => {
                    const count = cases.filter(c => c.applicant_id === app.id).length;
                    return (
                      <ExplorerItem
                        key={app.id}
                        id={app.id}
                        icon={<FolderSvg color="#FBBF24" accent="#D97706" size={52} />}
                        name={app.name}
                        line2={<>{app.cnic}<br />{count} case{count !== 1 ? "s" : ""}</>}
                        isSelected={selectedId === app.id}
                        onSingleClick={() => setSelectedId(app.id)}
                        onDoubleClick={() => openApplicant(app)}
                        actions={null}
                      />
                    );
                  })}
                </div>
              )
            )}

            {/* ── Cases grid ───────────────────────────────────────────────── */}
            {view === "cases" && (
              casesForApplicant.length === 0 ? (
                <EmptyState
                  icon={<FolderSvg color="#93C5FD" accent="#3B82F6" size={72} />}
                  title="No cases yet"
                  subtitle={`${activeApplicant?.name} has no cases. Create the first one.`}
                  action={
                    <button onClick={() => setShowCreateCase(true)} className={BTN_PRIMARY}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      New Case
                    </button>
                  }
                />
              ) : (
                <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))" }}>
                  {casesForApplicant.map(c => {
                    const fc = caseFolderColor(c.caseStatus);
                    const statusCls = STATUS_CHIP[c.caseStatus] ?? "bg-slate-100 text-slate-600 border-slate-200";
                    const priCls = PRIORITY_COLOR[c.priorityLevel] ?? "text-slate-500";
                    return (
                      <ExplorerItem
                        key={c.caseld}
                        id={c.caseld}
                        icon={<FolderSvg color={fc.color} accent={fc.accent} size={52} />}
                        name={c.caseNumber}
                        line2={
                          <span className={priCls}>{c.caseType} · {c.priorityLevel}</span>
                        }
                        badge={
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${statusCls}`}>
                            {c.caseStatus}
                          </span>
                        }
                        isSelected={selectedId === c.caseld}
                        onSingleClick={() => setSelectedId(c.caseld)}
                        onDoubleClick={() => openCase(c)}
                        actions={
                          <>
                            <IBtn title="Edit case" onClick={() => setEditingCase(c)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </IBtn>
                            <IBtn title="Delete case" danger onClick={() => setDeletingCase(c)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                              </svg>
                            </IBtn>
                          </>
                        }
                      />
                    );
                  })}
                </div>
              )
            )}

            {/* ── Documents grid ───────────────────────────────────────────── */}
            {view === "documents" && (
              loadingDocs ? (
                <div className="flex items-center justify-center py-20">
                  <div className="flex flex-col items-center gap-3 text-slate-400">
                    <SpinnerIcon className="w-7 h-7" />
                    <p className="text-sm font-medium">Loading documents…</p>
                  </div>
                </div>
              ) : artifacts.length === 0 ? (
                <EmptyState
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="w-20 h-20 text-slate-300">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  }
                  title="No documents yet"
                  subtitle={`Upload the first document to ${activeCase?.caseNumber}`}
                  action={
                    <button onClick={() => setShowUpload(true)} className={BTN_PRIMARY}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      Upload Document
                    </button>
                  }
                />
              ) : (
                <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
                  {artifacts.map(a => {
                    const ext = getExt(a.file_name ?? "");
                    const statusCls = STATUS_CHIP[a.status] ?? "bg-slate-100 text-slate-600 border-slate-200";
                    const isProcessing = a.status === "Processing";
                    return (
                      <ExplorerItem
                        key={a.id}
                        id={a.id}
                        icon={
                          <div className="relative">
                            <FileSvg ext={ext} size={52} />
                            {isProcessing && (
                              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/70">
                                <SpinnerIcon className="w-5 h-5 text-blue-500" />
                              </div>
                            )}
                          </div>
                        }
                        name={a.file_name ?? "Unknown"}
                        line2={<>{a.document_type}<br />{fmtSize(a.file_size)}</>}
                        badge={
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${statusCls}`}>
                            {a.status}
                          </span>
                        }
                        isSelected={selectedId === a.id}
                        onSingleClick={() => setSelectedId(a.id)}
                        onDoubleClick={() => setViewingArtifact(a)}
                        actions={
                          <>
                            <IBtn title="View / download" onClick={() => setViewingArtifact(a)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            </IBtn>
                            <IBtn title="Edit document type" onClick={() => setEditingArtifact(a)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </IBtn>
                            <IBtn title="Delete document" danger onClick={() => setDeletingArtifact(a)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                              </svg>
                            </IBtn>
                          </>
                        }
                      />
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-slate-200 bg-white px-5 py-1.5">
        <p className="text-[10px] text-slate-400 font-medium">{statusText}</p>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}

      {showCreateCase && activeApplicant && (
        <CreateCaseModal
          applicant={activeApplicant}
          onClose={() => setShowCreateCase(false)}
          onCreated={() => {
            setShowCreateCase(false);
            api.get(`/tenants/${tenantId}/cases`).then(r => setCases(r.data)).catch(() => {});
          }}
        />
      )}

      {editingCase && (
        <EditCaseModal
          caseItem={editingCase}
          onClose={() => setEditingCase(null)}
          onSaved={() => {
            setEditingCase(null);
            api.get(`/tenants/${tenantId}/cases`).then(r => setCases(r.data)).catch(() => {});
          }}
        />
      )}

      {deletingCase && (
        <ConfirmDeleteModal
          title="Delete Case"
          message={`Delete "${deletingCase.caseNumber}" and all its documents? This cannot be undone.`}
          onConfirm={handleDeleteCase}
          onCancel={() => setDeletingCase(null)}
          deleting={deletingCaseInProgress}
        />
      )}

      {showUpload && activeCase && (
        <UploadModal
          caseItem={activeCase}
          onClose={() => setShowUpload(false)}
          onUploaded={newArtifacts => {
            setArtifacts(prev => [...newArtifacts, ...prev]);
            setShowUpload(false);
            if (newArtifacts.length > 0) {
              setViewingArtifact(newArtifacts[0]);
            }
          }}
        />
      )}

      {viewingArtifact && (
        <ArtifactDetailModal
          artifact={viewingArtifact}
          tenantId={tenantId}
          onClose={() => setViewingArtifact(null)}
          onUpdate={updated => {
            setViewingArtifact(updated);
            setArtifacts(prev => prev.map(a => a.id === updated.id ? updated : a));
            if (updated.status !== "Processing") {
              const ok = updated.status === "Accepted";
              showToast(
                ok
                  ? `OCR complete — ${updated.file_name ?? "Document"} accepted`
                  : `OCR complete — ${updated.file_name ?? "Document"} needs re-submission`,
                ok,
              );
            }
          }}
        />
      )}

      {editingArtifact && (
        <EditArtifactModal
          artifact={editingArtifact}
          tenantId={tenantId}
          onClose={() => setEditingArtifact(null)}
          onSaved={updated => {
            setArtifacts(prev => prev.map(a => a.id === updated.id ? updated : a));
            setEditingArtifact(null);
          }}
        />
      )}

      {deletingArtifact && (
        <ConfirmDeleteModal
          title="Delete Document"
          message={`Delete "${deletingArtifact.file_name}" from S3 and the database? This cannot be undone.`}
          onConfirm={handleDeleteArtifact}
          onCancel={() => setDeletingArtifact(null)}
          deleting={deletingArtifactInProgress}
        />
      )}
    </div>
  );
}
