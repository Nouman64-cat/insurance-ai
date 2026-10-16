"use client";

import { runCaseCompliance } from "@/app/services/cases";
import { displayDate } from '../../../lib/dateDisplay';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type ReactMarkdown from "react-markdown";
import LazyMarkdown from "@/components/LazyMarkdown";

import { useNotify } from "@/components/NotificationContext";
import CaseDocumentList from "@/components/case/CaseDocumentList";
import { DecisionBanner, StatusBadge } from "@/components/StatusBadge";
import { RiskScoreBar, CompositeScoreRing, scoreColor, scoreTier } from "@/components/RiskScoreBar";
import {
  fmtCoverage,
  fmtDob,
  fmtIncome,
  type AIDecision,
} from "@/lib/mock-data";
import api, { summarizerApi } from "@/app/services/api";
import { useCaseEvents, type CaseEvent } from "@/lib/agent/useCaseEvents";
import { parentOrigin } from "@/lib/agent/portalMessage";
import { useCoalescedRefresh } from "@/lib/liveRefresh";
import {
  getEApplication,
  inviteEApplication,
  type EApplication,
} from "@/app/services/eApplication";
import {
  getACR,
  requestACR,
  waiveACR,
  reinstateACR,
  isACRCleared,
  type AgentConfidentialReport,
} from "@/app/services/agentConfidentialReport";
import ModalPortal from "@/components/ModalPortal";
import { HoldCaseModal } from "@/components/entities/HoldCaseModal";
import {
  getCompliance,
  clearCompliance,
  failCompliance,
  type ComplianceCheck,
} from "@/app/services/preIssuance";
import {
  getInsuranceHistory,
  runInsuranceHistory,
  clearInsuranceHistory,
  failInsuranceHistory,
  type InsuranceHistory,
} from "@/app/services/insuranceHistory";
import {
  getMedicalExam,
  assessMedicalExam,
  inviteMedicalExam,
  issueLabLink,
  type LabLink,
  waiveMedicalExam,
  recordMedicalResult,
  confirmMedicalReports,
  aiReviewMedicalReports,
  MEDICAL_CLEARED,
  usableReport,
  type MedicalExamOrder,
  type AiReadTest,
} from "@/app/services/medicalExam";
import { getArtifactUrl } from "@/app/services/artifacts";
import { tx } from "@/lib/i18n/tx";
import { LinkEmailNote, linkDeliveryText, type LinkDelivery } from "@/components/LinkEmailNote";
import { appHref, portalUrl } from "@/lib/appLinks";
import dynamic from "next/dynamic";
import CaseWorkspaceHeader, { type CaseTab } from "@/components/case/CaseWorkspaceHeader";
import { useWorkbenchUser } from "@/components/workbench/SsoGate";
import { SpecialistCaseWorkspace, trackForRole } from "@/components/workbench/SpecialistWorkspace";
import { MedicalLabLinkModal, MedicalAssessModal, MedicalReportsModal, MedicalResultModal } from "@/components/case/MedicalReviewDialogs";

// Dialogs are loaded when first opened, not with the page.
const ChangePlanModal = dynamic(() => import("@/components/entities/ChangePlanModal").then((m) => m.ChangePlanModal), { ssr: false });
const ACRModal = dynamic(() => import("@/components/entities/ACRModal").then((m) => m.ACRModal), { ssr: false });
const WaiveAcrModal = dynamic(() => import("@/components/entities/WaiveAcrModal").then((m) => m.WaiveAcrModal), { ssr: false });
const UndoWaiverModal = dynamic(() => import("@/components/entities/WaiveAcrModal").then((m) => m.UndoWaiverModal), { ssr: false });

// When this page is embedded in the Copilot chat's in-conversation iframe
// (see CopilotInterface.tsx's case panel), tell the parent window whenever
// something meaningful changes here — an upload, a gate clearing — so the
// chat can follow up with the next step instead of the embed silently
// updating with no one in the conversation the wiser.
function notifyParentPortal(event: string, detail?: Record<string, unknown>) {
  if (typeof window === "undefined" || window.parent === window) return;
  try {
    window.parent.postMessage(
      { source: "insurance-ai-portal", type: event, ...detail },
      parentOrigin(),
    );
  } catch {
    // Cross-origin or no listener — nothing to recover, the page still works standalone.
  }
}

// ── Markdown renderer for the AI document summary ────────────────────────────

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] =
  {
    h2: ({ children }) => (
      <h2 className="text-xs font-bold text-slate-800 mt-4 mb-1.5 pb-1 border-b border-slate-100 first:mt-0 uppercase tracking-wide">
        {children}
      </h2>
    ),
    p: ({ children }) => (
      <p className="text-xs text-slate-600 leading-relaxed mb-2">{children}</p>
    ),
    ul: ({ children }) => <ul className="mb-2 space-y-1 pl-4">{children}</ul>,
    li: ({ children }) => (
      <li className="text-xs text-slate-600 leading-relaxed list-disc">
        {children}
      </li>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-slate-800">{children}</strong>
    ),
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
  DIRECT: "Walk-in",
  DIGITAL: "Digital",
};

const CASE_STATUS_STYLE: Record<string, string> = {
  New: "bg-slate-100 text-slate-600 border-slate-200",
  InProgress: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Documents": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
  Approved: "bg-blue-50 text-blue-700 border-blue-200",
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
  /** Underwriting hold: the process is frozen where it stands until the hold is removed. */
  on_hold?: boolean;
  hold_reason?: string | null;
  held_at?: string | null;
  held_by?: string | null;
  held_from_status?: string | null;
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
  underwriting_results?: UnderwritingResults | null;
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
  family_members?: {
    customer_id: string;
    name: string;
    cnic: string;
    relationship?: string | null;
    case_id: string;
    case_number: string;
    case_status: string;
    is_current: boolean;
  }[];
  /** Insured lives on this family policy whose own underwriting isn't approved yet — the policy waits for them. */
  /** Set on an insured spouse's case: the policy is issued to the head, on this case instead. */
  family_head_case?: {
    case_id: string;
    case_number: string;
    name: string;
    case_status: string;
  } | null;
  family_underwriting_pending?: {
    name: string;
    relationship?: string | null;
    case_id: string;
    case_number: string;
    case_status: string;
  }[];
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
  file_type?: string;
  download_url?: string;
}

// Mirrors GET /tenants/{tenantId}/cases/{id}/requirements and
// /verification-findings — see services/tenant-service/routers/cases.py.
interface CaseRequirement {
  id: string;
  code: string;
  category: string;
  required: boolean;
  status:
    | "Missing"
    | "Requested"
    | "Submitted"
    | "Satisfied"
    | "Waived"
    | "Invalid";
  reason: string | null;
  satisfied_by_artifact_id: string | null;
  updated_at: string;
}

interface VerificationFinding {
  id: string;
  field: string;
  severity: "Info" | "Low" | "Medium" | "High";
  declared_value: unknown;
  observed_value: unknown;
  source_artifact_id: string | null;
  explanation: string;
  created_at: string;
}

const SUPPORTED_EXTS = ["pdf", "png", "jpg", "jpeg", "tiff", "bmp"];

type StreamStatus = "idle" | "streaming" | "done" | "error";

export interface RiskFactorObject {
  factor: string;
  risk_level: string;
  reason: string;
  // The newer risk engine names the same three fields like this; the page reads either.
  parameter?: string;
  risk_rating?: string;
  observation?: string;
}

interface UnderwritingResults {
  medical?: {
    risk_score: number;
    risk_class: string;
    loading_percentage: number | null;
    requires_human_review: boolean;
    reasons: unknown[];
    evidence_refs: string[];
  };
  financial?: {
    financially_justified: boolean;
    declared_income: number;
    verified_income: number | null;
    coverage_to_income_ratio: number;
    maximum_supported_cover: number | null;
    referral_required: boolean;
    reasons: unknown[];
    evidence_refs: string[];
  };
  fraud?: {
    probability: number;
    severity: string;
    investigation_required: boolean;
    reasons: unknown[];
  };
  requirements_satisfied?: boolean;
  verified_facts?: unknown[];
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
  underwritingResults: UnderwritingResults | null;
}

const EMPTY_LIVE: LiveResult = {
  completedNodes: [],
  medicalScore: null,
  medicalReasons: [],
  financialScore: null,
  financialReasons: [],
  fraudProbability: null,
  fraudReasons: [],
  compositeScore: null,
  aiDecision: null,
  reasons: [],
  underwritingResults: null,
};

// ── Live run tracker ────────────────────────────────────────────────────────
// What the underwriter sees while "Run AI Underwriting" streams. Stages mirror
// the real pipeline: the gateway's own steps (requirements, evidence, saving),
// then the risk-engine graph nodes, then the report generated on this page.

type TraceStageState = { status: "running" | "done"; detail?: string | null };

interface RunTrace {
  open: boolean;
  startedAt: number;
  stages: Record<string, TraceStageState>;
  profile: Record<string, any> | null;
  error: string | null;
}

const CLOSED_TRACE: RunTrace = { open: false, startedAt: 0, stages: {}, profile: null, error: null };

const TRACE_STAGES: { id: string; label: string; hint: string; after: string[] }[] = [
  { id: "requirements", label: "Checking underwriting requirements", hint: "Re-running the Requirements Engine against the case's documents", after: [] },
  { id: "evidence", label: "Gathering evidence", hint: "E-application, agent's confidential report and OCR'd documents", after: ["requirements"] },
  { id: "validate_input", label: "Validating plan eligibility", hint: "Age, term and sum-assured rules for this plan", after: ["evidence"] },
  { id: "load_underwriting_profile", label: "Building the applicant profile", hint: "Demographics, occupation, lifestyle, medical and financial facts", after: ["validate_input"] },
  { id: "medical_scoring", label: "Medical underwriting", hint: "Disclosures, BMI, habits and the uploaded medical reports", after: ["load_underwriting_profile"] },
  { id: "financial_scoring", label: "Financial underwriting", hint: "Income vs. cover, term exposure and the agent's income opinion", after: ["load_underwriting_profile"] },
  { id: "fraud_detection", label: "Fraud & anomaly screening", hint: "Peer income and coverage clusters in the risk graph", after: ["load_underwriting_profile"] },
  { id: "decision_engine", label: "Finalising the decision", hint: "Combining scores, applying medical floors and loadings", after: ["medical_scoring", "financial_scoring", "fraud_detection"] },
  { id: "saving", label: "Saving the assessment", hint: "Recording the result and moving the case to review", after: ["decision_engine"] },
  { id: "report", label: "Generating the underwriting report", hint: "Underwriter notes and the PDF report", after: ["saving"] },
];

function traceStatus(trace: RunTrace, id: string, after: string[]): "waiting" | "running" | "done" {
  const own = trace.stages[id]?.status;
  if (own === "done") return "done";
  if (own === "running") return "running";
  // Graph nodes only report completion — a node is running once its inputs are done.
  return after.length > 0 && after.every((dep) => trace.stages[dep]?.status === "done") ? "running" : "waiting";
}

function profileFacts(profile: Record<string, any>): { label: string; value: string }[] {
  const d = profile.demographics ?? {};
  const o = profile.occupation ?? {};
  const l = profile.lifestyle ?? {};
  const m = profile.medical_history ?? {};
  const f = profile.financial ?? {};
  const join = (parts: unknown[]) => parts.filter((p) => p !== null && p !== undefined && p !== "").join(" · ");
  const money = (n: unknown) => (typeof n === "number" ? `PKR ${n.toLocaleString()}` : null);
  return [
    { label: "Demographics", value: join([d.age != null ? `${d.age} yrs` : null, d.gender, d.marital_status]) },
    { label: "Occupation", value: join([o.declared, o.hazard_level ? `${o.hazard_level} hazard` : "hazard unclassified"]) },
    { label: "Lifestyle", value: join([l.is_smoker == null ? null : l.is_smoker ? "Smoker" : "Non-smoker", ...(Array.isArray(l.habits) ? l.habits.slice(0, 2) : [])]) },
    { label: "Medical", value: join([m.bmi != null ? `BMI ${Number(m.bmi).toFixed(1)}${m.bmi_category ? ` (${m.bmi_category})` : ""}` : null, Array.isArray(m.report_evidence) && m.report_evidence.length ? `${m.report_evidence.length} medical reports` : null]) },
    { label: "Financial", value: join([money(f.verified_income ?? f.declared_income) ? `income ${money(f.verified_income ?? f.declared_income)}` : null, f.coverage_to_income_ratio != null ? `cover ${Number(f.coverage_to_income_ratio).toFixed(1)}× income` : null]) },
  ].filter((fact) => fact.value);
}

// The five phases shown on the stepper, each covering one or more real stages.
const TRACE_PHASES: { label: string; stages: string[] }[] = [
  { label: "Prep", stages: ["requirements", "evidence", "validate_input"] },
  { label: "Profile", stages: ["load_underwriting_profile"] },
  { label: "Risk analysis", stages: ["medical_scoring", "financial_scoring", "fraud_detection"] },
  { label: "Decision", stages: ["decision_engine"] },
  { label: "Report", stages: ["saving", "report"] },
];

function RunTracker({ trace, onDismiss }: Readonly<{ trace: RunTrace; onDismiss: () => void }>) {
  const [now, setNow] = useState(Date.now());
  const states = Object.fromEntries(TRACE_STAGES.map((st) => [st.id, traceStatus(trace, st.id, st.after)]));
  const complete = TRACE_STAGES.every((st) => states[st.id] === "done");
  useEffect(() => {
    if (trace.error || complete) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [trace.error, complete]);
  const elapsed = Math.max(0, Math.floor((now - trace.startedAt) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  const phaseState = (stages: string[]) =>
    stages.every((id) => states[id] === "done") ? "done" : stages.some((id) => states[id] !== "waiting") ? "active" : "waiting";
  const phases = TRACE_PHASES.map((ph) => ({ ...ph, state: phaseState(ph.stages) }));
  const active = TRACE_STAGES.filter((st) => states[st.id] === "running");
  const failedStage = trace.error ? (active[0] ?? TRACE_STAGES[0]) : null;

  // Context for the current step, from the profile once it is built.
  const p = trace.profile;
  const m = p?.medical_history ?? {};
  const f = p?.financial ?? {};
  const context: Record<string, string | null> = {
    medical_scoring: p
      ? [m.bmi != null ? `BMI ${Number(m.bmi).toFixed(1)}` : null,
         p.lifestyle?.is_smoker == null ? null : p.lifestyle.is_smoker ? "smoker" : "non-smoker",
         Array.isArray(m.report_evidence) && m.report_evidence.length ? `${m.report_evidence.length} medical reports` : null]
          .filter(Boolean).join(", ")
      : null,
    financial_scoring: f.coverage_to_income_ratio != null ? `cover is ${Number(f.coverage_to_income_ratio).toFixed(1)}× income` : null,
  };
  const activeTitle = active.length > 1
    ? active.map((st) => tx(st.label)).join(" · ")
    : active[0] ? tx(active[0].label) : null;
  const activeHint = active.length === 1
    ? [tx(active[0].hint), context[active[0].id]].filter(Boolean).join(" — ")
    : active.map((st) => context[st.id]).filter(Boolean).join(" · ") || (active[0] ? tx("Running in parallel") : null);

  const score = (id: string, label: string, value: string | null | undefined) => (
    <div className="min-w-0 flex-1 rounded-lg border border-slate-100 bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{tx(label)}</p>
      {states[id] === "done" && value ? (
        <p className="truncate text-sm font-bold text-slate-800">{value}</p>
      ) : (
        <div className={`mt-1 h-4 rounded ${states[id] === "running" ? "animate-pulse bg-violet-100" : "bg-slate-100"}`} />
      )}
    </div>
  );
  const detailOf = (id: string) => trace.stages[id]?.detail?.match(/[\d.]+%?(?:\s*\/\s*100)?/)?.[0] ?? null;

  return (
    <div
      className={`rounded-xl border p-4 ${trace.error ? "border-red-200 bg-red-50/40" : complete ? "border-emerald-200 bg-emerald-50/40" : "border-violet-200 bg-violet-50/40"}`}
      role="status"
      aria-live="polite"
    >
      {/* Stepper */}
      <ol className="flex items-start">
        {phases.map((ph, i) => {
          const failed = !!failedStage && ph.stages.includes(failedStage.id);
          return (
            <li key={ph.label} className="flex flex-1 flex-col items-center last:flex-none" style={{ minWidth: 0 }}>
              <div className="flex w-full items-center">
                <span
                  className={`relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                    failed ? "bg-red-500 text-white"
                      : ph.state === "done" ? "bg-emerald-500 text-white"
                      : ph.state === "active" ? "bg-violet-600 text-white"
                      : "border-2 border-slate-200 bg-white text-slate-400"
                  }`}
                >
                  {failed ? "!" : ph.state === "done" ? "✓" : i + 1}
                  {ph.state === "active" && !failed && (
                    <span className="absolute inset-0 animate-ping rounded-full bg-violet-400 opacity-40" />
                  )}
                </span>
                {i < phases.length - 1 && (
                  <span className="mx-1 h-0.5 flex-1 overflow-hidden rounded bg-slate-200">
                    <span
                      className={`block h-full transition-all duration-700 ${ph.state === "done" ? "w-full bg-emerald-400" : ph.state === "active" ? "w-1/2 bg-violet-300" : "w-0"}`}
                    />
                  </span>
                )}
              </div>
              <span
                className={`mt-1.5 self-start truncate text-[10px] font-semibold ${
                  ph.state === "done" ? "text-emerald-700" : ph.state === "active" ? "text-violet-700" : "text-slate-400"
                }`}
              >
                {tx(ph.label)}
              </span>
            </li>
          );
        })}
      </ol>

      {/* What is happening now */}
      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {trace.error ? (
            <>
              <p className="text-sm font-semibold text-red-700">{tx("Stopped at: {0}", { 0: tx(failedStage!.label) })}</p>
              <p className="mt-0.5 text-xs text-red-600">{trace.error}</p>
            </>
          ) : complete ? (
            <p className="text-sm font-semibold text-emerald-700">✓ {tx("Underwriting complete — opening the report")}</p>
          ) : (
            <>
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <span className="inline-block h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-violet-200 border-t-violet-600" />
                {activeTitle ?? tx("Starting…")}
              </p>
              {activeHint && <p className="mt-0.5 pl-[22px] text-xs text-slate-500">{activeHint}</p>}
            </>
          )}
        </div>
        {trace.error ? (
          <button onClick={onDismiss} className="flex-shrink-0 text-xs font-semibold text-red-700 hover:text-red-900">
            {tx("Dismiss")}
          </button>
        ) : (
          <span className="flex-shrink-0 font-mono text-xs text-slate-500">{clock}</span>
        )}
      </div>

      {/* Applicant facts, once the profile is built */}
      {p && (
        <p className="mt-2 truncate pl-[22px] text-[11px] text-slate-500" title={profileFacts(p).map((x) => `${x.label}: ${x.value}`).join("\n")}>
          {profileFacts(p).map((x) => x.value).join(" · ")}
        </p>
      )}

      {/* Scores fill in as each analysis finishes */}
      <div className="mt-3 flex gap-2">
        {score("medical_scoring", "Medical", detailOf("medical_scoring"))}
        {score("financial_scoring", "Financial", detailOf("financial_scoring"))}
        {score("fraud_detection", "Fraud", detailOf("fraud_detection"))}
        {score("decision_engine", "Decision", trace.stages.decision_engine?.detail?.replace(/^.*?:\s*/, "") ?? null)}
      </div>
    </div>
  );
}

// ── Application folder ──────────────────────────────────────────────────────
// Every document on file for the applicant — staff uploads, the customer's
// upload-link files and their medical-exam reports — grouped by type.

const DOC_STATUS_STYLE: Record<string, string> = {
  Accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Uploaded: "bg-blue-50 text-blue-700 border-blue-200",
  Processing: "bg-blue-50 text-blue-700 border-blue-200",
  "OCR Pending": "bg-amber-50 text-amber-700 border-amber-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  "Re-submission Requested": "bg-red-50 text-red-700 border-red-200",
};
const DOC_STATUS_LABEL: Record<string, string> = {
  Accepted: "Read",
  Uploaded: "Reading…",
  Processing: "Reading…",
  "OCR Pending": "Queued",
  Rejected: "Unreadable",
  "Re-submission Requested": "Re-upload requested",
};

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// A small portrait preview of one document. Images render directly; a PDF's
// first page renders through the browser's viewer, scaled down. Both load only
// once the card scrolls into view.
function DocumentThumb({ doc }: Readonly<{ doc: ArtifactData }>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ext = doc.file_name.split(".").pop()?.toLowerCase() ?? "";
  const isPdf = doc.file_type === "application/pdf" || ext === "pdf";
  const isImage = doc.file_type?.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext);
  const url = doc.download_url;
  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden bg-slate-100">
      {visible && url && !failed && isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover object-top" />
      ) : visible && url && !failed && isPdf ? (
        // Rendered at 3× and scaled to a third, so the first page fits the card.
        <iframe
          src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
          title={doc.file_name}
          tabIndex={-1}
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white"
          style={{ width: "300%", height: "300%", transform: "scale(0.3333)" }}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-slate-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
          </svg>
          <span className="text-[10px] font-bold uppercase">{ext.slice(0, 4)}</span>
        </div>
      )}
    </div>
  );
}

