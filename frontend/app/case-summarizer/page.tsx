"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import api from "@/app/services/api";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { StatusBadge } from "@/components/StatusBadge";
import type { AIDecision } from "@/lib/mock-data";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Applicant {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
}

interface CaseItem {
  caseld: string;
  caseNumber: string;
  status: string;
}

interface Artifact {
  id: string;
  file_name: string | null;
  document_type: string;
  status: string;
  ocr_result: string | null;
}

interface TokenUsage { input: number; output: number; total: number }

type SumStatus  = "idle" | "streaming" | "done" | "error";
type EvalStatus = "idle" | "streaming" | "done" | "error";

interface EvalState {
  completedNodes:   string[];
  medicalScore:     number | null;
  medicalReasons:   string[];
  financialScore:   number | null;
  financialReasons: string[];
  fraudProbability: number | null;
  fraudReasons:     string[];
  compositeScore:   number | null;
  aiDecision:       string | null;
  reasons:          string[];
  validationErrors: string[];
}

const INITIAL_EVAL: EvalState = {
  completedNodes: [], medicalScore: null, medicalReasons: [],
  financialScore: null, financialReasons: [], fraudProbability: null,
  fraudReasons: [], compositeScore: null, aiDecision: null,
  reasons: [], validationErrors: [],
};

const PIPELINE_NODES = [
  { key: "validate_input",       label: "Input\nValidation",     dotColor: "bg-slate-500"   },
  { key: "medical_scoring",      label: "Medical\nScoring",      dotColor: "bg-blue-500"    },
  { key: "financial_scoring",    label: "Financial\nScoring",    dotColor: "bg-violet-500"  },
  { key: "fraud_detection",      label: "Fraud\nDetection",      dotColor: "bg-red-500"     },
  { key: "decision_aggregation", label: "Decision\nAggregation", dotColor: "bg-emerald-500" },
] as const;

const VALID_DECISIONS = new Set(["Auto Approve", "Approve with Loading", "Human Review", "Decline"]);
function asDecision(v: string | null): AIDecision | null {
  return v && VALID_DECISIONS.has(v) ? (v as AIDecision) : null;
}