// Full-size preview of one document, inside the page. A fresh signed link is
// fetched on open, so it works however long the case page has been open.
// Asks why the case is being held — the server requires a reason (3+ characters) and shows it on the case and lead.
function HoldCaseDialog({
  busy,
  error,
  onConfirm,
  onClose,
}: Readonly<{ busy: boolean; error: string | null; onConfirm: (reason: string) => void; onClose: () => void }>) {
  const [reason, setReason] = useState("");
  const tooShort = reason.trim().length < 3;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-label={tx("Put case on hold")}
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-lg font-bold text-slate-900">{tx("Put case on hold")}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {tx("Underwriting pauses exactly where it is. Nothing is changed, and you can remove the hold to continue from the same step.")}
          </p>
        </div>
        <form
          className="space-y-3 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooShort && !busy) onConfirm(reason.trim());
          }}
        >
          <label className="block text-sm font-semibold text-slate-700" htmlFor="hold-reason">
            {tx("Reason")}
          </label>
          <textarea
            id="hold-reason"
            autoFocus
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tx("e.g. Waiting for the customer's updated medical report")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {tx("Cancel")}
            </button>
            <button
              type="submit"
              disabled={tooShort || busy}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? tx("Putting on hold…") : tx("Put on hold")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DocumentPreviewModal({ doc, onClose }: Readonly<{ doc: ArtifactData; onClose: () => void }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    getArtifactUrl(doc.id)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setError(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [doc.id, onClose]);
  const ext = doc.file_name.split(".").pop()?.toLowerCase() ?? "";
  const isPdf = doc.file_type === "application/pdf" || ext === "pdf";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label={doc.file_name}
        className="flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{doc.document_type}</p>
            <h2 className="truncate text-sm font-bold text-slate-900">{doc.file_name}</h2>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                {tx("Open in new tab")} ↗
              </a>
            )}
            <button onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              ✕
            </button>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-auto bg-slate-100">
          {error ? (
            <p className="text-sm text-red-600">{tx("Could not load the document. Please try again.")}</p>
          ) : !url ? (
            <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          ) : isPdf ? (
            <iframe src={url} title={doc.file_name} className="h-full w-full border-0 bg-white" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={doc.file_name} className="max-h-full max-w-full object-contain" />
          )}
        </div>
      </div>
    </div>
  );
}