// ── Markdown renderer ──────────────────────────────────────────────────────────

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h2: ({ children }) => (
    <h2 className="text-sm font-bold text-slate-800 mt-6 mb-2 pb-1 border-b border-slate-100 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-slate-700 mt-4 mb-1.5 uppercase tracking-wide">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-sm text-slate-600 leading-relaxed mb-3">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 space-y-1 pl-4">{children}</ul>
  ),
  li: ({ children }) => (
    <li className="text-sm text-slate-600 leading-relaxed list-disc">{children}</li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-slate-800">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="text-xs bg-slate-100 rounded px-1 py-0.5 font-mono text-slate-700">{children}</code>
  ),
  hr: () => <hr className="border-slate-200 my-4" />,
};

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CaseSummarizerPage() {
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  // Selection
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [selectedApplicant, setSelectedApplicant] = useState<Applicant | null>(null);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [selectedCase, setSelectedCase] = useState<CaseItem | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [checkedDocs, setCheckedDocs] = useState<Set<string>>(new Set());
  const [loadingCases, setLoadingCases] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  // Summary
  const [sumStatus, setSumStatus] = useState<SumStatus>("idle");
  const [summary, setSummary] = useState("");
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [sumError, setSumError] = useState<string | null>(null);
  const sumAbortRef = useRef<AbortController | null>(null);

  // Eval form (pre-filled from applicant, editable)
  const [showEvalForm, setShowEvalForm] = useState(false);
  const [evalForm, setEvalForm] = useState({
    cnic: "", name: "", dob: "", gender: "Male", occupation: "",
    declaredIncome: "", productName: "Term Life Insurance", coverageAmount: "", termYears: "",
  });

  // Risk evaluation
  const [evalStatus, setEvalStatus] = useState<EvalStatus>("idle");
  const [evalResult, setEvalResult] = useState<EvalState>(INITIAL_EVAL);
  const [evalError, setEvalError] = useState<string | null>(null);
  const evalAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    sumAbortRef.current?.abort();
    evalAbortRef.current?.abort();
  }, []);

  // Load applicants on mount
  useEffect(() => {
    if (!tenantId) return;
    api.get(`/tenants/${tenantId}/applicants`).then(r => setApplicants(r.data)).catch(() => {});
  }, [tenantId]);

  // Load cases when applicant selected
  useEffect(() => {
    if (!selectedApplicant || !tenantId) { setCases([]); setSelectedCase(null); return; }
    setLoadingCases(true);
    api.get(`/tenants/${tenantId}/cases`, { params: { applicant_id: selectedApplicant.id } })
      .then(r => setCases(r.data))
      .catch(() => {})
      .finally(() => setLoadingCases(false));
  }, [selectedApplicant, tenantId]);

  // Load artifacts when case selected
  useEffect(() => {
    if (!selectedCase || !tenantId) { setArtifacts([]); setCheckedDocs(new Set()); return; }
    setLoadingArtifacts(true);
    api.get(`/tenants/${tenantId}/cases/${selectedCase.caseld}/artifacts`)
      .then(r => {
        const docs: Artifact[] = r.data;
        setArtifacts(docs);
        setCheckedDocs(new Set(docs.filter(d => d.ocr_result && d.status !== "Processing").map(d => d.id)));
      })
      .catch(() => {})
      .finally(() => setLoadingArtifacts(false));
  }, [selectedCase, tenantId]);

  // Pre-fill eval form from selected applicant
  useEffect(() => {
    if (!selectedApplicant) return;
    setEvalForm(f => ({
      ...f,
      cnic: selectedApplicant.cnic,
      name: selectedApplicant.name,
      dob: selectedApplicant.dob,
      gender: selectedApplicant.gender,
      occupation: selectedApplicant.occupation,
      declaredIncome: String(selectedApplicant.declared_income),
    }));
  }, [selectedApplicant]);

  const selectedDocs = artifacts.filter(a => checkedDocs.has(a.id) && a.ocr_result);

  // ── Summarize ─────────────────────────────────────────────────────────────────

  const handleSummarize = async () => {
    if (selectedDocs.length === 0) return;
    sumAbortRef.current?.abort();
    const abort = new AbortController();
    sumAbortRef.current = abort;

    setSumStatus("streaming");
    setSummary("");
    setTokenUsage(null);
    setSumError(null);
    setEvalStatus("idle");
    setEvalResult(INITIAL_EVAL);

    try {
      const res = await fetch(`${API_BASE}/summarize/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("jwt_token") ?? ""}`,
        },
        body: JSON.stringify({ documents: selectedDocs.map(d => d.ocr_result!) }),
        signal: abort.signal,
      });

      if (!res.ok) throw new Error(`Summarizer returned ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.type === "chunk") {
            setSummary(prev => prev + (evt.text as string));
          } else if (evt.type === "done") {
            setTokenUsage(evt.token_usage as TokenUsage);
            setSumStatus("done");
          } else if (evt.type === "error") {
            setSumError((evt.message as string) ?? "Unknown error");
            setSumStatus("error");
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setSumError(err instanceof Error ? err.message : "Connection failed");
      setSumStatus("error");
    }
  };

  // ── Risk Evaluation ───────────────────────────────────────────────────────────

  const runEval = async () => {
    evalAbortRef.current?.abort();
    const abort = new AbortController();
    evalAbortRef.current = abort;

    setEvalStatus("streaming");
    setEvalResult(INITIAL_EVAL);
    setEvalError(null);

    const payload = {
      applicant: {
        cnic: evalForm.cnic, name: evalForm.name, dob: evalForm.dob,
        gender: evalForm.gender, occupation: evalForm.occupation,
        declared_income: parseFloat(evalForm.declaredIncome) || 0,
      },
      policy: {
        product_name: evalForm.productName,
        coverage_amount: parseFloat(evalForm.coverageAmount) || 0,
        term_years: parseInt(evalForm.termYears) || 0,
      },
      ...(selectedCase?.caseld ? { case_id: selectedCase.caseld } : {}),
      ...(summary ? { ai_summary: summary } : {}),
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
        throw new Error(
          Array.isArray(body.detail)
            ? body.detail.map((d: { msg?: string }) => d.msg ?? d).join(", ")
            : body.detail ?? `Error ${res.status}`,
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
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          const type = evt.type as string;
          if (type === "progress") {
            const node = evt.node as string;
            const data = evt.data as Record<string, unknown>;
            setEvalResult(prev => {
              const next: EvalState = {
                ...prev,
                completedNodes: prev.completedNodes.includes(node)
                  ? prev.completedNodes : [...prev.completedNodes, node],
              };
              if (node === "medical_scoring") {
                next.medicalScore   = data.medical_score   as number;
                next.medicalReasons = (data.medical_reasons as string[]) ?? [];
              } else if (node === "financial_scoring") {
                next.financialScore   = data.financial_score   as number;
                next.financialReasons = (data.financial_reasons as string[]) ?? [];
              } else if (node === "fraud_detection") {
                next.fraudProbability = data.fraud_probability as number;
                next.fraudReasons     = (data.fraud_reasons as string[]) ?? [];
              } else if (node === "decision_aggregation") {
                next.compositeScore = data.composite_risk_score as number;
                next.aiDecision     = data.ai_decision as string;
                next.reasons        = (data.reasons as string[]) ?? [];
              }
              return next;
            });
            if (node === "decision_aggregation") setEvalStatus("done");
          } else if (type === "invalid") {
            setEvalResult(prev => ({ ...prev, validationErrors: (evt.errors as string[]) ?? [] }));
            setEvalStatus("error");
            setEvalError("Validation failed — see errors below.");
            break outer;
          } else if (type === "error") {
            setEvalStatus("error");
            setEvalError((evt.message as string) ?? "Unexpected error.");
            break outer;
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setEvalStatus("error");
      setEvalError(err instanceof Error ? err.message : "Connection failed.");
    }
  };

  const decision    = asDecision(evalResult.aiDecision);
  const sumRunning  = sumStatus  === "streaming";
  const evalRunning = evalStatus === "streaming";

  // ── PDF report ────────────────────────────────────────────────────────────────

  const downloadReport = async () => {
    const { default: jsPDF } = await import("jspdf");

    const doc   = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
    const pageW = 210;
    const pageH = 297;
    const mg    = 16;
    const cw    = pageW - mg * 2;
    let   y     = 0;

    const nextPage = (needed: number) => {
      if (y + needed > pageH - 18) { doc.addPage(); y = 18; }
    };

    const section = (label: string) => {
      nextPage(14);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(label, mg, y);
      y += 5;
    };

    const scoreBar = (label: string, score: number, display: string, r: number, g: number, b: number) => {
      nextPage(14);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(51, 65, 85);
      doc.text(label, mg, y);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(15, 23, 42);
      doc.text(display, pageW - mg, y, { align: "right" });
      y += 4;
      doc.setFillColor(241, 245, 249);
      doc.rect(mg, y, cw, 3.5, "F");
      doc.setFillColor(r, g, b);
      doc.rect(mg, y, (Math.min(score, 100) / 100) * cw, 3.5, "F");
      y += 9;
    };

    // ── Dark header ──────────────────────────────────────────────────────────
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, pageW, 28, "F");
    doc.setFillColor(59, 130, 246);
    doc.rect(0, 28, pageW, 1.5, "F");

    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("insurance-ai", mg, 12);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text("Underwriting Platform · Case Risk Assessment Report", mg, 20);
    doc.setTextColor(148, 163, 184);
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageW - mg, 20, { align: "right" });

    y = 38;

    // ── Applicant & Policy ───────────────────────────────────────────────────
    section("APPLICANT DETAILS");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text(evalForm.name || "—", mg, y);
    if (selectedCase) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`Case: ${selectedCase.caseNumber}`, pageW - mg, y, { align: "right" });
    }
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    const apFields = [
      `CNIC: ${evalForm.cnic || "—"}`,
      `DOB: ${evalForm.dob || "—"}`,
      `Gender: ${evalForm.gender}`,
      `Occupation: ${evalForm.occupation || "—"}`,
      `Annual Income: PKR ${Number(evalForm.declaredIncome || 0).toLocaleString()}`,
    ];
    doc.text(apFields.join("    "), mg, y, { maxWidth: cw });
    y += 7;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text("POLICY", mg, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text(
      `${evalForm.productName || "—"}    Coverage: PKR ${Number(evalForm.coverageAmount || 0).toLocaleString()}    Term: ${evalForm.termYears || "—"} years`,
      mg, y, { maxWidth: cw },
    );
    y += 9;

    doc.setDrawColor(226, 232, 240);
    doc.line(mg, y, pageW - mg, y);
    y += 8;

    // ── AI Summary ───────────────────────────────────────────────────────────
    if (summary) {
      section("AI CASE SUMMARY");
      const plain = summary
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1")
        .replace(/^\s*[-*+]\s+/gm, "• ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(51, 65, 85);
      const lines = doc.splitTextToSize(plain, cw);
      for (const line of lines) {
        nextPage(5);
        doc.text(line, mg, y);
        y += 4.5;
      }
      y += 5;

      nextPage(4);
      doc.setDrawColor(226, 232, 240);
      doc.line(mg, y, pageW - mg, y);
      y += 8;
    }

    // ── Risk scores ──────────────────────────────────────────────────────────
    section("RISK ASSESSMENT");
    if (evalResult.medicalScore !== null)
      scoreBar("Medical Score",     evalResult.medicalScore,               `${evalResult.medicalScore} / 100`,              59, 130, 246);
    if (evalResult.financialScore !== null)
      scoreBar("Financial Score",   evalResult.financialScore,             `${evalResult.financialScore} / 100`,            139, 92, 246);
    if (evalResult.fraudProbability !== null)
      scoreBar("Fraud Probability", evalResult.fraudProbability * 100,     evalResult.fraudProbability.toFixed(2),          239, 68, 68);

    y += 2;
    nextPage(4);
    doc.setDrawColor(226, 232, 240);
    doc.line(mg, y, pageW - mg, y);
    y += 8;

    // ── Decision ─────────────────────────────────────────────────────────────
    section("UNDERWRITING DECISION");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text("Composite Risk Score", mg, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.setTextColor(15, 23, 42);
    doc.text(String(evalResult.compositeScore ?? "—"), mg + 52, y + 0.5);
    y += 8;

    const DECISION_COLOR: Record<string, [number, number, number]> = {
      "Auto Approve":        [16,  185, 129],
      "Approve with Loading":[245, 158, 11 ],
      "Human Review":        [59,  130, 246],
      "Decline":             [239, 68,  68 ],
    };
    const [dr, dg, db] = DECISION_COLOR[evalResult.aiDecision ?? ""] ?? [100, 116, 139];
    doc.setFillColor(dr, dg, db);
    doc.rect(mg, y - 4, 60, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(evalResult.aiDecision ?? "—", mg + 4, y + 1);
    y += 14;

    // XAI reasons
    if (evalResult.reasons.length > 0) {
      nextPage(12);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text("DECISION REASONING", mg, y);
      y += 5;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(71, 85, 105);
      for (let i = 0; i < evalResult.reasons.length; i++) {
        const isLast = i === evalResult.reasons.length - 1;
        const prefix = isLast ? "∑  " : "–  ";
        if (isLast) {
          doc.setFont("helvetica", "bold");
          doc.setTextColor(51, 65, 85);
        }
        const wrapped = doc.splitTextToSize(prefix + evalResult.reasons[i], cw);
        for (const line of wrapped) {
          nextPage(5);
          doc.text(line, mg, y);
          y += 4.5;
        }
        if (isLast) { doc.setFont("helvetica", "normal"); doc.setTextColor(71, 85, 105); }
      }
    }

    // ── Footer on every page ──────────────────────────────────────────────────
    const totalPages = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setDrawColor(226, 232, 240);
      doc.line(mg, pageH - 12, pageW - mg, pageH - 12);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(148, 163, 184);
      doc.text(
        "insurance-ai Underwriting Platform · Prototype v0.1.0 · Strictly Confidential · Adamjee Life Assurance Co. Ltd.",
        pageW / 2, pageH - 7, { align: "center" },
      );
      doc.text(`Page ${p} of ${totalPages}`, pageW - mg, pageH - 7, { align: "right" });
    }

    doc.save(`risk-assessment-${evalForm.cnic || "report"}-${new Date().toISOString().split("T")[0]}.pdf`);
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 py-5 max-w-screen-2xl mx-auto w-full space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Case Summarizer</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Compile OCR text from case documents into an AI summary, then route directly to risk evaluation.
          </p>
        </div>
        <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold tracking-wide">
          POST /summarize/stream
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5 items-start">

        {/* ── LEFT PANEL ──────────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Case selector */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-700">Select Case</p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Applicant</label>
                <select
                  value={selectedApplicant?.id ?? ""}
                  onChange={e => {
                    setSelectedApplicant(applicants.find(a => a.id === e.target.value) ?? null);
                    setSelectedCase(null);
                    setSumStatus("idle");
                    setSummary("");
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                >
                  <option value="">— Select applicant —</option>
                  {applicants.map(a => (
                    <option key={a.id} value={a.id}>{a.name} · {a.cnic}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Case</label>
                <select
                  value={selectedCase?.caseld ?? ""}
                  disabled={!selectedApplicant || loadingCases}
                  onChange={e => {
                    const c = cases.find(c => c.caseld === e.target.value) ?? null;
                    setSelectedCase(c);
                    setSumStatus("idle");
                    setSummary("");
                    setEvalStatus("idle");
                    setEvalResult(INITIAL_EVAL);
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 disabled:opacity-50"
                >
                  <option value="">— Select case —</option>
                  {cases.map(c => (
                    <option key={c.caseld} value={c.caseld}>{c.caseNumber} · {c.status}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Documents checklist */}
          {selectedCase && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">Documents</p>
                <span className="text-[10px] font-medium text-slate-400">
                  {selectedDocs.length} / {artifacts.length} selected
                </span>
              </div>

              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {loadingArtifacts ? (
                  <div className="flex justify-center py-8">
                    <span className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                  </div>
                ) : artifacts.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">No documents in this case.</p>
                ) : artifacts.map(a => {
                  const hasOCR = !!a.ocr_result && a.status !== "Processing";
                  const chipCls =
                    a.status === "Processing"   ? "bg-blue-50 text-blue-600 border-blue-200" :
                    a.status === "Accepted"      ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                                   "bg-amber-50 text-amber-700 border-amber-200";
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-3 px-5 py-3 ${hasOCR ? "cursor-pointer hover:bg-slate-50" : "opacity-40 cursor-not-allowed"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checkedDocs.has(a.id)}
                        disabled={!hasOCR}
                        onChange={() => {
                          const next = new Set(checkedDocs);
                          next.has(a.id) ? next.delete(a.id) : next.add(a.id);
                          setCheckedDocs(next);
                        }}
                        className="accent-blue-600 flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-700 truncate">{a.file_name ?? "Untitled"}</p>
                        <p className="text-[10px] text-slate-400">{a.document_type}</p>
                      </div>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${chipCls}`}>
                        {a.status}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="px-5 py-4 border-t border-slate-100">
                <button
                  onClick={handleSummarize}
                  disabled={sumRunning || selectedDocs.length === 0}
                  className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
                    sumRunning || selectedDocs.length === 0
                      ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                      : "bg-blue-600 text-white hover:bg-blue-700 active:scale-[0.99] shadow-sm"
                  }`}
                >
                  {sumRunning ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-300 border-t-transparent animate-spin" />
                      Summarizing…
                    </span>
                  ) : `Summarize ${selectedDocs.length} Document${selectedDocs.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL ─────────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Empty state */}
          {sumStatus === "idle" && (
            <div className="bg-white rounded-xl border border-slate-200 border-dashed p-14 flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-slate-400">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-slate-600">
                {!selectedCase ? "Select a case to get started" : selectedDocs.length === 0 ? "No OCR-ready documents selected" : "Ready to summarize"}
              </p>
              <p className="text-xs text-slate-400 mt-1.5 max-w-xs leading-relaxed">
                {!selectedCase
                  ? "Choose an applicant and case on the left, then select the documents to include."
                  : selectedDocs.length === 0
                  ? "Tick the documents with OCR results on the left, then click Summarize."
                  : `${selectedDocs.length} document${selectedDocs.length !== 1 ? "s" : ""} selected — click Summarize to begin.`}
              </p>
            </div>
          )}

          {/* Summary card */}
          {sumStatus !== "idle" && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">AI Case Summary</p>
                <div className="flex items-center gap-3">
                  {tokenUsage && (
                    <span className="text-[10px] text-slate-400 font-mono">{tokenUsage.total.toLocaleString()} tokens</span>
                  )}
                  {sumStatus === "streaming" && (
                    <span className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-600">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                      Gemini 2.5 Flash
                    </span>
                  )}
                  {sumStatus === "done" && (
                    <span className="text-[10px] font-semibold text-emerald-600 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      Complete
                    </span>
                  )}
                </div>
              </div>

              <div className="p-5">
                {sumStatus === "error" && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-xs text-red-600">{sumError}</div>
                )}
                {summary ? (
                  <ReactMarkdown components={MD_COMPONENTS}>{summary}</ReactMarkdown>
                ) : sumStatus === "streaming" ? (
                  <div className="flex items-center gap-2 text-xs text-slate-400 py-4">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-300 border-t-transparent animate-spin" />
                    Generating summary…
                  </div>
                ) : null}
              </div>

              {sumStatus === "done" && tokenUsage && (
                <div className="px-5 py-2.5 border-t border-slate-100 flex gap-5 text-[10px] text-slate-400 font-mono bg-slate-50">
                  <span>Input: {tokenUsage.input.toLocaleString()}</span>
                  <span>Output: {tokenUsage.output.toLocaleString()}</span>
                  <span className="font-semibold text-slate-500">Total: {tokenUsage.total.toLocaleString()}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Risk Engine section (only after summary completes) ───────────── */}
          {sumStatus === "done" && (
            <>
              {/* Proposal form */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowEvalForm(v => !v)}
                  className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors border-b border-slate-100"
                >
                  <div className="flex items-center gap-2.5">
                    <p className="text-sm font-semibold text-slate-700">Risk Engine Proposal</p>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200">
                      Auto-filled
                    </span>
                  </div>
                  <svg
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round"
                    className={`w-4 h-4 text-slate-400 transition-transform ${showEvalForm ? "rotate-180" : ""}`}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {showEvalForm && (
                  <div className="p-5">
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <EvalField label="CNIC"                value={evalForm.cnic}            onChange={v => setEvalForm(f => ({ ...f, cnic: v }))}            placeholder="35201-1234567-1" />
                      <EvalField label="Full Name"           value={evalForm.name}            onChange={v => setEvalForm(f => ({ ...f, name: v }))}            placeholder="Muhammad Ali" />
                      <EvalField label="Date of Birth" type="date" value={evalForm.dob}       onChange={v => setEvalForm(f => ({ ...f, dob: v }))} />
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Gender</label>
                        <select
                          value={evalForm.gender}
                          onChange={e => setEvalForm(f => ({ ...f, gender: e.target.value }))}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                        >
                          <option>Male</option><option>Female</option><option>Other</option>
                        </select>
                      </div>
                      <EvalField label="Occupation"          value={evalForm.occupation}      onChange={v => setEvalForm(f => ({ ...f, occupation: v }))}      placeholder="Engineer" />
                      <EvalField label="Annual Income (PKR)" type="number" value={evalForm.declaredIncome} onChange={v => setEvalForm(f => ({ ...f, declaredIncome: v }))} placeholder="1200000" />
                      <EvalField label="Product Name"        value={evalForm.productName}     onChange={v => setEvalForm(f => ({ ...f, productName: v }))}     placeholder="Term Life Insurance" />
                      <EvalField label="Coverage (PKR)"      type="number" value={evalForm.coverageAmount} onChange={v => setEvalForm(f => ({ ...f, coverageAmount: v }))} placeholder="5000000" />
                      <EvalField label="Term (Years)"        type="number" value={evalForm.termYears}      onChange={v => setEvalForm(f => ({ ...f, termYears: v }))}      placeholder="20" />
                    </div>
                  </div>
                )}

                {/* Always-visible quick inputs for coverage + term (the two fields not from applicant) */}
                {!showEvalForm && (
                  <div className="px-5 py-4 grid grid-cols-2 gap-3">
                    <EvalField label="Coverage Amount (PKR)" type="number" value={evalForm.coverageAmount} onChange={v => setEvalForm(f => ({ ...f, coverageAmount: v }))} placeholder="5000000" />
                    <EvalField label="Term (Years)"          type="number" value={evalForm.termYears}      onChange={v => setEvalForm(f => ({ ...f, termYears: v }))}      placeholder="20" />
                  </div>
                )}

                <div className="px-5 pb-5">
                  <button
                    onClick={runEval}
                    disabled={evalRunning}
                    className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
                      evalRunning
                        ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                        : "bg-slate-900 text-white hover:bg-slate-800 active:scale-[0.99] shadow-sm"
                    }`}
                  >
                    {evalRunning ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
                        Evaluating…
                      </span>
                    ) : "Run Risk Evaluation"}
                  </button>
                </div>
              </div>

              {/* Pipeline stepper */}
              {(evalStatus !== "idle" || evalResult.completedNodes.length > 0) && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-700">LangGraph Pipeline</p>
                    {evalRunning && (
                      <span className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                        Streaming
                      </span>
                    )}
                    {evalStatus === "done" && (
                      <span className="text-[10px] font-semibold text-emerald-600 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Complete
                      </span>
                    )}
                  </div>
                  <div className="px-5 py-5">
                    <div className="flex items-start">
                      {PIPELINE_NODES.map((node, i) => {
                        const done   = evalResult.completedNodes.includes(node.key);
                        const active = evalRunning && i === evalResult.completedNodes.length;
                        return (
                          <div key={node.key} className="flex items-start flex-1 last:flex-none">
                            <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-500 ${
                                done   ? `${node.dotColor} text-white shadow-sm`
                                : active ? "bg-blue-50 text-blue-600 border-2 border-blue-400 animate-pulse"
                                :          "bg-slate-100 text-slate-400"
                              }`}>
                                {done ? "✓" : i + 1}
                              </div>
                              <span className="text-[9px] font-medium text-slate-500 text-center leading-tight w-14 whitespace-pre-line">
                                {node.label}
                              </span>
                            </div>
                            {i < PIPELINE_NODES.length - 1 && (
                              <div className={`flex-1 h-0.5 mt-4 mx-0.5 transition-colors duration-500 ${done ? "bg-slate-300" : "bg-slate-100"}`} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Validation errors */}
              {evalResult.validationErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-2">Validation Errors</p>
                  <ul className="space-y-1">
                    {evalResult.validationErrors.map((msg, i) => (
                      <li key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                        <span className="text-red-400 mt-0.5 flex-shrink-0">✕</span>{msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Stream error */}
              {evalStatus === "error" && evalError && evalResult.validationErrors.length === 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <p className="text-xs font-bold text-red-700 uppercase tracking-widest mb-1">Error</p>
                  <p className="text-xs text-red-600">{evalError}</p>
                </div>
              )}

              {/* Risk scores */}
              {(evalResult.medicalScore !== null || evalResult.financialScore !== null || evalResult.fraudProbability !== null) && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100">
                    <p className="text-sm font-semibold text-slate-700">Risk Scores</p>
                  </div>
                  <div className="p-5 space-y-5">
                    {evalResult.medicalScore !== null && (
                      <div>
                        <RiskScoreBar label="Medical Score" score={evalResult.medicalScore} />
                        <ReasonList reasons={evalResult.medicalReasons} accent="text-blue-400" />
                      </div>
                    )}
                    {evalResult.financialScore !== null && (
                      <div>
                        <RiskScoreBar label="Financial Score" score={evalResult.financialScore} />
                        <ReasonList reasons={evalResult.financialReasons} accent="text-violet-400" />
                      </div>
                    )}
                    {evalResult.fraudProbability !== null && (
                      <div>
                        <RiskScoreBar
                          label="Fraud Probability"
                          score={Math.round(evalResult.fraudProbability * 100)}
                          valueLabel={evalResult.fraudProbability.toFixed(2)}
                        />
                        <ReasonList reasons={evalResult.fraudReasons} accent="text-red-400" />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Decision */}
              {evalResult.compositeScore !== null && decision && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100">
                    <p className="text-sm font-semibold text-slate-700">Underwriting Decision</p>
                  </div>
                  <div className="p-5 space-y-5">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-5">
                      <CompositeScoreRing score={evalResult.compositeScore} />
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">AI Decision</p>
                        <StatusBadge decision={decision} size="lg" />
                      </div>
                    </div>
                    {evalResult.reasons.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">XAI Reasons</p>
                        <ul className="space-y-1.5">
                          {evalResult.reasons.map((r, i) => {
                            const isMath = i === evalResult.reasons.length - 1;
                            return (
                              <li key={i} className={`text-xs flex items-start gap-2 ${
                                isMath ? "bg-slate-50 rounded-lg p-2.5 text-slate-700 font-medium font-mono" : "text-slate-600"
                              }`}>
                                <span className={`mt-0.5 flex-shrink-0 ${isMath ? "text-slate-400" : "text-slate-300"}`}>
                                  {isMath ? "∑" : "–"}
                                </span>
                                {r}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Download PDF — shown once evaluation is complete */}
              {evalStatus === "done" && evalResult.compositeScore !== null && (
                <button
                  onClick={downloadReport}
                  className="w-full flex items-center justify-center gap-2.5 py-3 rounded-xl border-2 border-dashed border-slate-300 text-sm font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all active:scale-[0.99]"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download PDF Report
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function EvalField({
  label, type = "text", value, onChange, placeholder,
}: {
  label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
      />
    </div>
  );
}

function ReasonList({ reasons, accent }: { reasons: string[]; accent: string }) {
  if (!reasons.length) return null;
  return (
    <ul className="mt-2 space-y-1 pl-1">
      {reasons.map((r, i) => (
        <li key={i} className="text-xs text-slate-500 flex items-start gap-1.5">
          <span className={`mt-0.5 flex-shrink-0 ${accent}`}>›</span>
          {r}
        </li>
      ))}
    </ul>
  );
}