function ApplicationFolderModal({
  caseNumber,
  customerName,
  artifacts,
  portalHref,
  onClose,
}: Readonly<{
  caseNumber: string;
  customerName?: string;
  artifacts: ArtifactData[];
  portalHref: string;
  onClose: () => void;
}>) {
  const [query, setQuery] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const groupOf = (a: ArtifactData) => (a.document_type.startsWith("Medical Report: ") ? "Medical Exam Reports" : a.document_type || "Other");
  const visible = artifacts.filter((a) =>
    `${a.file_name} ${a.document_type}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const groups = Array.from(new Set(visible.map(groupOf))).sort((x, y) =>
    x === "Medical Exam Reports" ? 1 : y === "Medical Exam Reports" ? -1 : x.localeCompare(y),
  );
  const open = async (id: string) => {
    setOpenError(null);
    // Open the tab synchronously so the popup blocker allows it, then point it at the signed link.
    const tab = window.open("", "_blank");
    try {
      const url = await getArtifactUrl(id);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    } catch {
      tab?.close();
      setOpenError(tx("Could not open the document. Please try again."));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label={tx("Application folder")}
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{tx("Application folder")}</p>
            <h2 className="truncate text-lg font-bold text-slate-900">
              {customerName ?? caseNumber} <span className="font-medium text-slate-400">· {caseNumber}</span>
            </h2>
            <p className="text-xs text-slate-500">
              {tx("{0} documents on file", { 0: artifacts.length })}
            </p>
          </div>
          <button onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            ✕
          </button>
        </div>
        {artifacts.length > 6 && (
          <div className="border-b border-slate-100 px-5 py-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tx("Search documents…")}
              aria-label={tx("Search documents")}
              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
            />
          </div>
        )}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {groups.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-400">
              {artifacts.length ? tx("No documents match your search.") : tx("No documents have been uploaded yet.")}
            </p>
          )}
          {groups.map((group) => {
            const docs = visible.filter((a) => groupOf(a) === group);
            return (
              <section key={group}>
                <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  {tx(group)} <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-500">{docs.length}</span>
                </h3>
                <ul className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))" }}>
                  {docs.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => void open(a.id)}
                        title={`${a.file_name} — ${tx("click to open")}`}
                        className="group flex w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                      >
                        <div className="relative aspect-[3/4] w-full border-b border-slate-100">
                          <DocumentThumb doc={a} />
                          <span className={`absolute right-1.5 top-1.5 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold shadow-sm ${DOC_STATUS_STYLE[a.status] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>
                            {tx(DOC_STATUS_LABEL[a.status] ?? a.status)}
                          </span>
                          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/0 text-xs font-semibold text-white opacity-0 transition-all group-hover:bg-slate-900/40 group-hover:opacity-100">
                            {tx("Open")} ↗
                          </span>
                        </div>
                        <div className="px-2 py-1.5">
                          <p className="truncate text-[11px] font-semibold text-slate-800">{a.file_name}</p>
                          <p className="truncate text-[10px] text-slate-400">
                            {group === "Medical Exam Reports" ? `${a.document_type.replace("Medical Report: ", "")} · ` : ""}
                            {fileSize(a.file_size)}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {openError && <p role="alert" className="text-xs text-red-600">{openError}</p>}
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-3">
          <a href={portalHref} className="text-xs font-semibold text-slate-500 hover:text-blue-700">
            {tx("Open in Applications explorer ↗")}
          </a>
          <button onClick={onClose} className="rounded-lg bg-slate-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-900">
            {tx("Close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

// Open requirements first, then what has been met, then what was waived.
const REQUIREMENT_ORDER: Record<string, number> = {
  Missing: 0, Invalid: 0, Requested: 1, Submitted: 2, Satisfied: 3, Waived: 4,
};
const REQUIREMENT_ACRONYMS = new Set(["CNIC", "ECG", "ACR", "PEP", "NML", "BMI", "HIV", "MER", "KYC", "AML", "ID", "DOB", "NTN", "CBC", "LFT", "RFT"]);

/** MEDICAL_EXAMINATION → "Medical examination"; acronyms such as CNIC and ECG stay as they are. */
function requirementName(code: string): string {
  return code
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      const up = w.toUpperCase();
      if (REQUIREMENT_ACRONYMS.has(up)) return up;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

function RequirementIcon({ status }: { status: string }) {
  if (status === "Satisfied")
    return (
      <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
          <path d="M5 12l5 5L20 7" />
        </svg>
      </span>
    );
  if (status === "Waived")
    return (
      <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-500" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="h-3.5 w-3.5">
          <path d="M6 12h12" />
        </svg>
      </span>
    );
  if (status === "Invalid")
    return (
      <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-bold text-red-600" aria-hidden="true">
        !
      </span>
    );
  return <span className="mt-0.5 h-6 w-6 flex-shrink-0 rounded-full border-2 border-amber-400" aria-hidden="true" />;
}

function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  const panel = useContext(SectionsAsPanels);
  if (panel) {
    return (
      <div className="min-w-0">
        <dt className="text-xs text-slate-500">{label}</dt>
        <dd className="mt-0.5 break-words text-sm font-medium text-slate-900">{value}</dd>
      </div>
    );
  }
  return (
    <div className="data-row">
      <span className="data-key">{label}</span>
      <span className="data-val">{value}</span>
    </div>
  );
}

function SectionCard({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h3 className="section-label">{title}</h3>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

// Inside a tab that exists only to show these sections (Applicant, Documents) they start open.
const AccordionsOpenByDefault = createContext(false);
// The Applicant & Policy tab lays each section out as its own card with a two-column grid of fields.
const SectionsAsPanels = createContext(false);

function Accordion({
  title,
  defaultOpen,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const openByDefault = useContext(AccordionsOpenByDefault);
  const panel = useContext(SectionsAsPanels);
  const [open, setOpen] = useState(defaultOpen ?? openByDefault);
  if (panel) {
    return (
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <h3 className="section-label">{title}</h3>
          {action}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">{children}</dl>
      </section>
    );
  }
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
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
        {action && <div className="ml-3 flex-shrink-0">{action}</div>}
      </div>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}

// A reason is a "risk" signal (⚠) or a "clear" signal (✓). The same heuristic
// drives both the list and table views so their symbols stay in sync.
function classifyReason(reason: string): "risk" | "clear" {
  const lower = reason.toLowerCase();
  const isBad =
    /(high|elevated|suspicious|unverified|irregular|missing|abnormal|poor|inadequate|insufficient|concern|discrepancy|fraud|decline|reject|warning|smoker|hypertension|diabetic|disease|increased|major risk|unstable|severe|critical)/i.test(
      lower,
    );
  const isGoodExemption =
    /(low risk|low mortality|no history|no evidence|non-smoker|absence of|no significant|within normal|normal|clear|healthy|verified|stable|acceptable|good|excellent)/i.test(
      lower,
    );
  return isBad && !isGoodExemption ? "risk" : "clear";
}

// Tidy a raw reason string into something more concise/readable: collapse
// whitespace, strip noise verdicts like "…: no signal", and drop trailing
// punctuation. Keeps the meaningful fact, drops the filler.
function tidyReason(reason: string): string {
  return reason
    .replace(/\s+/g, " ")
    .replace(
      /\s*[:\-–—]\s*(no signals?|no concerns?|normal|nil|none|n\/a|clear)\.?$/i,
      "",
    )
    .replace(/[.;,]+$/, "")
    .trim();
}

function ReasonIcon({
  kind,
  className = "w-3.5 h-3.5",
}: {
  kind: "risk" | "clear";
  className?: string;
}) {
  if (kind === "risk") {
    return (
      <svg
        className={`text-amber-500 flex-shrink-0 ${className}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
    );
  }
  return (
    <svg
      className={`text-blue-500 flex-shrink-0 ${className}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={3}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

interface ReasonSection {
  label: string; // full heading, e.g. "Medical Risk Factors"
  short: string; // compact label for the table, e.g. "Medical"
  icon: string; // emoji icon for domain
  score: number;
  scoreLabel: string;
  reasons: (string | RiskFactorObject)[];
  accentColor: string;
}

function ReasonGroup({
  label,
  scoreLabel,
  reasons,
  accentColor,
}: {
  label: string;
  scoreLabel: string;
  reasons: (string | RiskFactorObject)[];
  accentColor: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`text-xs font-bold uppercase tracking-widest ${accentColor}`}
        >
          {label}
        </span>
        <span className="text-[10px] font-mono text-slate-500 bg-slate-50 border border-slate-100 rounded px-1.5 py-0.5">
          {scoreLabel}
        </span>
      </div>
      <ul className="space-y-0.5">
        {reasons.length === 0 && (
          <li className="text-xs text-slate-400 italic px-2.5 py-1">
            {tx("No factors recorded.")}
          </li>
        )}
        {reasons.map((reason, i) => {
          const isObj = typeof reason === "object" && reason !== null;
          const factorStr = isObj ? reason.factor : reason;
          const detailStr = isObj ? reason.reason : tidyReason(reason);
          const kind = isObj
            ? reason.risk_level.toLowerCase().includes("high") ||
              reason.risk_level.toLowerCase().includes("moderate")
              ? "risk"
              : "clear"
            : classifyReason(reason);

          return (
            <li
              key={i}
              className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-slate-50/70 transition-colors"
            >
              <ReasonIcon kind={kind as any} className="w-3.5 h-3.5 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-slate-700 leading-snug">
                  {factorStr}
                </span>
                <span className="text-[11px] text-slate-500 leading-snug">
                  {detailStr}
                </span>
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
  const rows = sections.flatMap((s) =>
    s.reasons.map((reason) => {
      const isObj = typeof reason === "object" && reason !== null;
      return {
        short: s.short,
        icon: s.icon,
        accentColor: s.accentColor,
        parameter: isObj ? reason.parameter || reason.factor : reason,
        risk_rating: isObj
          ? reason.risk_rating || reason.risk_level
          : classifyReason(reason) === "risk"
            ? "Moderate"
            : "Low",
        observation: isObj
          ? reason.observation || reason.reason
          : tidyReason(reason),
        kind: isObj
          ? (reason.risk_rating || reason.risk_level)
              .toLowerCase()
              .includes("high") ||
            (reason.risk_rating || reason.risk_level)
              .toLowerCase()
              .includes("moderate")
            ? "risk"
            : "clear"
          : classifyReason(reason),
      };
    }),
  );

  if (rows.length === 0) {
    return (
      <p className="text-xs text-slate-400">{tx("No factors recorded.")}</p>
    );
  }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500 border-b border-slate-200">
            <th className="py-3 px-3 font-medium w-40">{tx("Category")}</th>
            <th className="py-3 px-3 font-medium w-40">{tx("Parameter")}</th>
            <th className="py-3 px-3 font-medium">{tx("Observation")}</th>
            <th className="py-3 px-3 font-medium w-32">{tx("Risk Rating")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-slate-200 last:border-0 align-middle"
            >
              <td className="py-3 px-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{row.icon}</span>
                  <span
                    className={`font-bold uppercase tracking-wide text-xs ${row.accentColor}`}
                  >
                    {tx(row.short)}
                  </span>
                </div>
              </td>
              <td className="py-3 px-3 text-slate-800 font-semibold">
                {row.parameter}
              </td>
              <td className="py-3 px-3 text-slate-600">{row.observation}</td>
              <td className="py-3 px-3">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      row.risk_rating.toLowerCase().includes("high")
                        ? "bg-red-500"
                        : row.risk_rating.toLowerCase().includes("moderate")
                          ? "bg-amber-500"
                          : row.risk_rating.toLowerCase().includes("info")
                            ? "bg-blue-500"
                            : "bg-blue-500"
                    }`}
                  />
                  <span className="text-sm text-slate-700">
                    {row.risk_rating}
                  </span>
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
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`}
    />
  );
}

// Upload type per document-backed requirement. Each name contains the keyword
// shared/underwriting/requirements_rules.py matches the requirement on.
const REQUIREMENT_DOC_TYPES: Record<string, string> = {
  CNIC: "CNIC",
  SALARY_SLIP: "Salary Slip",
  BANK_STATEMENT: "Bank Statement",
  TAX_DOCUMENT: "Tax Return",
  MEDICAL_EXAMINATION: "Medical Report",
  ECG: "ECG",
  LAB_REPORTS: "Lab Report",
  PHYSICIAN_REPORT: "Physician Report",
};

const EXTRA_DOC_TYPES = [
  "Bank Statement",
  "Tax Return",
  "X-Ray",
  "MRI Scan",
  "Policy Form",
  "Child's Birth Certificate",
  "Other",
];

/**
 * Guided upload: one card per document the plan requires, marked Complete once the
 * case has it, plus an "Additional document" card. Files are dropped (or browsed)
 * onto the card they belong to, so each is filed under the right type without a
 * dropdown — and the next missing one is highlighted.
 */
function UploadModal({
  tenantId,
  caseId,
  docTypes,
  missingTypes = [],
  onClose,
  onUploaded,
}: {
  tenantId: string;
  caseId: string;
  docTypes: string[];
  // Required documents the case still lacks.
  missingTypes?: string[];
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [fileItems, setFileItems] = useState<{ file: File; type: string }[]>(
    [],
  );
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [extraType, setExtraType] = useState(
    () => EXTRA_DOC_TYPES.find((t) => !docTypes.includes(t)) ?? "Other",
  );
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  // Preview of a chosen file, read locally — nothing is uploaded to view it.
  const [preview, setPreview] = useState<{
    url: string;
    name: string;
    isPdf: boolean;
  } | null>(null);
  const openPreview = (file: File) => {
    const isPdf =
      file.name.toLowerCase().endsWith(".pdf") ||
      file.type === "application/pdf";
    setPreview({ url: URL.createObjectURL(file), name: file.name, isPdf });
  };
  const closePreview = () => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  };
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  const missing = new Set(missingTypes);
  const isComplete = (t: string) =>
    !missing.has(t) || fileItems.some((i) => i.type === t);
  const doneCount = docTypes.filter((t) => !missing.has(t)).length;
  const nextMissing = docTypes.find(
    (t) => missing.has(t) && !fileItems.some((i) => i.type === t),
  );

  const addFiles = (newFiles: FileList | File[], type: string) => {
    setErr("");
    const valid: { file: File; type: string }[] = [];
    for (let i = 0; i < newFiles.length; i++) {
      const f = newFiles[i];
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED_EXTS.includes(ext)) {
        setErr(
          `Unsupported format ".${ext}". Allowed: ${SUPPORTED_EXTS.join(", ").toUpperCase()}`,
        );
        continue;
      }
      valid.push({ file: f, type });
    }
    setFileItems((prev) => [...prev, ...valid]);
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
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120_000,
        });
      } catch (e: any) {
        failures.push(
          `${item.file.name}: ${e.response?.data?.detail ?? e.message ?? "failed"}`,
        );
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

  const dropProps = (type: string) => ({
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(type);
    },
    onDragLeave: () => setDragOver((d) => (d === type ? null : d)),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(null);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files, type);
    },
  });

  const stagedList = (type: string) => {
    const items = fileItems
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => item.type === type);
    if (!items.length) return null;
    return (
      <ul className="mt-2.5 space-y-1.5">
        {items.map(({ item, i }) => (
          <li
            key={i}
            className="flex items-center gap-2 text-[11px] bg-white border border-slate-200 rounded-md px-2 py-1.5"
          >
            <svg
              className="w-3.5 h-3.5 text-slate-400 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              />
            </svg>
            <span
              className="truncate text-slate-700 flex-1"
              title={item.file.name}
            >
              {item.file.name}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openPreview(item.file);
              }}
              className="text-blue-600 font-semibold hover:underline flex-shrink-0"
            >
              {tx("View")}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setFileItems((prev) => prev.filter((_, j) => j !== i));
              }}
              className="text-slate-400 hover:text-red-500 flex-shrink-0"
              title={tx("Remove")}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    );
  };

  const fileInput = (type: string) => (
    <input
      ref={(el) => {
        inputs.current[type] = el;
      }}
      type="file"
      className="sr-only"
      accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
      multiple
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) addFiles(e.target.files, type);
        e.target.value = "";
      }}
    />
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with progress */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-800">
              {tx("Upload Documents")}
            </h3>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 p-1 -mr-1"
              aria-label={tx("Close")}
            >
              ✕
            </button>
          </div>
          {docTypes.length > 0 ? (
            <div className="mt-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600">
                  <span className="font-bold text-slate-800">
                    {doneCount} {tx("of")} {docTypes.length}
                  </span>{" "}
                  {tx("required documents complete")}
                </span>
                {nextMissing ? (
                  <span className="text-amber-700 font-semibold">
                    {tx("Next:")} {nextMissing}
                  </span>
                ) : (
                  <span className="text-emerald-600 font-semibold">
                    {tx("All required documents covered")}
                  </span>
                )}
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${(doneCount / docTypes.length) * 100}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500 mt-1">
              {tx(
                "This plan doesn't require specific documents — add any supporting files below.",
              )}
            </p>
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
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${complete ? "bg-emerald-500 text-white" : "bg-white border border-slate-200 text-slate-400"}`}
                      >
                        {complete ? (
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="m4.5 12.75 6 6 9-13.5"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                            />
                          </svg>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-slate-800">
                            {type}
                          </p>
                          <span
                            className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                              alreadyHave
                                ? "bg-emerald-100 text-emerald-700"
                                : staged
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            {alreadyHave
                              ? tx("Complete")
                              : staged
                                ? tx("Ready to upload")
                                : tx("Required")}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {alreadyHave
                            ? tx(
                                "Already on file — drop here to add a newer copy.",
                              )
                            : staged
                              ? tx("Will be uploaded when you press Upload.")
                              : tx("Drop the file here or click to browse.")}
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
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 4.5v15m7.5-7.5h-15"
                  />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-700">
                  {tx("Additional document")}
                </p>
                <p className="text-[11px] text-slate-500">
                  {tx(
                    "Optional supporting files — choose the type, then drop or click.",
                  )}
                </p>
              </div>
              <select
                value={extraType}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setExtraType(e.target.value)}
                className="bg-white border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-700 focus:outline-none focus:border-blue-400"
              >
                {EXTRA_DOC_TYPES.filter((t) => !docTypes.includes(t)).map(
                  (t) => (
                    <option key={t}>{t}</option>
                  ),
                )}
              </select>
            </div>
            {EXTRA_DOC_TYPES.filter((t) => !docTypes.includes(t)).map((t) => (
              <div key={t}>{stagedList(t)}</div>
            ))}
          </div>

          <p className="text-[10px] text-slate-400 text-center">
            {tx(
              "PDF · PNG · JPG · JPEG · TIFF · BMP — each file is read by OCR after upload.",
            )}
          </p>

          {err && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-line">
              {err}
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {fileItems.length
              ? tx("{0} file{1} ready", {
                  0: fileItems.length,
                  1: fileItems.length === 1 ? "" : "s",
                })
              : tx("No files added yet")}
          </span>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={uploading}
              className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              {tx("Cancel")}
            </button>
            <button
              onClick={submit}
              disabled={fileItems.length === 0 || uploading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-all"
            >
              {uploading ? <Spinner /> : null}
              {uploading
                ? tx("Uploading…")
                : tx("Upload{0} & OCR", {
                    0: fileItems.length ? ` ${fileItems.length}` : "",
                  })}
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 p-4"
          onClick={(e) => {
            e.stopPropagation();
            closePreview();
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3">
              <p
                className="text-sm font-semibold text-slate-800 truncate"
                title={preview.name}
              >
                {preview.name}
              </p>
              <div className="flex items-center gap-3 flex-shrink-0">
                <a
                  href={preview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-semibold text-blue-700 hover:underline"
                >
                  {tx("Open in new tab")}
                </a>
                <button
                  type="button"
                  onClick={closePreview}
                  className="text-slate-400 hover:text-slate-600 p-1"
                  title={tx("Close preview")}
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-slate-100 flex items-center justify-center min-h-[40vh]">
              {preview.isPdf ? (
                <iframe
                  src={preview.url}
                  title={preview.name}
                  className="w-full h-[70vh] border-0 bg-white"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview.url}
                  alt={preview.name}
                  className="max-w-full max-h-[70vh] object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

// Case events that change what this page shows, and the toast each one raises.
const LIVE_CASE_EVENT_MESSAGES: Record<string, string> = {
  ACRSubmitted: "✅ The Agent's Confidential Report was just submitted.",
  EApplicationSubmitted: "✅ The applicant just submitted the e-application.",
  MedicalExamCompleted: "✅ The medical examination result just came in.",
  UnderwritingReviewSubmitted: "✅ A specialist just submitted their underwriting review.",
};
const LIVE_CASE_EVENTS = new Set([
  ...Object.keys(LIVE_CASE_EVENT_MESSAGES),
  "ACRRequested",
  "VerificationCompleted",
  "RequirementsDetermined",
  "ComplianceFailed",
  "PremiumCollected",
  "PaymentConfirmed",
]);

export default function CasePage({ params }: { params: { id: string } }) {
  const user = useWorkbenchUser();
  const track = trackForRole(user.role_name);
  return track ? <SpecialistCaseWorkspace track={track} /> : <GeneralCasePage params={params} />;
}

function GeneralCasePage({ params }: { params: { id: string } }) {
  const caseId = params.id;

  // The case header stays pinned while the page scrolls; the left column sticks just below it, so its height is needed.
  const [headHeight, setHeadHeight] = useState(128);
  const headObserver = useRef<ResizeObserver | null>(null);
  const headRef = useCallback((el: HTMLDivElement | null) => {
    headObserver.current?.disconnect();
    if (!el) return;
    const measure = () =>
      setHeadHeight(Math.round(el.getBoundingClientRect().height));
    measure();
    headObserver.current = new ResizeObserver(measure);
    headObserver.current.observe(el);
  }, []);
  const [detail, setDetail] = useState<CaseDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setUserRole(localStorage.getItem("user_role"));
    }
  }, []);

  const [status, setStatus] = useState<StreamStatus>("idle");
  const [live, setLive] = useState<LiveResult>(EMPTY_LIVE);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [trace, setTrace] = useState<RunTrace>(CLOSED_TRACE);
  const traceStage = (id: string, update: TraceStageState) =>
    setTrace((t) => ({ ...t, stages: { ...t.stages, [id]: update } }));
  const traceFail = (message: string) => setTrace((t) => (t.startedAt ? { ...t, error: message } : t));
  const abortRef = useRef<AbortController | null>(null);

  const [overriding, setOverriding] = useState<string | null>(null);
  const [holdModal, setHoldModal] = useState(false);
  // Which section of the case is showing (see CASE_TABS). Hidden tabs stay mounted, so nothing typed or running is lost.
  const [caseTab, setCaseTab] = useState<CaseTab>("overview");
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [postingNote, setPostingNote] = useState(false);
  const [noteSent, setNoteSent] = useState(false);
  const [generatingNote, setGeneratingNote] = useState(false);
  const [noteGenError, setNoteGenError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // AI Analysis view mode — "table" (compact rows, default) or "list" (grouped bullets).
  const [analysisView, setAnalysisView] = useState<"list" | "table">("table");

  const [artifacts, setArtifacts] = useState<ArtifactData[]>([]);
  const [requirements, setRequirements] = useState<CaseRequirement[]>([]);
  const [verificationFindings, setVerificationFindings] = useState<
    VerificationFinding[]
  >([]);
  const [requirementsBusy, setRequirementsBusy] = useState(false);
  const [requirementsError, setRequirementsError] = useState<string | null>(
    null,
  );
  const [showUpload, setShowUpload] = useState(false);
  // Underwriter chose to proceed although some mandatory documents are missing. Kept per case in this browser only.
  const [docsWaived, setDocsWaived] = useState(false);
  useEffect(() => {
    try {
      setDocsWaived(localStorage.getItem(`uw-docs-waived:${caseId}`) === "1");
    } catch {}
  }, [caseId]);
  const toggleDocsWaived = useCallback(
    (next: boolean) => {
      setDocsWaived(next);
      try {
        if (next) localStorage.setItem(`uw-docs-waived:${caseId}`, "1");
        else localStorage.removeItem(`uw-docs-waived:${caseId}`);
      } catch {}
    },
    [caseId],
  );
  const [showDocuments, setShowDocuments] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<ArtifactData | null>(null);
  // Set when the upload dialog was opened from a requirement row — the dialog
  // then asks for just that document.
  const [uploadForRequirement, setUploadForRequirement] = useState<string | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);
  const [downloadingApp, setDownloadingApp] = useState(false);

  // Pre-Underwriting — Customer E-Application + Agent's Confidential Report
  const [eApp, setEApp] = useState<EApplication | null>(null);
  const [eAppLink, setEAppLink] = useState<string | null>(null);
  const [eAppBusy, setEAppBusy] = useState(false);
  const [eAppErr, setEAppErr] = useState<string | null>(null);
  const [acr, setAcr] = useState<AgentConfidentialReport | null>(null);
  const [showACRModal, setShowACRModal] = useState(false);
  const [showChangePlan, setShowChangePlan] = useState(false);
  const [checks, setChecks] = useState<ComplianceCheck[]>([]);
  const [compBusy, setCompBusy] = useState(false);
  // Pre-Underwriting gates 5 & 6 — insurance history, panel medical examination
  const [history, setHistory] = useState<InsuranceHistory | null>(null);
  const [histBusy, setHistBusy] = useState(false);
  const [medical, setMedical] = useState<MedicalExamOrder | null>(null);
  const [medBusy, setMedBusy] = useState(false);
  const [medLink, setMedLink] = useState<string | null>(null);
  const [medDelivery, setMedDelivery] = useState<LinkDelivery | null>(null);
  const [medErr, setMedErr] = useState<string | null>(null);
  const [showResultModal, setShowResultModal] = useState(false);
  const [showAssessModal, setShowAssessModal] = useState(false);
  const [showLabLinkModal, setShowLabLinkModal] = useState(false);
  const [labLink, setLabLink] = useState<LabLink | null>(null);
  const notifiedPreUnderwritingRef = useRef(false);

  const [docSummary, setDocSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);

  // When multiple plans are sent to underwriting together (from the Quotations
  // page), each plan gets its own case. We store the group in sessionStorage so
  // this page can render a dropdown to switch between the plans for a customer.
  const [planGroup, setPlanGroup] = useState<
    { caseId: string; planLabel: string; insuranceType: string }[]
  >([]);

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
  const [groupStatuses, setGroupStatuses] = useState<
    Record<string, StreamStatus>
  >({});
  const [groupLive, setGroupLive] = useState<Record<string, LiveResult>>({});
  const [groupErrors, setGroupErrors] = useState<Record<string, string | null>>(
    {},
  );
  const groupAbortsRef = useRef<Record<string, AbortController>>({});
  const groupStartedRef = useRef<string | null>(null);

  // Track the currently-viewed case for long-lived background streams whose
  // closures would otherwise capture a stale caseId after the user switches plan.
  const currentCaseIdRef = useRef(caseId);
  useEffect(() => {
    currentCaseIdRef.current = caseId;
  }, [caseId]);

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
        traceStage("report", { status: "done", detail: tx("Report ready") });
        // Leave the finished checklist on screen for a moment before the report replaces it.
        setTimeout(() => {
          setShowReportModal(true);
          setTrace(CLOSED_TRACE);
        }, 900);
      }, 500);
    }
  }, [effStatus, hasLive]);

  const tenantId =
    typeof window !== "undefined"
      ? (localStorage.getItem("tenant_id") ?? "")
      : "";

  const fetchDetail = useCallback(async () => {
    if (!tenantId) return;
    setError(null);
    try {
      const res = await api.get<CaseDetailResponse>(
        `/tenants/${tenantId}/cases/${caseId}/detail`,
      );
      setDetail(res.data);
    } catch (err: any) {
      setError(err.message ?? tx("Failed to load case."));
    } finally {
      setLoading(false);
    }
  }, [tenantId, caseId]);

  const fetchArtifacts = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.get<ArtifactData[]>(
        `/tenants/${tenantId}/cases/${caseId}/artifacts`,
      );
      setArtifacts(res.data);
    } catch {
      /* non-fatal — the case shell above still renders */
    }
  }, [tenantId, caseId]);

  const fetchRequirements = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.get<{ requirements: CaseRequirement[] }>(
        `/tenants/${tenantId}/cases/${caseId}/requirements`,
      );
      setRequirements(res.data.requirements ?? []);
    } catch {
      /* non-fatal — requirements may not have been determined yet */
    }
  }, [tenantId, caseId]);

  const fetchVerificationFindings = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.get<{ findings: VerificationFinding[] }>(
        `/tenants/${tenantId}/cases/${caseId}/verification-findings`,
      );
      setVerificationFindings(res.data.findings ?? []);
    } catch {
      /* non-fatal */
    }
  }, [tenantId, caseId]);

  const runDetermineRequirements = useCallback(async () => {
    if (!tenantId) return;
    setRequirementsBusy(true);
    setRequirementsError(null);
    try {
      const res = await api.post<{
        requirements: CaseRequirement[];
        satisfied: boolean;
        case_status: string;
      }>(`/tenants/${tenantId}/cases/${caseId}/requirements/determine`);
      setRequirements(res.data.requirements ?? []);
      await fetchDetail();
    } catch (err: any) {
      setRequirementsError(
        err?.response?.data?.detail ??
          err.message ??
          tx("Failed to determine requirements."),
      );
    } finally {
      setRequirementsBusy(false);
    }
  }, [tenantId, caseId, fetchDetail]);

  // A requirement's document only counts once OCR has accepted it, so while
  // one is still being read, its row says so and the page keeps checking;
  // once accepted, the Requirements Engine re-runs so the row turns Satisfied.
  const requirementDoc = (req: CaseRequirement) => {
    const type = REQUIREMENT_DOC_TYPES[req.code];
    const docs = type ? artifacts.filter((a) => a.document_type === type) : [];
    return {
      processing: docs.some((a) => ["Uploaded", "OCR Pending", "Processing"].includes(a.status)),
      accepted: docs.find((a) => a.status === "Accepted"),
      unreadable: docs.length > 0 && docs.every((a) => ["Rejected", "Re-submission Requested"].includes(a.status)),
    };
  };
  const openDocRequirements = requirements.filter((r) => ["Missing", "Invalid", "Requested"].includes(r.status));
  const requirementDocsProcessing = openDocRequirements.some((r) => requirementDoc(r).processing);
  const acceptedKey = openDocRequirements.map((r) => requirementDoc(r).accepted?.id).filter(Boolean).join(",");
  const redeterminedFor = useRef<string>("");
  useEffect(() => {
    if (!requirementDocsProcessing) return;
    const timer = window.setInterval(() => void fetchArtifacts(), 5000);
    return () => window.clearInterval(timer);
  }, [requirementDocsProcessing, fetchArtifacts]);
  useEffect(() => {
    if (!acceptedKey || redeterminedFor.current === acceptedKey || userRole === "Agent") return;
    redeterminedFor.current = acceptedKey;
    void runDetermineRequirements();
  }, [acceptedKey, runDetermineRequirements, userRole]);


  const waiveRequirement = useCallback(
    async (requirementId: string) => {
      if (!tenantId) return;
      try {
        await api.post(
          `/tenants/${tenantId}/cases/${caseId}/requirements/${requirementId}/waive`,
          { note: "Waived by underwriter" },
        );
        await fetchRequirements();
      } catch (err: any) {
        setRequirementsError(
          err?.response?.data?.detail ??
            err.message ??
            tx("Failed to waive requirement."),
        );
      }
    },
    [tenantId, caseId, fetchRequirements],
  );

  const fetchEApplication = useCallback(async () => {
    if (!tenantId) return;
    try {
      setEApp(await getEApplication(caseId));
    } catch {
      /* non-fatal */
    }
  }, [tenantId, caseId]);

  const fetchAcr = useCallback(async () => {
    if (!tenantId) return;
    try {
      setAcr(await getACR(caseId));
    } catch {
      /* non-fatal */
    }
  }, [tenantId, caseId]);

  const handleGenerateEAppLink = async () => {
    setEAppBusy(true);
    setEAppErr(null);
    try {
      const invite = await inviteEApplication(caseId);
      setEAppLink(portalUrl(invite.link_path));
      notify(linkDeliveryText(invite), invite.email_status !== "failed");
      await fetchEApplication();
    } catch (e: any) {
      setEAppErr(e?.message ?? "Failed to generate link");
    } finally {
      setEAppBusy(false);
    }
  };

  const fetchCompliance = useCallback(async () => {
    const policyId = detail?.policy?.id || detail?.case?.policy_id;
    if (!tenantId || !policyId) return;
    try {
      setChecks(await getCompliance(policyId));
    } catch {
      /* non-fatal */
    }
  }, [tenantId, detail?.policy?.id, detail?.case?.policy_id]);

  const handleRunCompliance = async () => {
    let policyId = detail?.policy?.id || detail?.case?.policy_id;
    if (!policyId) {
      if (!customer) {
        alert(
          tx(
            "This case has no linked policy yet — PEP/sanctions screening needs one first.",
          ),
        );
        return;
      }
      if (
        !window.confirm(
          "This case has no linked policy yet — PEP/sanctions screening needs one first.\n\n" +
            "Create a default Term Life Plus proposal for this customer now?",
        )
      )
        return;
      setCompBusy(true);
      try {
        const coverage =
          Math.min((customer.declared_income || 0) * 10, 20_000_000) ||
          5_000_000;
        const res = await api.post(
          `/tenants/${tenantId}/customers/${customer.id}/policies`,
          {
            product_name: "Term Life Plus",
            insurance_type: "TERM_LIFE",
            coverage_amount: coverage,
            term_years: 10,
          },
        );
        policyId = res.data.id;
        await fetchDetail();
      } catch (e: any) {
        alert(e?.message ?? tx("Could not create the proposal."));
        setCompBusy(false);
        return;
      }
    }
    setCompBusy(true);
    try {
      // Pre-underwriting screens through the case: the policy is still a quote
      // here, and the policy-level endpoint is for Stage A (after approval).
      await runCaseCompliance(tenantId, caseId);
      await fetchCompliance();
    } catch (e: any) {
      alert(e?.message ?? tx("PEP/sanctions screening failed"));
    } finally {
      setCompBusy(false);
    }
  };

  const handleClearCompliance = async (id: string) => {
    setCompBusy(true);
    try {
      await clearCompliance(id, "Cleared after review", "officer");
      await fetchCompliance();
    } catch {
      /* */
    } finally {
      setCompBusy(false);
    }
  };

  /** Clears every non-Passed check in one go — the checklist only ever
   * offered "Run PEP Check", which re-screens via screen_and_store and wipes
   * out any prior clearance (fresh rows, cleared_by reset to null), so a
   * check that had just been cleared would silently flip back to Pending the
   * next time anyone hit that button. This is the actual "approve" action. */
  const handleClearAllCompliance = async () => {
    const toClear = checks.filter((ck) => ck.status !== "Passed");
    if (toClear.length === 0) return;
    setCompBusy(true);
    try {
      await Promise.all(
        toClear.map((ck) =>
          clearCompliance(ck.id, "Cleared after review", "officer"),
        ),
      );
      await fetchCompliance();
    } catch {
      /* */
    } finally {
      setCompBusy(false);
    }
  };

  const handleFailCompliance = async (id: string) => {
    setCompBusy(true);
    try {
      await failCompliance(id, "Failed after review", "officer");
      await fetchCompliance();
    } catch {
      /* */
    } finally {
      setCompBusy(false);
    }
  };

  // ── The medical and financial underwriters' reviews, which final underwriting compiles ─────────────
  const [tracks, setTracks] = useState<CompiledReviews | null>(null);
  const fetchTracks = useCallback(async () => {
    if (!tenantId) return;
    try {
      setTracks((await api.get<CompiledReviews>(`/tenants/${tenantId}/cases/${caseId}/underwriting-tracks`)).data);
    } catch {
      /* non-fatal */
    }
  }, [tenantId, caseId]);

  // ── Gate 5 — Insurance history ────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!tenantId) return;
    try {
      setHistory(await getInsuranceHistory(caseId));
    } catch {
      /* non-fatal */
    }
  }, [tenantId, caseId]);

  const handleRunHistory = async () => {
    setHistBusy(true);
    try {
      setHistory(await runInsuranceHistory(caseId));
      await fetchDetail();
    } catch (e: any) {
      alert(e?.message ?? tx("Insurance history check failed"));
    } finally {
      setHistBusy(false);
    }
  };

  const [acrRequesting, setAcrRequesting] = useState(false);
  const handleRequestAcr = async () => {
    setAcrRequesting(true);
    try {
      const r = await requestACR(caseId);
      if (r.self_request)
        setSuccessMessage(
          "You are the agent on this case: file the report from the agent app.",
        );
      else
        setSuccessMessage(
          r.already_requested
            ? `Already requested from ${r.recipient?.name ?? "the agent"}.`
            : `Asked ${r.recipient?.name ?? "the agent"} to file the ACR from the app.`,
        );
      window.setTimeout(() => setSuccessMessage(null), 4000);
      await fetchAcr();
    } catch (e: any) {
      setError(
        e?.response?.data?.detail ??
          e?.message ??
          "Couldn't send the ACR request.",
      );
    } finally {
      setAcrRequesting(false);
    }
  };

  // Gate 2 can be bypassed by an underwriter when the agent's report never arrives. The reason is kept on record.
  const canWaiveAcr =
    userRole === "Underwriter" || userRole === "Admin" || userRole === "SuperAdmin";
  const [acrWaiving, setAcrWaiving] = useState(false);
  const [waiveModal, setWaiveModal] = useState<"waive" | "undo" | null>(null);
  const [waiveError, setWaiveError] = useState<string | null>(null);
  // One click: the backend still records who waived and when; no reason prompt.
  const handleWaiveAcr = () => {
    void confirmWaiveAcr("Waived by underwriter");
  };
  const handleReinstateAcr = () => {
    setWaiveError(null);
    setWaiveModal("undo");
  };
  const confirmWaiveAcr = async (reason: string) => {
    setAcrWaiving(true);
    setWaiveError(null);
    try {
      setAcr(await waiveACR(caseId, reason));
      setWaiveModal(null);
      setSuccessMessage("ACR waived — Gate 2 is cleared.");
      window.setTimeout(() => setSuccessMessage(null), 4000);
      await fetchDetail();
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "Couldn't waive the ACR.";
      setWaiveError(msg);
      window.alert(msg);
    } finally {
      setAcrWaiving(false);
    }
  };
  const confirmReinstateAcr = async () => {
    setAcrWaiving(true);
    setWaiveError(null);
    try {
      setAcr(await reinstateACR(caseId));
      setWaiveModal(null);
      await fetchDetail();
    } catch (e: any) {
      setWaiveError(
        e?.response?.data?.detail ??
          e?.message ??
          "Couldn't undo the ACR waiver.",
      );
    } finally {
      setAcrWaiving(false);
    }
  };

  const handleHistoryOverride = async (accept: boolean) => {
    setHistBusy(true);
    try {
      const note = accept
        ? "Findings reviewed and accepted by the underwriter"
        : "Adverse history — proposal cannot proceed";
      setHistory(
        accept
          ? await clearInsuranceHistory(caseId, note)
          : await failInsuranceHistory(caseId, note),
      );
      await fetchDetail();
    } catch (e: any) {
      alert(e?.message ?? tx("Failed to record the override"));
    } finally {
      setHistBusy(false);
    }
  };

  // ── Gate 6 — Panel medical examination ────────────────────────────────────
  const fetchMedical = useCallback(async () => {
    if (!tenantId) return;
    try {
      setMedical(await getMedicalExam(caseId));
    } catch {
      /* non-fatal */
    }
  }, [tenantId, caseId]);

  const handleAssessMedical = async () => {
    setMedBusy(true);
    setMedErr(null);
    try {
      const order = await assessMedicalExam(caseId);
      setMedical(order);
      // Required → immediately issue the customer's booking link, same as the
      // pre-underwriting queue's "Assess" shortcut, so this modal always shows
      // a link to send rather than a second click being needed to get one.
      if (order.status !== "NotRequired") {
        const invite = await inviteMedicalExam(caseId);
        setMedLink(portalUrl(invite.link_path));
        setMedDelivery(invite);
      } else {
        setMedLink(null);
        setMedDelivery(null);
      }
      setShowAssessModal(true);
      await fetchDetail();
    } catch (e: any) {
      const msg = e?.message ?? "Could not apply the non-medical limit grid";
      setMedErr(msg);
      alert(msg);
    } finally {
      setMedBusy(false);
    }
  };

  const handleInviteMedical = async () => {
    setMedBusy(true);
    setMedErr(null);
    try {
      const invite = await inviteMedicalExam(caseId);
      setMedLink(portalUrl(invite.link_path));
      setMedDelivery(invite);
      await fetchMedical();
      await fetchDetail();
    } catch (e: any) {
      const msg = e?.message ?? "Failed to generate the booking link";
      setMedErr(msg);
      alert(msg);
    } finally {
      setMedBusy(false);
    }
  };

  const handleLabLink = async () => {
    setMedBusy(true);
    setMedErr(null);
    try {
      setLabLink(await issueLabLink(caseId));
      await fetchMedical();
    } catch (e: any) {
      setMedErr(e?.response?.data?.detail ?? e?.message ?? "Could not create the lab link");
    } finally {
      setMedBusy(false);
    }
  };

  const handleWaiveMedical = async () => {
    const reason = window.prompt("Reason for waiving the medical requirement:");
    if (!reason) return;
    setMedBusy(true);
    setMedErr(null);
    try {
      setMedical(await waiveMedicalExam(caseId, reason));
      await fetchDetail();
    } catch (e: any) {
      const msg = e?.message ?? "Failed to waive the medical requirement";
      setMedErr(msg);
      alert(msg);
    } finally {
      setMedBusy(false);
    }
  };

  // The customer's reports are in: complete the step. Nothing is read or typed here; the reports are read during
  // the underwriting run.
  const handleConfirmReports = async () => {
    setMedBusy(true);
    setMedErr(null);
    try {
      setMedical(await confirmMedicalReports(caseId));
      setShowResultModal(false);
      setSuccessMessage(tx("Medical reports confirmed. They will be read during the underwriting run."));
      window.setTimeout(() => setSuccessMessage(null), 6000);
      await fetchDetail();
    } catch (e: any) {
      setMedErr(e?.response?.data?.detail ?? e?.message ?? "Failed to confirm the reports");
    } finally {
      setMedBusy(false);
    }
  };

  const handleRecordResults = async (results: Record<string, string>) => {
    setMedBusy(true);
    setMedErr(null);
    try {
      setMedical(await recordMedicalResult(caseId, { results }));
      setShowResultModal(false);
      await fetchDetail();
    } catch (e: any) {
      const msg = e?.message ?? "Failed to record the results";
      setMedErr(msg);
      alert(msg);
    } finally {
      setMedBusy(false);
    }
  };

  useEffect(() => {
    fetchDetail();
    fetchArtifacts();
    fetchEApplication();
    fetchAcr();
    fetchHistory();
    fetchTracks();
    fetchMedical();
    fetchRequirements();
    fetchVerificationFindings();
  }, [
    fetchDetail,
    fetchArtifacts,
    fetchEApplication,
    fetchAcr,
    fetchHistory,
    fetchTracks,
    fetchMedical,
    fetchRequirements,
    fetchVerificationFindings,
  ]);

  useEffect(() => {
    const policyId = detail?.policy?.id || detail?.case?.policy_id;
    if (policyId) {
      fetchCompliance();
    }
  }, [detail?.policy?.id, detail?.case?.policy_id, fetchCompliance]);

  // When this page is open inside the Copilot's panel, the chat asks it to
  // re-read its data after something happens in the conversation (a gate run, a
  // document uploaded…) instead of reloading the whole frame — so the user's
  // place and any open dialog are kept.
  // Re-reads everything the page shows — used by the Copilot's refresh message and by live events.
  const refreshCaseData = useCallback(
    () =>
      Promise.all([
        fetchDetail(),
        fetchArtifacts(),
        fetchEApplication(),
        fetchAcr(),
        fetchHistory(),
        fetchTracks(),
        fetchMedical(),
        fetchCompliance(),
        fetchRequirements(),
        fetchVerificationFindings(),
      ]),
    [
    fetchDetail,
    fetchArtifacts,
    fetchEApplication,
    fetchAcr,
    fetchHistory,
    fetchTracks,
    fetchMedical,
    fetchCompliance,
    fetchRequirements,
    fetchVerificationFindings,
    ],
  );
  // The chat asks for a refresh after each of its messages, live events arrive in bursts and a reconnect resyncs:
  // requests close together re-read the case once, never with two rounds of the same requests in flight.
  const requestCaseRefresh = useCoalescedRefresh(refreshCaseData);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin &&
        event.origin !== parentOrigin()
      )
        return;
      if (
        event.data?.source !== "insurance-ai-copilot" ||
        event.data?.type !== "refresh"
      )
        return;
      requestCaseRefresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [requestCaseRefresh]);

  // A run that stopped because requirements were still open starts itself once the last one is
  // satisfied or waived (the live case events refresh `requirements`), so nobody has to come back
  // and press Run. Armed only by such a stop; anything else still needs an explicit click.
  const runAfterRequirementsRef = useRef<(() => void) | null>(null);
  const autoRunArmed = useRef(false);
  useEffect(() => {
    if (/requirements are not/i.test(`${trace.error ?? ""} ${streamError ?? ""}`)) autoRunArmed.current = true;
  }, [trace.error, streamError]);
  const noOpenRequirements =
    requirements.length > 0 && !requirements.some((r) => r.required && r.status !== "Satisfied" && r.status !== "Waived");
  useEffect(() => {
    if (!autoRunArmed.current || !noOpenRequirements || detail?.latest_assessment) return;
    autoRunArmed.current = false;
    setStreamError(null);
    runAfterRequirementsRef.current?.();
  }, [noOpenRequirements, detail?.latest_assessment]);

  // Poll every 3s while any artifact is still being OCR'd, so status/ocr_result
  // update without a manual refresh — same pattern as the /cases explorer.
  useEffect(() => {
    if (!artifacts.some((a) => a.status === "Processing")) return;
    const t = setTimeout(fetchArtifacts, 3000);
    return () => clearTimeout(t);
  }, [artifacts, fetchArtifacts]);

  const searchParams = useSearchParams();
  const autoRun = searchParams.get("autoRun");
  const router = useRouter();
  const { notify } = useNotify();

  // Live updates: when something happens to this case away from this screen (an agent files the
  // ACR from the mobile app, the applicant submits the e-application, the clinic returns the
  // medical...) the gateway pushes a case event over SSE and the page re-reads its data, so
  // nobody has to refresh. A family's gates are recorded on one case, so events for any member
  // case of this family count too.
  const relatedCaseIds = useMemo(() => {
    const ids = new Set<string>([String(caseId)]);
    detail?.family_members?.forEach((m) => ids.add(m.case_id));
    if (detail?.family_head_case) ids.add(detail.family_head_case.case_id);
    return ids;
  }, [caseId, detail?.family_members, detail?.family_head_case]);

  // A reconnect or the tab coming back into view may mean events were missed —
  // re-read rather than show a stale gate until someone refreshes.
  useCaseEvents(
    (evt: CaseEvent) => {
      if (!evt.case_id || !relatedCaseIds.has(evt.case_id)) return;
      if (!LIVE_CASE_EVENTS.has(evt.event_type)) return;
      requestCaseRefresh();
      const message = LIVE_CASE_EVENT_MESSAGES[evt.event_type];
      if (message) notify(message, true);
    },
    true,
    requestCaseRefresh,
  );

  // One-shot popup the moment every pre-underwriting prerequisite clears —
  // fires once per transition into "ready", not on every poll/re-render.
  // Computed here (unconditionally, before the loading/error early returns
  // below) with its own optional-chained reads rather than off the derived
  // `missingPreChecks` array, which only exists after those early returns.
  useEffect(() => {
    if (!detail) return;
    // Final underwriting compiles the two specialist reviews with the ACR and PEP screening.
    const acrReady = isACRCleared(acr);
    const pepReady =
      checks.length > 0 && checks.every((ck) => ck.status === "Passed");
    const allReady =
      Boolean(tracks?.medical.submitted) &&
      Boolean(tracks?.financial.submitted) &&
      acrReady &&
      pepReady;

    // Only news while the case is still waiting for its first AI run — not on every visit to an assessed or decided case.
    const awaitingAi =
      !detail?.latest_assessment && !["Approved", "Rejected", "Closed"].includes(detail?.case?.caseStatus ?? "");
    if (allReady && awaitingAi) {
      if (!notifiedPreUnderwritingRef.current) {
        notifiedPreUnderwritingRef.current = true;
        notify(
          tx(
            "✅ Both specialist reviews, the ACR and PEP screening are in — ready to compile the final underwriting.",
          ),
          true,
        );
        notifyParentPortal("gates_cleared", { caseId });
      }
    } else {
      notifiedPreUnderwritingRef.current = false;
    }
  }, [detail, eApp, acr, checks, history, medical, notify, docsWaived, tracks]);

  // Auto-run underwriting if requested via URL. In group mode the parallel
  // runner below handles every plan, so the single-case path stays out of it.
  useEffect(() => {
    if (isGroup) return;
    const missingDocs = docsWaived ? [] : (detail?.document_checklist?.missing ?? []);
    const checksMissing =
      eApp?.status !== "Submitted" ||
      !isACRCleared(acr);
    // A family member is never assessed on their own as soon as their gates clear: the head and the insured spouse are
    // underwritten first, and the assessments run together afterwards (from the chat).
    const inFamily = (detail?.family_members?.length ?? 0) > 1;
    if (
      detail &&
      !loading &&
      status === "idle" &&
      !live.compositeScore &&
      !detail.latest_assessment &&
      missingDocs.length === 0 &&
      !checksMissing
    ) {
      if (autoRun === "true" && inFamily) {
        router.replace(`/case/${caseId}`); // drop the flag; the page waits for the family's assessment
      } else if (autoRun === "true") {
        // Remove autoRun from URL so we don't re-trigger on refresh
        router.replace(`/case/${caseId}`);
        // Running underwriting is not an Agent action: a pasted ?autoRun link must not start it
        if (localStorage.getItem("user_role") === "Agent") return;
        // Small delay to ensure UI renders first before stream starts
        setTimeout(() => runUnderwriting(), 100);
      }
    }
  }, [
    detail,
    loading,
    status,
    live.compositeScore,
    autoRun,
    caseId,
    router,
    isGroup,
    eApp?.status,
    acr?.status,
    acr?.waived_at,
    docsWaived,
  ]);

  const summarizeDocuments = async () => {
    const texts = artifacts
      .filter((a) => a.ocr_result)
      .map((a) => a.ocr_result as string);
    if (texts.length === 0) return;
    setSummarizing(true);
    setSummarizeError(null);
    try {
      const res = await summarizerApi.post<{ summary: string }>(
        "/summarize/underwriting",
        { documents: texts },
      );
      setDocSummary(res.data.summary);
    } catch (err: any) {
      setSummarizeError(err.message ?? tx("Failed to summarize documents."));
    } finally {
      setSummarizing(false);
    }
  };

  // ── Run AI Underwriting (SSE) ────────────────────────────────────────────────

  const runUnderwriting = async () => {
    if (!detail?.customer || !detail?.policy || !tenantId) return;

    // Required documents must be uploaded before underwriting can proceed.
    const missingDocs = docsWaived ? [] : (detail.document_checklist?.missing ?? []);
    if (missingDocs.length > 0) {
      setStatus("idle");
      setStreamError(
        tx(
          "Required document(s) missing: {0}. Upload them before running underwriting.",
          { 0: missingDocs.join(", ") },
        ),
      );
      return;
    }

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStatus("streaming");
    setLive(EMPTY_LIVE);
    setStreamError(null);
    setTrace({ ...CLOSED_TRACE, open: true, startedAt: Date.now() });

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
        ...(policy.dependent_name
          ? {
              dependent_name: policy.dependent_name,
              dependent_dob: policy.dependent_dob,
            }
          : {}),
      },
      case_id: caseId,
      ...(docSummary ? { ai_summary: docSummary } : {}),
    };

    try {
      const res = await fetch(`${API_BASE}/evaluate/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tenant-Id": tenantId,
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          Array.isArray(body.detail)
            ? body.detail.map((d: any) => d.msg ?? d).join(", ")
            : (body.detail ?? tx("Gateway returned {0}", { 0: res.status })),
        );
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
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (evt.type === "stage") {
            traceStage(evt.stage, { status: evt.status, detail: evt.detail });
          } else if (evt.type === "progress") {
            const node = evt.node as string;
            const data = evt.data as Record<string, any>;
            traceStage(node, {
              status: "done",
              detail:
                node === "medical_scoring" && data.medical_score != null
                  ? tx("Medical risk score {0} / 100", { 0: data.medical_score })
                  : node === "financial_scoring" && data.financial_score != null
                    ? tx("Financial risk score {0} / 100", { 0: data.financial_score })
                    : node === "fraud_detection" && data.fraud_probability != null
                      ? tx("Fraud probability {0}%", { 0: Math.round(Number(data.fraud_probability) * (Number(data.fraud_probability) <= 1 ? 100 : 1)) })
                      : node === "decision_engine" && data.ai_decision
                        ? tx("Recommendation: {0}", { 0: data.ai_decision })
                        : node === "validate_input"
                          ? tx("Plan rules passed")
                          : null,
            });
            if (node === "load_underwriting_profile" && data.underwriting_profile)
              setTrace((t) => ({ ...t, profile: data.underwriting_profile }));
            setLive((prev) => {
              const next: LiveResult = {
                ...prev,
                completedNodes: prev.completedNodes.includes(node)
                  ? prev.completedNodes
                  : [...prev.completedNodes, node],
              };
              if (node === "medical_scoring") {
                next.medicalScore = data.medical_score ?? null;
                next.medicalReasons = data.medical_reasons ?? [];
              } else if (node === "financial_scoring") {
                next.financialScore = data.financial_score ?? null;
                next.financialReasons = data.financial_reasons ?? [];
              } else if (node === "fraud_detection") {
                next.fraudProbability = data.fraud_probability ?? null;
                next.fraudReasons = data.fraud_reasons ?? [];
              } else if (node === "decision_engine") {
                next.compositeScore = data.composite_risk_score ?? null;
                next.aiDecision = data.ai_decision ?? null;
                next.reasons = data.reasons ?? [];
                next.underwritingResults = data.underwriting_results ?? null;
              }
              return next;
            });
            // "done" waits for the saved event, so the report is generated
            // from an assessment that is already recorded.
          } else if (evt.type === "invalid") {
            setStatus("error");
            const message = tx("Validation failed: {0}", {
              0: (evt.errors as string[]).join("; "),
            });
            setStreamError(message);
            traceFail(message);
            break outer;
          } else if (evt.type === "pending_requirements") {
            // The Requirements Engine found unmet mandatory items — risk-engine
            // was never called. Surface it as the case's current state rather
            // than a generic failure.
            setStatus("error");
            const message = tx(
              "Mandatory underwriting requirements are not yet satisfied — see the Requirements panel below.",
            );
            setStreamError(message);
            traceFail(message);
            fetchDetail();
            break outer;
          } else if (evt.type === "error") {
            setStatus("error");
            setStreamError(evt.message ?? tx("An unexpected error occurred."));
            traceFail(evt.message ?? tx("An unexpected error occurred."));
            break outer;
          } else if (evt.type === "saved") {
            traceStage("saving", { status: "done", detail: tx("Case moved to underwriter review") });
            traceStage("report", { status: "running" });
            setStatus("done");
            // Case/Policy status may have auto-transitioned — refresh the case shell.
            fetchDetail();
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setStatus("error");
      setStreamError(err.message ?? tx("Connection failed."));
      traceFail(err.message ?? tx("Connection failed."));
    }
  };

  // ── Run AI Underwriting for one plan in a multi-plan group (SSE) ────────────
  // Same stream as runUnderwriting, but results are written into the per-plan
  // maps so several plans can be underwritten in parallel and viewed on switch.

  const runGroupCase = useCallback(
    async (targetId: string, force = false) => {
      if (!tenantId) return;

      groupAbortsRef.current[targetId]?.abort();
      const abort = new AbortController();
      groupAbortsRef.current[targetId] = abort;

      setGroupStatuses((s) => ({ ...s, [targetId]: "streaming" }));
      setGroupLive((s) => ({ ...s, [targetId]: EMPTY_LIVE }));
      setGroupErrors((s) => ({ ...s, [targetId]: null }));

      try {
        const dres = await api.get<CaseDetailResponse>(
          `/tenants/${tenantId}/cases/${targetId}/detail`,
        );
        const d = dres.data;

        // Already underwritten — surface the persisted result instead of re-running.
        if (!force && d.latest_assessment) {
          setGroupStatuses((s) => ({ ...s, [targetId]: "done" }));
          if (targetId === currentCaseIdRef.current) setDetail(d);
          return;
        }
        if (!d.customer || !d.policy) {
          setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
          setGroupErrors((s) => ({
            ...s,
            [targetId]: "This case has no customer or policy to underwrite.",
          }));
          return;
        }

        // Required documents must be uploaded before this plan can be underwritten
        // — mirror the single-case guard so parallel runs don't slip through.
        const missingDocs = d.document_checklist?.missing ?? [];
        if (missingDocs.length > 0) {
          setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
          setGroupErrors((s) => ({
            ...s,
            [targetId]: `Required document(s) missing: ${missingDocs.join(", ")}. Upload them before running underwriting.`,
          }));
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
            ...(policy.dependent_name
              ? {
                  dependent_name: policy.dependent_name,
                  dependent_dob: policy.dependent_dob,
                }
              : {}),
          },
          case_id: targetId,
        };

        const res = await fetch(`${API_BASE}/evaluate/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tenant-Id": tenantId,
          },
          body: JSON.stringify(payload),
          signal: abort.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = Array.isArray(body.detail)
            ? body.detail.map((x: any) => x.msg ?? x).join(", ")
            : (body.detail ?? `Gateway returned ${res.status}`);
          setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
          setGroupErrors((s) => ({ ...s, [targetId]: msg }));
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
            try {
              evt = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (evt.type === "progress") {
              const node = evt.node as string;
              const data = evt.data as Record<string, any>;
              setGroupLive((s) => {
                const prev = s[targetId] ?? EMPTY_LIVE;
                const next: LiveResult = {
                  ...prev,
                  completedNodes: prev.completedNodes.includes(node)
                    ? prev.completedNodes
                    : [...prev.completedNodes, node],
                };
                if (node === "medical_scoring") {
                  next.medicalScore = data.medical_score ?? null;
                  next.medicalReasons = data.medical_reasons ?? [];
                } else if (node === "financial_scoring") {
                  next.financialScore = data.financial_score ?? null;
                  next.financialReasons = data.financial_reasons ?? [];
                } else if (node === "fraud_detection") {
                  next.fraudProbability = data.fraud_probability ?? null;
                  next.fraudReasons = data.fraud_reasons ?? [];
                } else if (node === "decision_engine") {
                  next.compositeScore = data.composite_risk_score ?? null;
                  next.aiDecision = data.ai_decision ?? null;
                  next.reasons = data.reasons ?? [];
                  next.underwritingResults = data.underwriting_results ?? null;
                }
                return { ...s, [targetId]: next };
              });
              if (node === "decision_engine")
                setGroupStatuses((s) => ({ ...s, [targetId]: "done" }));
            } else if (evt.type === "invalid") {
              setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
              setGroupErrors((s) => ({
                ...s,
                [targetId]: `Validation failed: ${(evt.errors as string[]).join("; ")}`,
              }));
              break outer;
            } else if (evt.type === "pending_requirements") {
              setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
              setGroupErrors((s) => ({
                ...s,
                [targetId]:
                  "Mandatory underwriting requirements are not yet satisfied — see the Requirements panel below.",
              }));
              if (targetId === currentCaseIdRef.current) fetchDetail();
              break outer;
            } else if (evt.type === "error") {
              setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
              setGroupErrors((s) => ({
                ...s,
                [targetId]: evt.message ?? "An unexpected error occurred.",
              }));
              break outer;
            } else if (evt.type === "saved") {
              // Refresh the case shell only if this plan is the one on screen.
              if (targetId === currentCaseIdRef.current) fetchDetail();
            }
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        setGroupStatuses((s) => ({ ...s, [targetId]: "error" }));
        setGroupErrors((s) => ({
          ...s,
          [targetId]: err.message ?? "Connection failed.",
        }));
      }
    },
    [tenantId, fetchDetail],
  );

  // Kick off underwriting for every plan in the group in parallel, exactly once.
  useEffect(() => {
    if (!isGroup || !tenantId) return;
    const sig = planGroup.map((p) => p.caseId).join(",");
    if (groupStartedRef.current === sig) return;
    groupStartedRef.current = sig;
    planGroup.forEach((p) => runGroupCase(p.caseId));
  }, [isGroup, planGroup, tenantId, runGroupCase]);

  // ── Manual override (writes to the real CaseHistory audit trail) ────────────

  const overrideStatus = async (newStatus: string) => {
    if (!tenantId) return;
    setOverriding(newStatus);
    try {
      await api.patch(`/tenants/${tenantId}/cases/${caseId}/status`, {
        status: newStatus,
      });
      await fetchDetail();
      if (newStatus === "Approved") {
        setSuccessMessage(
          tx("Application successfully approved and forwarded to Issuance Queue."),
        );
        if (!isGroup) {
          setTimeout(() => router.push(appHref("/policy-issuance")), 1200);
        }
      }
    } catch (err: any) {
      setError(err.message ?? tx("Failed to update case status."));
    } finally {
      setOverriding(null);
    }
  };

  // Put the whole case on hold / take it off. The server freezes every write while it is held, keeps the case exactly
  // where it stands, and the lead shows as On hold; removing the hold carries on from the same step.
  const putOnHold = async (reason: string) => {
    if (!tenantId) return;
    setHoldBusy(true);
    setHoldError(null);
    try {
      await api.post(`/tenants/${tenantId}/cases/${caseId}/hold`, { reason });
      setHoldModal(false);
      await fetchDetail();
      setSuccessMessage(tx("Underwriting is on hold. Nothing was changed; remove the hold to continue."));
      window.setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: any) {
      setHoldError(err.message ?? tx("Could not put the case on hold."));
    } finally {
      setHoldBusy(false);
    }
  };

  const removeHold = async () => {
    if (!tenantId) return;
    setHoldBusy(true);
    try {
      await api.post(`/tenants/${tenantId}/cases/${caseId}/release`, {});
      await fetchDetail();
      setSuccessMessage(tx("Hold removed. Underwriting continues from where it stopped."));
      window.setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: any) {
      setError(err.message ?? tx("Could not remove the hold."));
    } finally {
      setHoldBusy(false);
    }
  };

  // Ask the summarizer to draft a concise underwriter note from the case
  // context assembled at the call site (customer, policy, scores, decision,
  // reasons). The draft lands in the textarea for review/edit before posting.
  const generateNote = async (context: string) => {
    setGeneratingNote(true);
    setNoteGenError(null);
    try {
      const res = await summarizerApi.post<{ summary: string }>(
        "/summarize/underwriter-note",
        { context },
      );
      setNote(res.data.summary.trim());
    } catch (err: any) {
      setNoteGenError(err.message ?? tx("Failed to generate note."));
    } finally {
      setGeneratingNote(false);
    }
  };

  const downloadPDF = async () => {
    if (!customer || (!hasLive && !assessment)) return;
    const { generateCaseReportPDF } = await import("@/lib/case-report");

    await generateCaseReportPDF({
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
      reasons: hasLive
        ? [...medicalReasons, ...financialReasons, ...fraudReasons]
        : (assessment?.reasons ?? []),
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
      setError(err.message ?? tx("Failed to post note."));
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
      setError(err.message ?? tx("Failed to generate application PDF."));
    } finally {
      setDownloadingApp(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-screen-2xl mx-auto px-6 py-20 flex flex-col items-center justify-center gap-2">
        <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
        <span className="text-xs text-slate-400">{tx("Loading case…")}</span>
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="max-w-screen-2xl mx-auto px-6 py-10">
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <p className="text-sm font-bold text-red-700 mb-1">
            {tx("Failed to load case")}
          </p>
          <p className="text-xs text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const { case: c, customer, policy, document_checklist: docs } = detail;

  // Underwriting requires every mandatory document to be uploaded AND
  // all initial checks to be completed — the Run / Re-run buttons stay
  // disabled until the checklist has nothing missing.
  const actualMissingDocs = docs?.missing ?? [];
  const missingRequiredDocs = docsWaived ? [] : actualMissingDocs;
  // Final underwriting compiles four inputs: the medical and financial underwriters' submitted reviews (documents,
  // the e-application, the medical examination and insurance history are theirs to complete), the agent's report and
  // PEP & sanctions screening.
  const missingPreChecks: string[] = [];
  if (!tracks?.medical.submitted) missingPreChecks.push("Medical underwriting review");
  if (!tracks?.financial.submitted) missingPreChecks.push("Financial underwriting review");
  if (!isACRCleared(acr))
    missingPreChecks.push("Agent's Confidential Report");

  const medicalDone =
    medical?.status === "Completed" ||
    medical?.status === "NotRequired" ||
    medical?.status === "Waived";
  // Customer-submitted reports leave the order Invited — only staff recording
  // the review completes the gate, so the step has to offer that review.
  const medicalReports = (medical?.reports ?? []).filter(usableReport);
  const medicalReportsSubmitted = !medicalDone && !!medical?.reports_submitted;
  const medicalReportsCoveredTests = new Set(medicalReports.map((r) => r.test_code)).size;
  const medicalAwaitingReview =
    !medicalDone && (medical?.status === "Scheduled" || medicalReportsSubmitted);
  const historyDone = history?.status === "Clear";
  const pepDone =
    checks.length > 0 && checks.every((ck) => ck.status === "Passed");

  if (!pepDone) missingPreChecks.push("PEP & Sanctions Screening");

  const reviewStep = (track: "medical" | "financial"): PrereqStep => {
    const r = tracks?.[track];
    const who = track === "medical" ? "medical underwriter" : "financial underwriter";
    return {
      id: `${track}_review`,
      title: track === "medical" ? "Medical Underwriting Review" : "Financial Underwriting Review",
      done: Boolean(r?.submitted),
      statusLabel: REVIEW_STATUS_LABEL[r?.status ?? "PENDING"] ?? r?.status ?? "Not started",
      description: r?.submitted
        ? `${r.reviewer ?? `The ${who}`} recorded ${REVIEW_STATUS_LABEL[r.status].toLowerCase()}${r.note ? ` — “${r.note}”` : "."}`
        : r?.reviewer
          ? `${r.reviewer} is reviewing. The decision is compiled once they submit.`
          : `Not assigned yet. Assign a ${who} from Admin › Underwriting.`,
    };
  };

  const allPrereqSteps = [
    {
      id: "docs",
      title: "Mandatory Documents Checklist",
      done: missingRequiredDocs.length === 0,
      statusLabel: docsWaived && actualMissingDocs.length > 0
        ? "Waived"
        : missingRequiredDocs.length === 0
          ? "Completed"
          : `Missing (${missingRequiredDocs.length})`,
      description: docsWaived && actualMissingDocs.length > 0
        ? `Proceeding without: ${actualMissingDocs.join(", ")}. Documents can still be uploaded later.`
        : missingRequiredDocs.length === 0
          ? "All required documents uploaded and processed by OCR."
          : `Missing required document(s): ${missingRequiredDocs.join(", ")}`,
      actionLabel:
        missingRequiredDocs.length === 0
          ? "Manage / Upload Docs"
          : "Upload Documents",
      onAction: () => setShowUpload(true),
      // Bypass when a document can't be obtained (underwriter / admin only).
      secondaryActionLabel:
        canWaiveAcr && actualMissingDocs.length > 0
          ? docsWaived
            ? "Undo waiver"
            : "Proceed without"
          : undefined,
      onSecondaryAction: () => toggleDocsWaived(!docsWaived),
      secondaryBusy: false,
    },
    {
      id: "eapp",
      title: "Customer E-Application Questionnaire",
      done: eApp?.status === "Submitted" || eApp?.status === "Verified",
      statusLabel: eApp?.status ?? "Not Sent",
      description:
        eApp?.status === "Submitted" || eApp?.status === "Verified"
          ? `Customer E-Application submitted (${eApp.status}).`
          : "Customer health disclosures questionnaire pending submission or verification.",
      actionLabel: "Open E-Application",
      actionHref: `/underwriting?tab=pre-underwriting&case=${caseId}&gate=eapp&returnTo=${encodeURIComponent(`/case/${caseId}`)}`,
    },
    {
      id: "medical",
      title: "Medical Examination / NML Grid",
      done: medicalDone,
      statusLabel: medicalReportsSubmitted
        ? "Reports Submitted"
        : medical?.status === "Invited" && medicalReports.length > 0
          ? "Reports Uploading"
          : (medical?.status ?? "Not Assessed"),
      description: medicalDone
        ? `Medical examination status: ${medical?.status}`
        : medicalReportsSubmitted
          ? `The lab submitted ${medicalReports.length} report${medicalReports.length === 1 ? "" : "s"} covering ${medicalReportsCoveredTests} of ${medical?.required_tests.length ?? 0} required tests — review them and record the results.`
          : medical?.status === "Invited" && medicalReports.length > 0
            ? `The lab has uploaded reports for ${medicalReportsCoveredTests} of ${medical.required_tests.length} required tests and has not submitted yet.`
            : "Non-medical limit grid or panel diagnostic check required.",
      actionLabel: medBusy
        ? "Assessing…"
        : medicalReportsSubmitted
          ? "Review Reports"
          : medical?.status === "Scheduled"
            ? "Lab Link & Results"
            : "Assess Medical",
      onAction: medicalReportsSubmitted
        ? () => setShowResultModal(true)
        : medical?.status === "Scheduled"
          ? () => { setLabLink(null); setMedErr(null); setShowLabLinkModal(true); }
          : handleAssessMedical,
      busy: medBusy,
    },
    {
      id: "acr",
      title: "Agent's Confidential Report (ACR)",
      done: isACRCleared(acr),
      statusLabel:
        acr?.status === "Submitted"
          ? "Submitted"
          : acr?.waived_at
            ? "Waived"
            : acr?.requested_at
              ? "Awaiting agent"
              : (acr?.status ?? "Not Started"),
      description:
        acr?.status === "Submitted"
          ? `Moral hazard & financial standing report filed by field agent.${detail?.family_head_case ? ` Filed once for the whole family (recorded on the head's case ${detail.family_head_case.case_number}) — one proposer, one report.` : ""}`
          : acr?.waived_at
            ? `Waived by ${acr.waived_by ?? "an underwriter"} on ${displayDate(acr.waived_at)}${acr.waiver_reason ? ` — “${acr.waiver_reason}”` : ""}. The agent can still file the report.`
            : detail?.family_head_case
              ? `The agent's report on the proposer is filed once for the whole family — it is recorded on the head's case ${detail.family_head_case.case_number}.`
              : "Waiting for the agent to submit the confidential report from the agent app.",
      // The report is the agent's own, filed from the app: staff can read it once it is in, and ask for it until then.
      actionLabel:
        acr?.status === "Submitted"
          ? "View ACR"
          : acrRequesting
            ? "Asking…"
            : acr?.requested_at
              ? "Remind agent"
              : "Request from agent",
      busy: acrRequesting,
      onAction:
        acr?.status === "Submitted"
          ? () => setShowACRModal(true)
          : handleRequestAcr,
      // Bypass for when the report never arrives (underwriter / admin only; nothing to waive once submitted).
      secondaryActionLabel:
        canWaiveAcr && acr?.status !== "Submitted"
          ? acrWaiving
            ? "Saving…"
            : acr?.waived_at
              ? "Undo waiver"
              : "Waive"
          : undefined,
      onSecondaryAction: acr?.waived_at ? handleReinstateAcr : handleWaiveAcr,
      secondaryBusy: acrWaiving,
    },
    {
      id: "pep",
      title: "PEP & Sanctions Screening",
      done: pepDone,
      statusLabel: pepDone
        ? "Passed"
        : checks.length > 0
          ? "Flagged"
          : "Pending",
      description: pepDone
        ? "Compliance check cleared against SECP & OpenSanctions database."
        : checks.length > 0
          ? "Screened and flagged for manual sign-off — clear it below once reviewed."
          : "PEP & AML screening required.",
      // Re-screening (screen_and_store) replaces every check row, wiping any
      // existing clearance — so once a check exists, the action here is to
      // clear it, not to run it again. Running again is still possible from
      // the Underwriting queue's "Re-Screen" action if a genuinely fresh
      // screen is needed.
      actionLabel: compBusy
        ? checks.length > 0
          ? "Clearing…"
          : "Screening…"
        : checks.length > 0
          ? pepDone
            ? "Cleared"
            : "Clear Flagged Check"
          : "Run PEP Check",
      onAction:
        checks.length > 0
          ? pepDone
            ? undefined
            : handleClearAllCompliance
          : handleRunCompliance,
      busy: compBusy,
    },
    {
      id: "history",
      title: "Insurance History Clearance",
      done: historyDone,
      statusLabel: history?.status ?? "Not Started",
      description: historyDone
        ? "Prior coverage & replacement history check clear."
        : history?.status === "Flagged"
          ? // Running the screen again only flags it again — a flagged screen needs someone to accept it.
            `Flagged: ${
              (history.findings ?? [])
                .map((f) => f.message)
                .slice(0, 2)
                .join(" ") || "over-insurance or prior-history findings."
            } Review it, then accept the findings to continue.`
          : "Prior policy coverage & over-insurance history check required.",
      actionLabel: histBusy
        ? "Working…"
        : history?.status === "Flagged"
          ? "Accept Findings & Clear"
          : "Run History Check",
      onAction:
        history?.status === "Flagged"
          ? () => {
              if (
                window.confirm(
                  tx(
                    "Accept the flagged insurance-history findings and clear this gate? This is recorded as an underwriter override.",
                  ),
                )
              )
                handleHistoryOverride(true);
            }
          : handleRunHistory,
      busy: histBusy,
    },
  ];

  const prereqSteps: PrereqStep[] = [
    reviewStep("medical"),
    reviewStep("financial"),
    ...allPrereqSteps.filter((step) => step.id === "acr" || step.id === "pep"),
  ];

  const requiredDocsMissing = missingPreChecks.length > 0;
  // A required underwriting requirement that is neither satisfied nor waived blocks the AI run. Waiving it (or the
  // item arriving and a resubmit marking it satisfied) lifts the block. Nothing is blocked until requirements exist.
  const openRequirements = requirements.filter(
    (r) => r.required && r.status !== "Satisfied" && r.status !== "Waived",
  );
  const requirementsOpen = openRequirements.length > 0;
  const requirementsOpenText = `Open requirements: ${openRequirements.map((r) => r.code.replace(/_/g, " ").toLowerCase()).join(", ")}. Satisfy or waive them first.`;

  // In a multi-plan group each plan streams in parallel into its own slice of the
  // maps; otherwise fall back to the single-case state. Everything below renders
  // whichever plan is currently on screen.
  const effStreamError = isGroup ? (groupErrors[caseId] ?? null) : streamError;
  const handleRun = () =>
    isGroup ? runGroupCase(caseId, true) : runUnderwriting();
  runAfterRequirementsRef.current = handleRun;

  // Prefer the live (just-streamed) result for this session; fall back to the
  // last persisted assessment. Live gives per-category reasons; persisted only
  // has the flat merged `reasons` array (decision_aggregation merges them
  // before writing to the DB), so the two render slightly differently below.
  const assessment = detail.latest_assessment;
  const hasAny = hasLive || assessment !== null;

  const medicalScore = hasLive
    ? effLive.medicalScore!
    : (assessment?.medical_score ?? 0);
  const financialScore = hasLive
    ? effLive.financialScore!
    : (assessment?.financial_score ?? 0);
  const fraudProbability = hasLive
    ? effLive.fraudProbability!
    : (assessment?.fraud_probability ?? 0);
  const compositeScore = hasLive
    ? effLive.compositeScore!
    : (assessment?.composite_risk_score ?? 0);
  const aiDecision =
    (hasLive ? effLive.aiDecision : assessment?.ai_decision) ?? null;
  const suggestedLoading = hasLive
    ? null
    : (assessment?.suggested_loading ?? null);
  const underwritingResults: UnderwritingResults | null = hasLive
    ? effLive.underwritingResults
    : (assessment?.underwriting_results ?? null);
  const fraudPct = +((fraudProbability ?? 0) * 100).toFixed(1);

  // Per-category explainability reasons — from the live stream when available,
  // otherwise from the persisted assessment. Rendering the same Medical /
  // Financial / Fraud breakdown for every plan (single or multi, live or saved)
  // keeps the Explainability Report format identical across the board.
  const medicalReasons = hasLive
    ? effLive.medicalReasons
    : (assessment?.medical_reasons ?? []);
  const financialReasons = hasLive
    ? effLive.financialReasons
    : (assessment?.financial_reasons ?? []);
  const fraudReasons = hasLive
    ? effLive.fraudReasons
    : (assessment?.fraud_reasons ?? []);
  // Legacy assessments predate the per-category columns; fall back to the flat
  // merged list only when no categorized reasons exist at all.
  const hasCategorizedReasons =
    hasLive ||
    medicalReasons.length + financialReasons.length + fraudReasons.length > 0;

  // Single source of truth for the AI Analysis — both the list and table views
  // render from this so the two stay perfectly in sync.
  const reasonSections: ReasonSection[] = [
    {
      label: "Medical Risk Factors",
      short: "Medical",
      icon: "🩺",
      score: medicalScore,
      scoreLabel: `${medicalScore}%`,
      reasons: medicalReasons,
      accentColor: "text-slate-800",
    },
    {
      label: "Financial Risk Factors",
      short: "Financial",
      icon: "💰",
      score: financialScore,
      scoreLabel: `${financialScore}%`,
      reasons: financialReasons,
      accentColor: "text-slate-800",
    },
    {
      label: "Fraud Risk Factors",
      short: "Fraud",
      icon: "🛡️",
      score: fraudPct,
      scoreLabel: `${fraudPct}%`,
      reasons: fraudReasons,
      accentColor: "text-slate-800",
    },
  ];

  // Compact case context handed to the AI note generator — mirrors what the
  // underwriter sees on screen so the drafted note is grounded in real data.
  const buildNoteContext = (): string => {
    const lines: string[] = [];
    if (customer) {
      const age = customer.dob
        ? Math.floor(
            (Date.now() - new Date(customer.dob).getTime()) / 31557600000,
          )
        : null;
      lines.push(
        `Applicant: ${customer.name}${age ? `, age ${age}` : ""}, ${customer.gender}${customer.occupation ? `, ${customer.occupation}` : ""}.`,
      );
      lines.push(
        `Smoker: ${customer.is_smoker ? "Yes" : "No"}. Declared income: ${customer.declared_income ? fmtIncome(customer.declared_income) : "unknown"}.`,
      );
    }
    if (policy) {
      lines.push(
        `Policy: ${INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.product_name}, coverage ${fmtCoverage(policy.coverage_amount)}, term ${policy.term_years} years.`,
      );
    }
    if (hasAny) {
      lines.push(
        `Risk scores — Medical ${medicalScore}%, Financial ${financialScore}%, Fraud ${fraudPct}%, Composite ${compositeScore}%.`,
      );
      if (aiDecision)
        lines.push(
          `AI recommended decision: ${aiDecision}${suggestedLoading ? ` with suggested loading ${suggestedLoading}%` : ""}.`,
        );
      const factorLines = reasonSections
        .filter((s) => s.reasons.length > 0)
        .map((s) => `${s.short} factors: ${s.reasons.join("; ")}.`);
      if (factorLines.length) lines.push(...factorLines);
      else if (assessment?.reasons?.length)
        lines.push(`Key factors: ${assessment.reasons.join("; ")}.`);
    }
    if (docSummary)
      lines.push(
        `Document summary: ${docSummary.replace(/[#*]/g, "").replace(/\s+/g, " ").trim().slice(0, 600)}`,
      );
    return lines.join("\n");
  };

  // The three decision buttons, in the pinned page header beside Download Application so they are always in reach.
  // Once the case has reached a final decision (the override
  // or the AI's own Auto Approve/Decline) there is nothing left to override, so they are hidden rather than let a
  // stale click re-assert the same status and bounce off the policy state machine ("Approved → Approved").
  const prereqsIncomplete = missingPreChecks.length > 0;
  const onHold = !!c.on_hold;
  const decisionButtons = onHold ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="px-3 py-2 text-sm font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">{tx("On hold")}</span>
      <button
        onClick={removeHold}
        disabled={holdBusy || userRole === "Agent"}
        title={userRole === "Agent" ? tx("Currently, you have no access to do this, ask your manager") : tx("Take the case off hold and continue from where it stopped.")}
        className={`px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg transition-colors shadow-sm ${userRole === "Agent" ? "opacity-50 cursor-not-allowed" : "hover:bg-blue-700"}`}
      >
        {holdBusy ? <Spinner /> : tx("Remove hold")}
      </button>
    </div>
  ) :
    c.caseStatus !== "Approved" && c.caseStatus !== "Rejected" ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          onClick={() => { setHoldError(null); setHoldModal(true); }}
          disabled={overriding !== null || userRole === "Agent"}
          title={
            userRole === "Agent"
              ? tx("Currently, you have no access to do this, ask your manager")
              : tx("Pause the whole underwriting process exactly where it is. The lead shows as On hold until you remove the hold.")
          }
          className={`px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg transition-colors ${userRole === "Agent" ? "opacity-50 cursor-not-allowed bg-slate-100" : "hover:bg-slate-50"}`}
        >
          {tx("On hold")}
        </button>
        <button
          onClick={() => overrideStatus("Rejected")}
          disabled={overriding !== null || userRole === "Agent"}
          title={
            userRole === "Agent"
              ? tx("Currently, you have no access to do this, ask your manager")
              : undefined
          }
          className={`px-4 py-2 text-sm font-semibold text-red-700 border border-red-200 bg-red-50 rounded-lg transition-colors ${userRole === "Agent" ? "opacity-50 cursor-not-allowed" : "hover:bg-red-100"}`}
        >
          {overriding === "Rejected" ? (
            <Spinner className="w-3.5 h-3.5 border-red-300 border-t-red-700" />
          ) : (
            tx("Decline")
          )}
        </button>
        <button
          onClick={() => overrideStatus("Approved")}
          disabled={
            overriding !== null ||
            !hasAny ||
            prereqsIncomplete ||
            userRole === "Agent"
          }
          title={
            userRole === "Agent"
              ? tx("Currently, you have no access to do this, ask your manager")
              : prereqsIncomplete
                ? tx("Complete all {1} steps first. Still missing: {0}", {
                    1: prereqSteps.length,
                    0: missingPreChecks.join("; "),
                  })
                : !hasAny
                  ? tx("Run AI Underwriting before approving")
                  : undefined
          }
          className={`px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg transition-colors shadow-sm ${userRole === "Agent" || prereqsIncomplete || !hasAny ? "opacity-50 cursor-not-allowed" : "hover:bg-blue-700"}`}
        >
          {overriding === "Approved" ? <Spinner /> : tx("Proceed")}
        </button>
      </div>
    ) : null;

  downloadPDFRef.current = downloadPDF;
  triggerNotesRef.current = () => generateNote(buildNoteContext());

  return (
    <div
      className="case-modern max-w-screen-2xl mx-auto px-6 pb-10 space-y-5"
      style={{ ["--case-head" as any]: `${headHeight}px` }}
    >
      {successMessage && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-top-5">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="w-5 h-5 text-blue-100"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
          <div className="font-semibold text-sm">{successMessage}</div>
        </div>
      )}

      <CaseWorkspaceHeader headerRef={headRef} name={customer?.name ?? tx("Unknown Customer")} reference={c.caseNumber}
        status={<span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${CASE_STATUS_STYLE[c.caseStatus] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>{c.caseStatus}</span>}
        extraStatus={aiDecision && <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">{tx("AI")} <StatusBadge decision={aiDecision} size="sm" /></span>}
        fields={[{ label: "CNIC", value: customer?.cnic }, { label: "Plan", value: policy?.product_name }, { label: "Cover", value: policy ? fmtCoverage(policy.coverage_amount) : null }, { label: "Term", value: policy ? `${policy.term_years} ${tx("yrs")}` : null }, { label: "Opened", value: displayDate(c.createdAt) }]}
        tab={caseTab} onTab={setCaseTab} documentCount={artifacts.length} actions={
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <button
              type="button"
              onClick={() => {
                setShowDocuments(true);
                void fetchArtifacts();
              }}
              title={tx("Open Application Folder")}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-slate-500" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              {tx("Folder")}
              <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{artifacts.length}</span>
            </button>
            <button
              onClick={downloadApplication}
              disabled={downloadingApp}
              title={
                hasAny
                  ? tx("Download the complete application dossier (PDF)")
                  : tx("Best generated after underwriting — includes whatever detail is available")
              }
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {downloadingApp ? (
                <Spinner className="w-4 h-4 border-slate-300 border-t-slate-700" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-slate-500">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
                </svg>
              )}
              {downloadingApp ? tx("Generating…") : tx("Download")}
            </button>
            {decisionButtons && <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />}
            {decisionButtons}
          </div>
        } />

      {onHold && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-amber-900">{tx("Underwriting is on hold")}</p>
            <p className="text-xs text-amber-800 mt-0.5">
              {c.hold_reason ? <>{tx("Reason")}: <span className="font-semibold">{c.hold_reason}</span> · </> : null}
              {c.held_at ? <>{tx("Since")} {displayDate(c.held_at)} · </> : null}
              {tx("Paused at: {0}. Every step is frozen; remove the hold to continue from here.", { 0: c.held_from_status ?? c.caseStatus })}
            </p>
          </div>
        </div>
      )}

      {/* ── Plan switcher (multi-plan underwriting group) ─────────────────── */}
      {isGroup &&
        (() => {
          const doneCount = planGroup.filter(
            (p) => groupStatuses[p.caseId] === "done",
          ).length;
          const runningCount = planGroup.filter(
            (p) => groupStatuses[p.caseId] === "streaming",
          ).length;
          const glyph = (st?: StreamStatus) =>
            st === "done"
              ? "✓"
              : st === "streaming"
                ? "⏳"
                : st === "error"
                  ? "⚠"
                  : "•";
          return (
            <div className="card px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3 border-blue-200 bg-blue-50/40">
              <div className="flex items-center gap-2.5 min-w-0 sm:flex-1">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-blue-100 text-blue-700 flex-shrink-0">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4"
                  >
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-700 truncate">
                    {tx("Underwriting")} {planGroup.length} {tx("plans for")}{" "}
                    {customer?.name ?? tx("this customer")}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {runningCount > 0
                      ? tx("{0} of {1} done · {2} running in parallel", {
                          0: doneCount,
                          1: planGroup.length,
                          2: runningCount,
                        })
                      : tx("{0} of {1} plans underwritten", {
                          0: doneCount,
                          1: planGroup.length,
                        })}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 min-w-0 sm:flex-shrink-0">
                <span className="text-[11px] font-medium text-slate-400 flex-shrink-0 hidden sm:inline">
                  {tx("Viewing")}
                </span>
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
                      {glyph(groupStatuses[p.caseId])} {i + 1}. {p.planLabel}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })()}

      {/* ── Family: one tab per insured member (head, fully insured spouse) ───────────── */}
      {(detail?.family_members?.length ?? 0) > 1 && (
        <div
          className="flex items-end gap-1 border-b border-slate-200 overflow-x-auto"
          role="tablist"
          aria-label={tx("Insured family members")}
        >
          {[...(detail?.family_members ?? [])]
            .sort(
              (a, b) =>
                Number(/^self$/i.test(String(b.relationship))) -
                Number(/^self$/i.test(String(a.relationship))),
            )
            .map((m) => {
              const role =
                m.relationship === "SELF" || m.relationship === "Self"
                  ? "Head"
                  : m.relationship
                    ? m.relationship[0] + m.relationship.slice(1).toLowerCase()
                    : "";
              const active = m.case_id === detail?.case.caseld;
              return (
                <button
                  key={m.case_id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    if (!active) router.push(`/case/${m.case_id}`);
                  }}
                  className={`px-4 py-2.5 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${active ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
                >
                  {m.name}
                  {role && (
                    <span className="ml-1.5 font-normal text-slate-400">
                      · {role}
                    </span>
                  )}
                  <span
                    className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${m.case_status === "Approved" || m.case_status === "Closed" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-50 text-slate-500 border-slate-200"}`}
                  >
                    {m.case_status}
                  </span>
                </button>
              );
            })}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}


      {/* ── Overview: the assessment and the decision ─────────────────────── */}
      <div className={caseTab === "overview" ? "grid grid-cols-1 gap-5 lg:grid-cols-3" : "hidden"}>
        <div className="space-y-5 lg:col-span-2">
          {!hasAny ? (
            <div className="card space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="section-label">{tx("AI underwriting")}</h3>
                  <p className="mt-1 max-w-xl text-sm text-slate-500">
                    {requiredDocsMissing
                      ? tx("Not run yet. Once both specialist reviews, the agent's report and PEP screening are in, run it to compile them into the final recommendation.")
                      : tx("Everything is in place. Run it to compile the medical and financial reviews, PEP screening and the agent's report into the final recommendation.")}
                  </p>
                </div>
                <button
                  onClick={handleRun}
                  disabled={
                    effStatus === "streaming" ||
                    !policy ||
                    !customer ||
                    requiredDocsMissing ||
                    requirementsOpen ||
                    userRole === "Agent" ||
                    onHold
                  }
                  title={
                    onHold
                      ? tx("The case is on hold. Remove the hold to continue.")
                      : userRole === "Agent"
                      ? tx(
                          "Currently, you have no access to do this, ask your manager",
                        )
                      : requirementsOpen
                        ? requirementsOpenText
                        : requiredDocsMissing
                          ? tx("Complete missing requirements first: {0}", {
                              0: missingPreChecks.join("; "),
                            })
                          : undefined
                  }
                  className="flex flex-shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {effStatus === "streaming" ? <Spinner /> : null}
                  {effStatus === "streaming"
                    ? tx("Running…")
                    : tx("Run AI Underwriting")}
                </button>
              </div>
              {trace.open && (
                <RunTracker trace={trace} onDismiss={() => setTrace(CLOSED_TRACE)} />
              )}
              <SpecialistReviewsSummary tracks={tracks} />
              {requirementsOpen && !requiredDocsMissing && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3">
                  <p className="max-w-xl text-sm text-amber-800">
                    {requirementsOpenText}
                  </p>
                  <button
                    type="button"
                    onClick={runDetermineRequirements}
                    disabled={requirementsBusy || userRole === "Agent"}
                    title={
                      userRole === "Agent"
                        ? tx(
                            "Currently, you have no access to do this, ask your manager",
                          )
                        : tx(
                            "Re-check the requirements once the missing item has been added",
                          )
                    }
                    className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-4 py-2 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-50"
                  >
                    {requirementsBusy ? (
                      <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" />
                    ) : null}
                    {requirementsBusy ? tx("Checking…") : tx("Resubmit")}
                  </button>
                </div>
              )}
              {requiredDocsMissing && (
                <div className="border-t border-slate-100 pt-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{tx("Before you can run it")}</p>
                    <span className="text-sm text-slate-500">
                      <span className="font-semibold text-slate-900">{prereqSteps.filter((s) => s.done).length}</span>{" "}
                      {tx("of")} {prereqSteps.length} {tx("ready")}
                    </span>
                  </div>

                  {/* Vertical Thread Stepper */}
                  <div className="relative pl-7 space-y-4 before:absolute before:left-3 before:top-3 before:bottom-3 before:w-0.5 before:bg-slate-200">
                    {prereqSteps.map((step, idx) => (
                      <div
                        key={step.id}
                        className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                      >
                        {/* Thread Node Circle */}
                        <div
                          className={`absolute -left-7 w-6 h-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold transition-all z-10 ${
                            step.done
                              ? "bg-emerald-500 border-emerald-600 text-white shadow-xs"
                              : "bg-white border-amber-500 text-amber-600 shadow-2xs animate-pulse"
                          }`}
                        >
                          {step.done ? "✓" : idx + 1}
                        </div>

                        {/* Step Details */}
                        <div className="min-w-0 flex-1 pl-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`text-xs ${step.done ? "font-bold text-slate-800" : "font-extrabold text-slate-900"}`}
                            >
                              {tx(step.title)}
                            </span>
                            <span
                              className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${
                                step.done
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200/80"
                                  : "bg-amber-50 text-amber-800 border-amber-300/80"
                              }`}
                            >
                              {step.statusLabel}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mt-1 leading-snug">
                            {tx(step.description)}
                          </p>
                        </div>

                        {/* Action Link / Button */}
                        <div className="shrink-0 pl-1 sm:pl-0 flex items-center gap-2">
                          {step.actionHref && onHold ? (
                            <span
                              aria-disabled="true"
                              title={tx("The case is on hold. Remove the hold to continue.")}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-bold rounded-lg border border-slate-200 cursor-not-allowed"
                            >
                              <span>{step.actionLabel}</span>
                              <span className="text-[10px]">↗</span>
                            </span>
                          ) : step.actionHref ? (
                            <Link
                              href={step.actionHref}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-blue-700 text-xs font-bold rounded-lg border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all"
                            >
                              <span>{step.actionLabel}</span>
                              <span className="text-[10px]">↗</span>
                            </Link>
                          ) : step.onAction ? (
                            <button
                              onClick={step.onAction}
                              disabled={step.busy || userRole === "Agent" || onHold}
                              title={
                                onHold
                                  ? tx("The case is on hold. Remove the hold to continue.")
                                  : userRole === "Agent"
                                  ? tx(
                                      "Currently, you have no access to do this, ask your manager",
                                    )
                                  : undefined
                              }
                              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 ${
                                step.done
                                  ? "bg-white hover:bg-slate-100 text-slate-700 border-slate-200/90"
                                  : "bg-blue-600 hover:bg-blue-700 text-white border-blue-600 shadow-2xs"
                              } ${userRole === "Agent" || onHold ? "opacity-50 cursor-not-allowed" : ""}`}
                            >
                              {step.busy ? (
                                <Spinner className="w-3 h-3 border-white border-t-transparent" />
                              ) : null}
                              <span>{step.actionLabel}</span>
                            </button>
                          ) : null}
                          {step.secondaryActionLabel && step.onSecondaryAction && (
                            <button
                              onClick={step.onSecondaryAction}
                              disabled={step.secondaryBusy || onHold}
                              title={onHold ? tx("The case is on hold. Remove the hold to continue.") : undefined}
                              className="px-3 py-1.5 text-xs font-bold rounded-lg border bg-white hover:bg-slate-100 text-slate-700 border-slate-200/90 transition-all disabled:opacity-50"
                            >
                              {step.secondaryActionLabel}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {effStreamError && !requiredDocsMissing && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
                  {effStreamError}
                </p>
              )}
            </div>
          ) : (
            <>
              {/* AI assessment: the composite score, the three risk dimensions with the AI's finding for each, and the
                  recommendation — one card instead of bars, a ring, three repeat tiles and a banner. */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <h3 className="section-label">{tx("AI assessment")}</h3>
                  <div className="flex items-center gap-2">
                    {assessment && (
                      <button
                        onClick={downloadPDF}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-slate-500">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
                        </svg>
                        {tx("Report")}
                      </button>
                    )}
                    <button
                      onClick={handleRun}
                      disabled={
                        effStatus === "streaming" ||
                        requiredDocsMissing ||
                        requirementsOpen ||
                        userRole === "Agent" ||
                        onHold
                      }
                      title={
                        onHold
                          ? tx("The case is on hold. Remove the hold to continue.")
                          : userRole === "Agent"
                          ? tx(
                              "Currently, you have no access to do this, ask your manager",
                            )
                          : requirementsOpen
                            ? requirementsOpenText
                            : requiredDocsMissing
                              ? tx("Complete missing requirements first: {0}", {
                                  0: missingPreChecks.join("; "),
                                })
                              : undefined
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {effStatus === "streaming" ? (
                        <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" />
                      ) : null}
                      {effStatus === "streaming"
                        ? tx("Re-running…")
                        : tx("Re-run")}
                    </button>
                  </div>
                </div>

                {trace.open && (
                  <div className="px-5 pt-4">
                    <RunTracker trace={trace} onDismiss={() => setTrace(CLOSED_TRACE)} />
                  </div>
                )}
                {effStreamError && !trace.open && (
                  <p className="mx-5 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                    {effStreamError}
                  </p>
                )}

                <div className="grid gap-6 p-5 md:grid-cols-[200px_1fr]">
                  {(() => {
                    const tier = scoreTier(compositeScore);
                    return (
                      <div className="flex flex-col justify-center rounded-xl bg-slate-50 p-5">
                        <p className="text-sm text-slate-500">{tx("Composite risk")}</p>
                        <p className="mt-1 text-5xl font-bold tracking-tight text-slate-900 tabular-nums">
                          {compositeScore}
                          <span className="text-2xl font-semibold text-slate-400">%</span>
                        </p>
                        <p className={`mt-1 text-sm font-semibold ${tier.color}`}>{tx(tier.label)}</p>
                        <div className="mt-4 h-1.5 rounded-full bg-slate-200">
                          <div className={`h-1.5 rounded-full ${scoreColor(compositeScore)}`} style={{ width: `${Math.min(100, compositeScore)}%` }} />
                        </div>
                      </div>
                    );
                  })()}
                  <div className="divide-y divide-slate-100">
                    {[
                      {
                        label: tx("Medical"),
                        score: medicalScore,
                        finding: underwritingResults?.medical
                          ? [
                              underwritingResults.medical.risk_class,
                              underwritingResults.medical.loading_percentage
                                ? `+${underwritingResults.medical.loading_percentage}% ${tx("loading")}`
                                : null,
                              underwritingResults.medical.requires_human_review ? tx("needs human review") : null,
                            ].filter(Boolean).join(" · ")
                          : null,
                      },
                      {
                        label: tx("Financial"),
                        score: financialScore,
                        finding: underwritingResults?.financial
                          ? [
                              underwritingResults.financial.financially_justified ? tx("Justified") : tx("Not justified"),
                              `${underwritingResults.financial.coverage_to_income_ratio.toFixed(1)}× ${tx("income")}`,
                              underwritingResults.financial.maximum_supported_cover != null
                                ? `${tx("max")} ${fmtCoverage(underwritingResults.financial.maximum_supported_cover)}`
                                : null,
                            ].filter(Boolean).join(" · ")
                          : null,
                      },
                      {
                        label: tx("Fraud"),
                        score: fraudPct,
                        finding: underwritingResults?.fraud
                          ? [
                              underwritingResults.fraud.severity,
                              underwritingResults.fraud.investigation_required ? tx("investigation required") : null,
                            ].filter(Boolean).join(" · ")
                          : null,
                      },
                    ].map((r) => (
                      <div key={r.label} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center gap-4">
                          <span className="w-20 flex-shrink-0 text-sm font-medium text-slate-700">{r.label}</span>
                          <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                            <div className={`h-1.5 rounded-full ${scoreColor(r.score)}`} style={{ width: `${Math.min(100, r.score)}%` }} />
                          </div>
                          <span className="w-12 flex-shrink-0 text-right text-sm font-semibold text-slate-900 tabular-nums">{r.score}%</span>
                        </div>
                        {r.finding && <p className="mt-1 pl-24 text-sm text-slate-500">{r.finding}</p>}
                      </div>
                    ))}
                  </div>
                </div>

                {aiDecision && !trace.open && (
                  <div className="border-t border-slate-100 px-5 py-4">
                    <DecisionBanner decision={aiDecision} variant="compact" />
                  </div>
                )}
              </div>

              {/* AI analysis: every factor the AI weighed, as a list or a table */}
              <div className="card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="section-label">{tx("AI analysis")}</h3>
                    {hasCategorizedReasons && (
                      <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                        <button
                          onClick={() => setAnalysisView("list")}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${analysisView === "list" ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M4 6h16M4 12h16M4 18h16"
                            />
                          </svg>
                          {tx("List")}
                        </button>
                        <button
                          onClick={() => setAnalysisView("table")}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${analysisView === "table" ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M3 10h18M3 14h18M12 4v16M4 4h16v16H4z"
                            />
                          </svg>
                          {tx("Table")}
                        </button>
                      </div>
                    )}
                </div>
                  {hasCategorizedReasons ? (
                  analysisView === "list" ? (
                    <div className="space-y-5">
                      {reasonSections.map((s) => (
                        <ReasonGroup
                          key={s.label}
                          label={s.label}
                          scoreLabel={s.scoreLabel}
                          reasons={s.reasons}
                          accentColor={s.accentColor}
                        />
                      ))}
                    </div>
                  ) : (
                    <ReasonTable sections={reasonSections} />
                  )
                ) : (
                  <ul className="space-y-1.5">
                    {(assessment?.reasons ?? []).map((reason, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-slate-300 mt-0.5 flex-shrink-0">
                          •
                        </span>
                        <span className="text-xs text-slate-600 leading-relaxed">
                          {reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

              </div>
            </>
          )}

        </div>
        <aside className="space-y-5 lg:sticky lg:top-[calc(var(--case-head,8rem)+1.25rem)] lg:self-start">
          {/* Underwriter notes */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">{tx("Underwriter Notes")}</p>
              <button
                onClick={() => generateNote(buildNoteContext())}
                disabled={generatingNote || !hasAny || userRole === "Agent"}
                title={
                  userRole === "Agent"
                    ? tx(
                        "Currently, you have no access to do this, ask your manager",
                      )
                    : hasAny
                      ? tx("Draft a note from the case details with AI")
                      : tx("Run underwriting first to generate a note")
                }
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {generatingNote ? (
                  <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" />
                ) : (
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                    />
                  </svg>
                )}
                {generatingNote ? tx("Generating…") : tx("Generate with AI")}
              </button>
            </div>
            {noteGenError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
                {noteGenError}
              </p>
            )}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={userRole === "Agent"}
              className="w-full h-24 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 resize-none placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder={
                userRole === "Agent"
                  ? tx("Notes disabled for Agent role.")
                  : tx(
                      "Add case notes, override justification, or referral comments here — or click Generate with AI for a draft…",
                    )
              }
            />
            <div className="flex items-center justify-end gap-2 mt-3">
              {noteSent && (
                <span className="text-xs text-blue-600 font-semibold mr-auto">
                  {tx("✓ Posted")}
                </span>
              )}
              <button
                onClick={submitNote}
                disabled={postingNote || !note.trim() || userRole === "Agent"}
                title={
                  userRole === "Agent"
                    ? tx(
                        "Currently, you have no access to do this, ask your manager",
                      )
                    : undefined
                }
                className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 transition-colors"
              >
                {postingNote ? tx("Posting…") : tx("Post Note")}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Requirements: what underwriting still needs ──────────────────────── */}
      <div className={caseTab === "requirements" ? "space-y-5" : "hidden"}>
          {/* Requirements & Verification — the case-driven underwriting workflow's
              requirements engine + cross-document verification findings. */}
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div>
                <h3 className="section-label">{tx("Underwriting requirements")}</h3>
                {requirements.length > 0 && (() => {
                  const met = requirements.filter((r) => r.status === "Satisfied").length;
                  const waived = requirements.filter((r) => r.status === "Waived").length;
                  const open = requirements.length - met - waived;
                  return (
                    <p className="mt-1 text-sm text-slate-500">
                      <span className="font-semibold text-slate-900">{met}</span> {tx("of")} {requirements.length} {tx("met")}
                      {open > 0 && <> · <span className="font-medium text-amber-700">{open} {tx("open")}</span></>}
                      {waived > 0 && <> · {waived} {tx("waived")}</>}
                    </p>
                  );
                })()}
              </div>
              <button
                onClick={runDetermineRequirements}
                disabled={requirementsBusy || userRole === "Agent" || onHold}
                title={onHold ? tx("The case is on hold. Remove the hold to continue.") : tx("Re-run the requirements engine for this case")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {requirementsBusy ? (
                  <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" />
                ) : null}
                {requirementsBusy
                  ? tx("Determining…")
                  : tx("Determine requirements")}
              </button>
            </div>
            {requirements.length > 0 && (
              <div className="h-1 bg-slate-100">
                <div
                  className="h-1 bg-emerald-500 transition-all"
                  style={{ width: `${(100 * requirements.filter((r) => r.status === "Satisfied" || r.status === "Waived").length) / requirements.length}%` }}
                />
              </div>
            )}
            {requirementsError && (
              <p className="mx-5 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {requirementsError}
              </p>
            )}
            {requirements.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500">
                {tx(
                  'No requirements determined yet — click "Determine Requirements" to run the Requirements Engine for this case.',
                )}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {[...requirements].sort((x, y) => REQUIREMENT_ORDER[x.status] - REQUIREMENT_ORDER[y.status]).map((req) => {
                  const statusStyle: Record<CaseRequirement["status"], string> =
                    {
                      Missing: "bg-red-50 text-red-700 border-red-200",
                      Requested: "bg-amber-50 text-amber-700 border-amber-200",
                      Submitted: "bg-blue-50 text-blue-700 border-blue-200",
                      Satisfied:
                        "bg-emerald-50 text-emerald-700 border-emerald-200",
                      Waived: "bg-slate-100 text-slate-500 border-slate-200",
                      Invalid: "bg-red-50 text-red-700 border-red-200",
                    };
                  return (
                    <li
                      key={req.id}
                      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start"
                    >
                      <RequirementIcon status={req.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">
                            {tx(requirementName(req.code))}
                          </span>
                          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                            {tx(req.category.charAt(0) + req.category.slice(1).toLowerCase())}
                          </span>
                          {!req.required && (
                            <span className="text-xs text-slate-400">{tx("Optional")}</span>
                          )}
                        </div>
                        {req.reason && (
                          <p className="mt-0.5 text-sm text-slate-500">
                            {req.reason}
                          </p>
                        )}
                        {req.satisfied_by_artifact_id &&
                          (() => {
                            const doc = artifacts.find((a) => a.id === req.satisfied_by_artifact_id);
                            return doc ? (
                              <button
                                type="button"
                                onClick={() => setPreviewDoc(doc)}
                                title={tx("Preview {0}", { 0: doc.file_name })}
                                className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true">
                                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                                  <path d="M14 3v5h5" />
                                </svg>
                                <span className="truncate">{doc.file_name}</span>
                              </button>
                            ) : (
                              <p className="mt-0.5 text-[11px] text-slate-400">
                                {tx("Linked document is no longer on file")}
                              </p>
                            );
                          })()}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${statusStyle[req.status]}`}
                        >
                          {tx(req.status)}
                        </span>
                        {REQUIREMENT_DOC_TYPES[req.code] &&
                          ["Missing", "Invalid", "Requested"].includes(req.status) &&
                          (requirementDoc(req).processing || requirementDoc(req).accepted) && (
                            <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                              <Spinner className="w-3 h-3 border-blue-200 border-t-blue-600" />
                              {requirementDoc(req).accepted ? tx("Updating…") : tx("Reading document…")}
                            </span>
                          )}
                        {REQUIREMENT_DOC_TYPES[req.code] &&
                          ["Missing", "Invalid", "Requested"].includes(req.status) &&
                          !requirementDoc(req).processing &&
                          !requirementDoc(req).accepted && (
                            <button
                              onClick={() => {
                                setUploadForRequirement(REQUIREMENT_DOC_TYPES[req.code]);
                                setShowUpload(true);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                              title={tx("Upload the {0} for this case", { 0: REQUIREMENT_DOC_TYPES[req.code] })}
                            >
                              ↑ {req.status === "Invalid" || requirementDoc(req).unreadable ? tx("Re-upload") : tx("Upload")}
                            </button>
                          )}
                        {req.status !== "Waived" &&
                          req.status !== "Satisfied" &&
                          userRole !== "Agent" && (
                            <button
                              onClick={() => waiveRequirement(req.id)}
                              disabled={onHold}
                              className="rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                              title={onHold ? tx("The case is on hold. Remove the hold to continue.") : tx("Waive this requirement")}
                            >
                              {tx("Waive")}
                            </button>
                          )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {verificationFindings.length > 0 && (
              <div className="border-t border-slate-100">
                <p className="section-label px-5 pt-4">
                  {tx("Verification findings")}
                </p>
                <ul className="divide-y divide-slate-100">
                  {verificationFindings.map((f) => {
                    const severityStyle: Record<
                      VerificationFinding["severity"],
                      string
                    > = {
                      Info: "bg-slate-100 text-slate-500 border-slate-200",
                      Low: "bg-blue-50 text-blue-700 border-blue-200",
                      Medium: "bg-amber-50 text-amber-700 border-amber-200",
                      High: "bg-red-50 text-red-700 border-red-200",
                    };
                    return (
                      <li
                        key={f.id}
                        className="flex items-start justify-between gap-3 px-5 py-4"
                      >
                        <div className="min-w-0">
                          <span className="text-sm font-semibold text-slate-900">
                            {tx(requirementName(f.field))}
                          </span>
                          <p className="text-sm text-slate-500 mt-0.5">
                            {f.explanation}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {tx("Declared:")}{" "}
                            {JSON.stringify(f.declared_value) ?? "—"}{" "}
                            {tx("·  Observed:")}{" "}
                            {JSON.stringify(f.observed_value) ?? "—"}
                          </p>
                        </div>
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border flex-shrink-0 ${severityStyle[f.severity]}`}
                        >
                          {f.severity}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
      </div>

      {/* ── Documents: the AI read of the paperwork, and the checklist / uploads ───── */}
      <AccordionsOpenByDefault.Provider value={true}>
      <div className={caseTab === "documents" ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-3" : "hidden"}>
        <div className="space-y-5 lg:col-span-2">
          {/* Every file on the case: preview, re-type or remove */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
              <h3 className="section-label">
                {tx("Files")}
                {artifacts.length > 0 && <span className="ml-2 text-sm font-normal text-slate-400">{artifacts.length}</span>}
              </h3>
              <button
                disabled={userRole === "Agent"}
                onClick={() => {
                  if (userRole === "Agent") return;
                  setShowUpload(true);
                }}
                title={userRole === "Agent" ? tx("Currently, you have no access to do this, ask your manager") : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {tx("Upload")}
              </button>
            </div>
            <div className="p-5">
              {artifacts.length > 0 ? (
                  <CaseDocumentList
                    documents={artifacts}
                    requiredTypes={docs.required}
                    canEdit={userRole !== "Agent"}
                    onChanged={(message) => {
                      notify(message, true);
                      // The checklist and requirements follow the documents' types.
                      fetchArtifacts();
                      fetchDetail();
                      fetchRequirements();
                      fetchVerificationFindings();
                    }}
                    onError={(message) => notify(message, false)}
                  />
              ) : (
                <p className="py-6 text-center text-sm text-slate-500">{tx("No files uploaded yet.")}</p>
              )}
            </div>
          </div>

          {/* Document summary — categorized medical/financial/occupational read
              of the uploaded paperwork, generated before underwriting runs. */}
          <div className="card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="section-label">{tx("Document Summary (AI)")}</p>
              <button
                onClick={summarizeDocuments}
                disabled={
                  summarizing ||
                  artifacts.filter((a) => a.ocr_result).length === 0 ||
                  userRole === "Agent"
                }
                title={
                  userRole === "Agent"
                    ? tx(
                        "Currently, you have no access to do this, ask your manager",
                      )
                    : undefined
                }
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {summarizing ? (
                  <Spinner className="w-3 h-3 border-blue-300 border-t-blue-600" />
                ) : null}
                {summarizing
                  ? tx("Summarizing…")
                  : docSummary
                    ? tx("Re-summarize")
                    : tx("Summarize Documents")}
              </button>
            </div>
            {artifacts.filter((a) => a.ocr_result).length === 0 &&
              !docSummary && (
                <p className="text-xs text-slate-400">
                  {tx(
                    "Upload and OCR document(s) to generate a medical / financial / occupational summary.",
                  )}
                </p>
              )}
            {artifacts.some((a) => a.ocr_result) && !docSummary && !summarizing && (
              <p className="text-sm text-slate-500">
                {tx("No summary yet. Summarize Documents reads the uploaded paperwork and groups what it finds into medical, financial and occupational notes.")}
              </p>
            )}
            {summarizeError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {summarizeError}
              </p>
            )}
            {docSummary && (
              <LazyMarkdown components={MD_COMPONENTS}>
                {docSummary}
              </LazyMarkdown>
            )}
          </div>
        </div>
        <aside className="lg:sticky lg:top-[calc(var(--case-head,8rem)+1.25rem)]">
          {/* Required documents for this plan, ticked off as they arrive */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
              <h3 className="section-label">{tx("Required documents")}</h3>
              {docs.required.length > 0 && (
                <span className="text-sm text-slate-500">
                  <span className="font-semibold text-slate-900">{docs.required.filter((d) => docs.received.includes(d)).length}</span>{" "}
                  {tx("of")} {docs.required.length} {tx("received")}
                </span>
              )}
            </div>
            {docs.required.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">{tx("No documents required for this plan type.")}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {docs.required.map((d) => {
                  const got = docs.received.includes(d);
                  return (
                    <li key={d} className="flex items-center gap-3 px-5 py-3">
                      <span
                        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${got ? "bg-emerald-500 text-white" : "border-2 border-amber-400"}`}
                        aria-hidden="true"
                      >
                        {got && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                            <path d="M5 12l5 5L20 7" />
                          </svg>
                        )}
                      </span>
                      <span className={`flex-1 text-sm ${got ? "text-slate-700" : "font-medium text-slate-900"}`}>{d}</span>
                      <span className={`text-xs font-semibold ${got ? "text-emerald-700" : "text-amber-700"}`}>
                        {got ? tx("Received") : tx("Missing")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>

      </AccordionsOpenByDefault.Provider>

      {/* ── Applicant: everything we know about the person ─────────────────── */}
      <AccordionsOpenByDefault.Provider value={true}>
      <SectionsAsPanels.Provider value={true}>
      <div className={caseTab === "applicant" ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-3" : "hidden"}>
        <div className="lg:col-span-2">
          {customer && (
            <div className="space-y-5">
              {/* Name, gender and CNIC are in the page header; only the family context is repeated here. */}
              {!detail?.is_principal_participant &&
                detail?.principal_participant_name && (
                  <div className="mb-4 bg-blue-50 border border-blue-100 rounded-lg p-3">
                    <p className="text-xs font-semibold text-blue-800">
                      {tx("Dependent Member")}
                    </p>
                    <p className="text-xs text-blue-600 mt-0.5 leading-snug">
                      <span className="font-bold">{customer.name}</span> (
                      {detail.family_relationship || tx("Dependent")}
                      {tx(") belongs to")}{" "}
                      <span className="font-bold">
                        {detail.principal_participant_name}
                      </span>
                      {tx("'s family policy.")}
                    </p>
                  </div>
                )}
              {detail?.family_members && detail.family_members.length > 1 && (
                <div className="mb-4 bg-indigo-50 border border-indigo-200 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-indigo-700">
                    {tx("Family:")}{" "}
                    <span className="font-bold">
                      {detail.principal_participant_name || customer.name}
                      {tx("'s Family")}
                    </span>
                  </p>
                  <label className="block text-[11px] font-semibold text-indigo-500">
                    {tx("Switch to another family member")}
                  </label>
                  <select
                    value={detail.case.caseld ?? ""}
                    onChange={(e) => {
                      const target = e.target.value;
                      if (target && target !== detail.case.caseld)
                        router.push(`/case/${target}`);
                    }}
                    className="w-full bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs"
                  >
                    {detail.family_members.map((m: any) => (
                      <option key={m.case_id} value={m.case_id}>
                        {m.name} — {m.case_number} ({m.case_status})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {detail?.family_head_case && (
                <div className="mb-4 bg-blue-50 border border-blue-100 rounded-lg p-3">
                  <p className="text-xs font-semibold text-blue-800">
                    {tx("The policy is issued to the head")}
                  </p>
                  <p className="text-[11px] text-blue-700 mt-0.5 leading-snug">
                    {tx(
                      "This is an insured spouse's case. Pre-issuance, issuance and payment run on the head's case —",
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        router.push(`/case/${detail.family_head_case!.case_id}`)
                      }
                      className="ml-1 font-bold underline"
                    >
                      {detail.family_head_case.name} ·{" "}
                      {detail.family_head_case.case_number}
                    </button>
                    .
                  </p>
                </div>
              )}
              {(detail?.family_underwriting_pending?.length ?? 0) > 0 && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-800">
                    {tx("The family policy is waiting on another insured life")}
                  </p>
                  <p className="text-[11px] text-amber-700 leading-snug">
                    {tx(
                      "A fully insured spouse is underwritten in their own case. The policy can only be approved and issued once every insured member's case is approved.",
                    )}
                  </p>
                  {(detail.family_underwriting_pending ?? []).map((m) => (
                    <button
                      key={m.case_id}
                      type="button"
                      onClick={() => router.push(`/case/${m.case_id}`)}
                      className="block w-full text-left text-xs font-semibold text-amber-900 hover:underline"
                    >
                      {m.name}
                      {m.relationship ? ` (${m.relationship})` : ""} —{" "}
                      {m.case_number} · {m.case_status} →
                    </button>
                  ))}
                </div>
              )}
              {detail?.organization_name && (
                <div className="mb-4 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-slate-700">
                    {tx("Company:")}{" "}
                    <span className="font-bold">
                      {detail.organization_name}
                    </span>
                  </p>
                  {detail.organization_members &&
                  detail.organization_members.length > 1 ? (
                    <>
                      <label className="block text-[11px] font-semibold text-slate-500">
                        {tx("Switch to another member of this company")}
                      </label>
                      <select
                        value={detail.case.caseld ?? ""}
                        onChange={(e) => {
                          const target = e.target.value;
                          if (target && target !== detail.case.caseld)
                            router.push(`/case/${target}`);
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
                    <p className="text-xs text-slate-500">
                      {tx(
                        "No other company members are currently in underwriting.",
                      )}
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
              <Accordion title={tx("Customer Details")}>
                {detail?.principal_participant_name && (
                  <DataRow label={tx("Member Name")} value={customer.name} />
                )}
                {detail?.is_principal_participant && (
                  <DataRow
                    label={tx("Family Role")}
                    value="Principal Participant"
                  />
                )}
                <DataRow
                  label={tx("Date of Birth")}
                  value={fmtDob(customer.dob)}
                />
                <DataRow label={tx("Gender")} value={customer.gender} />
                <DataRow
                  label={tx("Marital Status")}
                  value={
                    customer.marital_status || (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
                <DataRow
                  label={tx("Occupation")}
                  value={
                    customer.occupation || (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
                <DataRow
                  label={tx("Declared Annual Income")}
                  value={
                    customer.declared_income ? (
                      fmtIncome(customer.declared_income)
                    ) : (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
              </Accordion>

              <Accordion title={tx("Contact Information")}>
                <DataRow
                  label={tx("Address")}
                  value={(() => {
                    const addr = customer.details?.address;
                    if (!addr)
                      return (
                        <span className="text-slate-400 italic">{tx("Missing")}</span>
                      );
                    if (typeof addr === "string") return addr;
                    const str = [
                      addr.street_address,
                      addr.area,
                      addr.city,
                      addr.province,
                    ]
                      .filter(Boolean)
                      .join(", ");
                    return (
                      str || (
                        <span className="text-slate-400 italic">{tx("Missing")}</span>
                      )
                    );
                  })()}
                />
                <DataRow
                  label={tx("City")}
                  value={
                    customer.details?.address?.city ||
                    customer.details?.city || (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
                <DataRow
                  label={tx("Phone")}
                  value={
                    customer.details?.phone || (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
                <DataRow
                  label={tx("Email")}
                  value={
                    customer.details?.email || (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
              </Accordion>

              <Accordion title={tx("Medical & Lifestyle")}>
                <DataRow
                  label={tx("Smoker")}
                  value={customer.is_smoker ? "Yes" : "No"}
                />
                <DataRow
                  label={tx("Height")}
                  value={
                    customer.height_cm ? (
                      `${customer.height_cm} cm`
                    ) : (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
                <DataRow
                  label={tx("Weight")}
                  value={
                    customer.weight_kg ? (
                      `${customer.weight_kg} kg`
                    ) : (
                      <span className="text-slate-400 italic">{tx("Missing")}</span>
                    )
                  }
                />
              </Accordion>

              <Accordion title={tx("Lead Generated By")}>
                {customer.acquisition_source ? (
                  <>
                    <DataRow
                      label={tx("Source")}
                      value={customer.acquisition_source.name}
                    />
                    <DataRow
                      label={tx("Channel")}
                      value={
                        <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                          {tx(SOURCE_TYPE_LABELS[
                            customer.acquisition_source.source_type
                          ] ?? customer.acquisition_source.source_type)}
                        </span>
                      }
                    />
                    {customer.acquisition_source.partner_name && (
                      <DataRow
                        label={tx("Partner")}
                        value={customer.acquisition_source.partner_name}
                      />
                    )}
                    <DataRow
                      label={tx("Producer Code")}
                      value={
                        <span className="font-mono text-xs">
                          {customer.acquisition_source.code}
                        </span>
                      }
                    />
                  </>
                ) : (
                  <p className="text-xs text-slate-400 italic">
                    {tx("Not recorded")}
                  </p>
                )}
              </Accordion>
              </div>
            </div>
          )}
        </div>
        <div>
          {policy && (
            <div className="space-y-5">
              <Accordion title={tx("Policy Details")} defaultOpen={true}>
                <DataRow
                  label={tx("Product")}
                  value={
                    INSURANCE_TYPE_LABELS[policy.insurance_type] ??
                    policy.product_name
                  }
                />
                <DataRow
                  label={tx("Plan")}
                  value={
                    <span className="flex items-center justify-between gap-3">
                      <span>{policy.product_name}</span>
                      {canWaiveAcr && !["Approved", "Rejected", "Closed"].includes(c.caseStatus) && (
                        <button
                          type="button"
                          disabled={onHold}
                          title={onHold ? tx("The case is on hold. Remove the hold to continue.") : undefined}
                          onClick={() => setShowChangePlan(true)}
                          className="shrink-0 rounded-md border border-blue-600 px-2.5 py-1 text-xs font-semibold text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {tx("Change plan")}
                        </button>
                      )}
                    </span>
                  }
                />
                <DataRow
                  label={tx("Coverage Amount")}
                  value={fmtCoverage(policy.coverage_amount)}
                />
                <DataRow
                  label={tx("Policy Term")}
                  value={`${policy.term_years} years`}
                />
                {customer && (
                  <DataRow
                    label={tx("Coverage-to-Income Ratio")}
                    value={`${(policy.coverage_amount / customer.declared_income).toFixed(1)}×`}
                  />
                )}
                <DataRow label={tx("Policy Status")} value={policy.status} />
              </Accordion>

              <Accordion title={tx("Application")}>
                <DataRow label={tx("Application Number")} value={c.caseNumber} />
                <DataRow label={tx("Type")} value={c.caseType} />
                <DataRow label={tx("Priority")} value={c.priorityLevel} />
                <DataRow label={tx("Channel")} value={c.sourceChannel} />
              </Accordion>
            </div>
          )}
        </div>
      </div>
      </SectionsAsPanels.Provider>
      </AccordionsOpenByDefault.Provider>

          <ModalPortal>
            {showResultModal && medical && (medical.reports ?? []).length > 0 && (
              <MedicalReportsModal
                order={medical}
                busy={medBusy}
                onClose={() => setShowResultModal(false)}
                onConfirm={handleConfirmReports}
              />
            )}

            {showResultModal && medical && (medical.reports ?? []).length === 0 && (
              <MedicalResultModal
                order={medical}
                caseId={caseId}
                busy={medBusy}
                onClose={() => setShowResultModal(false)}
                onSubmit={handleRecordResults}
              />
            )}

            {showLabLinkModal && medical && (
              <MedicalLabLinkModal
                order={medical}
                customerName={customer?.name}
                link={labLink ? portalUrl(labLink.link_path) : null}
                labLink={labLink}
                busy={medBusy}
                error={medErr}
                onGenerate={handleLabLink}
                onEnterManually={() => { setShowLabLinkModal(false); setShowResultModal(true); }}
                onClose={() => setShowLabLinkModal(false)}
              />
            )}

            {showAssessModal && medical && (
              <MedicalAssessModal
                order={medical}
                link={medLink}
                delivery={medDelivery}
                customerName={customer?.name}
                busy={medBusy}
                onClose={() => setShowAssessModal(false)}
                onMarkCompleted={async () => {
                  await handleRecordResults({
                    standard_panel: "normal",
                    fasting_blood_sugar: "normal",
                    urinalysis: "normal",
                  });
                  setShowAssessModal(false);
                }}
              />
            )}

            {waiveModal === "waive" && (
              <WaiveAcrModal
                applicantName={customer?.name}
                busy={acrWaiving}
                error={waiveError}
                onCancel={() => setWaiveModal(null)}
                onConfirm={confirmWaiveAcr}
              />
            )}

            {waiveModal === "undo" && (
              <UndoWaiverModal
                busy={acrWaiving}
                error={waiveError}
                onCancel={() => setWaiveModal(null)}
                onConfirm={confirmReinstateAcr}
              />
            )}

            {showChangePlan && policy && (
              <ChangePlanModal
                tenantId={tenantId}
                caseId={caseId}
                policy={policy}
                customer={customer ?? null}
                onClose={() => setShowChangePlan(false)}
                onDone={(message) => {
                  setShowChangePlan(false);
                  setSuccessMessage(message);
                  window.setTimeout(() => setSuccessMessage(null), 5000);
                  fetchDetail();
                  fetchRequirements();
                  fetchArtifacts();
                  fetchHistory();
                  fetchMedical();
                }}
              />
            )}

            {showACRModal && (
              <ACRModal
                caseId={caseId}
                initial={acr}
                onClose={() => setShowACRModal(false)}
                onDone={() => {
                  setShowACRModal(false);
                  fetchAcr();
                }}
              />
            )}

          </ModalPortal>

      {showUpload && (
        <UploadModal
          tenantId={tenantId}
          caseId={caseId}
          docTypes={uploadForRequirement ? [uploadForRequirement] : docs.required}
          missingTypes={uploadForRequirement ? [uploadForRequirement] : docs.missing}
          onClose={() => {
            setShowUpload(false);
            setUploadForRequirement(null);
          }}
          onUploaded={() => {
            setShowUpload(false);
            setUploadForRequirement(null);
            fetchArtifacts();
            fetchDetail();
            // OCR runs asynchronously; a short delay gives the worker a
            // chance to finish before re-checking requirement status. A
            // requirement upload is then tracked on its row until OCR accepts
            // it (see the requirement-document effect).
            setTimeout(() => {
              fetchRequirements();
              fetchVerificationFindings();
            }, 4000);
            notifyParentPortal("document_uploaded", { caseId });
          }}
        />
      )}

      {previewDoc && (
        <ModalPortal>
          <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />
        </ModalPortal>
      )}

      {showDocuments && (
        <ModalPortal>
          <ApplicationFolderModal
            caseNumber={c.caseNumber}
            customerName={customer?.name}
            artifacts={artifacts}
            portalHref={appHref(`/cases?case_id=${caseId}`)}
            onClose={() => setShowDocuments(false)}
          />
        </ModalPortal>
      )}

      {holdModal && (
        <ModalPortal>
          <HoldCaseDialog
            busy={holdBusy}
            error={holdError}
            onConfirm={putOnHold}
            onClose={() => setHoldModal(false)}
          />
        </ModalPortal>
      )}

      {/* ── AI Assessment Report Modal ────────────────────────────────────── */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 lg:p-8 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-auto">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-4">
                <img src="/rizvi.png" alt={tx("Rizviz")} className="h-8" />
                <div className="h-6 w-px bg-slate-300"></div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900 tracking-tight">
                    {tx("AI Underwriting Assessment")}
                  </h2>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">
                    {tx("Applicant:")} {customer?.name} {tx("·  Application:")}{" "}
                    {c.caseNumber}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowReportModal(false)}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-full transition-colors focus:outline-none"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="p-6 md:p-8 space-y-8 bg-white overflow-y-auto max-h-[75vh]">
              {/* Hero Decision Section */}
              <div className="flex flex-col items-center justify-center text-center space-y-3 pb-8 border-b border-slate-100">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                  {tx("Final AI Decision")}
                </h3>
                {aiDecision ? (
                  <div className="scale-125 transform-origin-center my-1">
                    <StatusBadge decision={aiDecision} size="lg" />
                  </div>
                ) : (
                  <span className="text-xl font-bold text-slate-400 my-1">
                    {tx("Pending")}
                  </span>
                )}
                {suggestedLoading !== null && (
                  <p className="text-sm font-semibold text-amber-800 bg-amber-50 px-4 py-1.5 rounded-full border border-amber-200/50 mt-2 shadow-sm">
                    {tx("Suggested Loading: +")}
                    {suggestedLoading}%
                  </p>
                )}

                <div className="w-full max-w-lg mt-8">
                  <div className="flex justify-between items-end mb-2">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      {tx("Composite Risk")}
                    </span>
                    <span className="text-3xl font-black text-slate-900 tracking-tighter">
                      {compositeScore}%
                    </span>
                  </div>
                  <div className="h-3.5 w-full bg-slate-100 rounded-full overflow-hidden shadow-inner">
                    <div
                      className={`h-full rounded-full transition-all duration-1000 ${
                        compositeScore <= 30
                          ? "bg-blue-500"
                          : compositeScore <= 70
                            ? "bg-amber-500"
                            : "bg-red-500"
                      }`}
                      style={{ width: `${compositeScore}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {reasonSections.map((section, idx) => (
                  <div
                    key={idx}
                    className="bg-slate-50/80 rounded-2xl border border-slate-200/60 p-6 flex flex-col text-left shadow-sm"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <span className="text-[11px] font-extrabold text-slate-500 uppercase tracking-widest">
                        {tx(section.label)}
                      </span>
                      <span
                        className={`text-2xl font-black ${section.accentColor}`}
                      >
                        {section.scoreLabel}
                      </span>
                    </div>

                    <ul className="w-full space-y-2.5">
                      {section.reasons.length > 0 ? (
                        section.reasons.map((r, rIdx) => {
                          const isObj = typeof r === "object" && r !== null;
                          const text = isObj
                            ? `${r.parameter || r.factor}: ${r.observation || r.reason}`
                            : (r as string);
                          return (
                            <li
                              key={rIdx}
                              className="text-[13px] text-slate-700 flex items-start gap-2.5 leading-relaxed"
                            >
                              <span
                                className={`mt-[3px] font-bold ${section.accentColor}`}
                              >
                                •
                              </span>{" "}
                              {text.replace(/\*\*/g, "")}
                            </li>
                          );
                        })
                      ) : (
                        <li className="text-[13px] text-slate-400 italic py-2">
                          {tx("No significant risk factors flagged.")}
                        </li>
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 bg-slate-50 border-t border-slate-200/80">
              <span className="text-xs text-slate-500 font-medium">
                {tx("Generated")}{" "}
                {displayDate(new Date(), {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={downloadPDF}
                  className="px-5 py-2.5 text-[13px] font-bold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 shadow-sm transition-all flex items-center gap-2 focus:ring-2 focus:ring-slate-200"
                >
                  <svg
                    className="w-4 h-4 text-slate-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.5"
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    ></path>
                  </svg>
                  {tx("Save PDF")}
                </button>
                <button
                  onClick={() => setShowReportModal(false)}
                  className="px-6 py-2.5 text-[13px] font-bold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 shadow-sm shadow-blue-600/20 transition-all focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                >
                  {tx("Done")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Medical assessment result — shown right after "Assess Medical" runs the
// non-medical-limit grid. Mirrors the pre-underwriting queue's own modal
// (app/underwriting/page.tsx) so the two entry points behave identically.
// ─────────────────────────────────────────────────────────────────────────────


// ── Final underwriting: the specialists' reviews it compiles ─────────────────

type CompiledReview = {
  status: "PENDING" | "IN_REVIEW" | "CLEARED" | "REFERRED" | "DECLINED";
  submitted: boolean;
  reviewer: string | null;
  note: string | null;
  updated_at: string | null;
  ai: Record<string, any> | null;
};
type CompiledReviews = { medical: CompiledReview; financial: CompiledReview };

/** One line of the "Before you can run it" checklist. */
type PrereqStep = {
  id: string; title: string; done: boolean; statusLabel: string; description: string;
  actionLabel?: string; actionHref?: string; onAction?: () => void; busy?: boolean;
  secondaryActionLabel?: string; onSecondaryAction?: () => void; secondaryBusy?: boolean;
};

const REVIEW_STATUS_LABEL: Record<string, string> = {
  PENDING: "Not started", IN_REVIEW: "In review", CLEARED: "Cleared", REFERRED: "Referred", DECLINED: "Declined",
};
const REVIEW_STATUS_TONE: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-600", IN_REVIEW: "bg-blue-50 text-blue-700", CLEARED: "bg-emerald-50 text-emerald-700",
  REFERRED: "bg-amber-50 text-amber-800", DECLINED: "bg-rose-50 text-rose-700",
};

function SpecialistReviewsSummary({ tracks }: { tracks: CompiledReviews | null }) {
  if (!tracks) return null;
  const card = (track: "medical" | "financial") => {
    const r = tracks[track];
    const ai = r.ai;
    const facts: [string, string][] = track === "medical"
      ? ai ? [["Examination", ai.exam_status ?? "—"], ["Clinical outcome", ai.outcome ?? "Not rated"], ["Loading", ai.suggested_loading_pct != null ? `+${ai.suggested_loading_pct}%` : "None"]] : []
      : ai ? [["Financial risk", ai.score != null ? `${ai.score} / 100` : "—"], ["Cover justified", ai.financially_justified ? "Yes" : "No"], ["Referral", ai.referral_required ? "Suggested" : "Not needed"]] : [];
    return <div key={track} className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{tx(track === "medical" ? "Medical underwriting" : "Financial underwriting")}</p>
          <p className="truncate text-xs text-slate-500">{r.reviewer ?? tx("Not assigned")}{r.updated_at && r.submitted ? ` · ${new Date(r.updated_at).toLocaleDateString()}` : ""}</p></div>
        <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${REVIEW_STATUS_TONE[r.status] ?? REVIEW_STATUS_TONE.PENDING}`}>{tx(REVIEW_STATUS_LABEL[r.status] ?? r.status)}</span>
      </div>
      {facts.length > 0 ? <dl className="mt-3 grid grid-cols-3 gap-2">{facts.map(([k, v]) => <div key={k} className="rounded-lg bg-slate-50 px-2.5 py-2"><dt className="text-[11px] text-slate-500">{tx(k)}</dt><dd className="mt-0.5 truncate text-xs font-semibold text-slate-900">{tx(v)}</dd></div>)}</dl>
        : <p className="mt-3 text-xs text-slate-400">{tx(track === "medical" ? "No AI medical underwriting recorded yet." : "No AI financial underwriting run yet.")}</p>}
      {r.note && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700"><span className="font-semibold">{tx("Rationale")}: </span>{r.note}</p>}
    </div>;
  };
  return <div className="mt-4 border-t border-slate-100 pt-4">
    <div className="mb-3 flex items-center justify-between"><p className="text-sm font-semibold text-slate-900">{tx("Specialist reviews")}</p><p className="text-xs text-slate-500">{tx("Compiled into the final decision; a decline or referral is never overridden.")}</p></div>
    <div className="grid gap-3 md:grid-cols-2">{card("medical")}{card("financial")}</div>
  </div>;
}
