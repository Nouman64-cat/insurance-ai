"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import api from "@/app/services/api";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { StatusBadge } from "@/components/StatusBadge";
import type { AIDecision } from "@/lib/mock-data";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";

// ── Types ──────────────────────────────────────────────────────────────────────

import { workflowStore, INITIAL_EVAL, INITIAL_FORM } from "./workflowStore";
import type { Applicant, CaseItem, Artifact, TokenUsage, SumStatus, EvalStatus, EvalState, EvalForm } from "./workflowStore";

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
  const [storeState, setStoreState] = useState(() => ({
    selectedApplicant: workflowStore.selectedApplicant,
    selectedCase: workflowStore.selectedCase,
    checkedDocs: workflowStore.checkedDocs,
    applicantSearch: workflowStore.applicantSearch,
    sumStatus: workflowStore.sumStatus,
    summary: workflowStore.summary,
    tokenUsage: workflowStore.tokenUsage,
    sumError: workflowStore.sumError,
    showEvalForm: workflowStore.showEvalForm,
    evalForm: workflowStore.evalForm,
    evalStatus: workflowStore.evalStatus,
    evalResult: workflowStore.evalResult,
    evalError: workflowStore.evalError,
  }));

  useEffect(() => {
    return workflowStore.subscribe(() => {
      setStoreState({
        selectedApplicant: workflowStore.selectedApplicant,
        selectedCase: workflowStore.selectedCase,
        checkedDocs: workflowStore.checkedDocs,
        applicantSearch: workflowStore.applicantSearch,
        sumStatus: workflowStore.sumStatus,
        summary: workflowStore.summary,
        tokenUsage: workflowStore.tokenUsage,
        sumError: workflowStore.sumError,
        showEvalForm: workflowStore.showEvalForm,
        evalForm: workflowStore.evalForm,
        evalStatus: workflowStore.evalStatus,
        evalResult: workflowStore.evalResult,
        evalError: workflowStore.evalError,
      });
    });
  }, []);

  const {
    selectedApplicant,
    selectedCase,
    checkedDocs,
    applicantSearch,
    sumStatus,
    summary,
    tokenUsage,
    sumError,
    showEvalForm,
    evalForm,
    evalStatus,
    evalResult,
    evalError,
  } = storeState;

  const setSelectedApplicant = (val: Applicant | null) => workflowStore.update({ selectedApplicant: val });
  const setSelectedCase = (val: CaseItem | null) => workflowStore.update({ selectedCase: val });
  const setCheckedDocs = (val: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof val === "function" ? val(workflowStore.checkedDocs) : val;
    workflowStore.update({ checkedDocs: next });
  };
  const setApplicantSearch = (val: string) => workflowStore.update({ applicantSearch: val });
  const setSumStatus = (val: SumStatus) => workflowStore.update({ sumStatus: val });
  const setSummary = (val: string | ((prev: string) => string)) => {
    const next = typeof val === "function" ? val(workflowStore.summary) : val;
    workflowStore.update({ summary: next });
  };
  const setTokenUsage = (val: TokenUsage | null) => workflowStore.update({ tokenUsage: val });
  const setSumError = (val: string | null) => workflowStore.update({ sumError: val });
  const setShowEvalForm = (val: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof val === "function" ? val(workflowStore.showEvalForm) : val;
    workflowStore.update({ showEvalForm: next });
  };
  const setEvalForm = (val: EvalForm | ((prev: EvalForm) => EvalForm)) => {
    const next = typeof val === "function" ? val(workflowStore.evalForm) : val;
    workflowStore.update({ evalForm: next });
  };
  const setEvalStatus = (val: EvalStatus) => workflowStore.update({ evalStatus: val });
  const setEvalResult = (val: EvalState | ((prev: EvalState) => EvalState)) => {
    const next = typeof val === "function" ? val(workflowStore.evalResult) : val;
    workflowStore.update({ evalResult: next });
  };
  const setEvalError = (val: string | null) => workflowStore.update({ evalError: val });

  const [cases, setCases] = useState<CaseItem[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  // Search applicant combobox state
  const [showApplicantDropdown, setShowApplicantDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowApplicantDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
    setEvalForm({
      ...evalForm,
      cnic: selectedApplicant.cnic,
      name: selectedApplicant.name,
      dob: selectedApplicant.dob,
      gender: selectedApplicant.gender,
      occupation: selectedApplicant.occupation,
      declaredIncome: String(selectedApplicant.declared_income),
    });
  }, [selectedApplicant]);

  const selectedDocs = artifacts.filter(a => checkedDocs.has(a.id) && a.ocr_result);

  // ── Summarize ─────────────────────────────────────────────────────────────────

  const handleSummarize = async () => {
    if (selectedDocs.length === 0) return;
    workflowStore.startSummarize(API_BASE, localStorage.getItem("jwt_token") ?? "", selectedDocs);
  };

  // ── Risk Evaluation ───────────────────────────────────────────────────────────

  const runEval = async () => {
    workflowStore.startEval(API_BASE, tenantId);
  };

  const decision    = asDecision(evalResult.aiDecision);
  const sumRunning  = sumStatus  === "streaming";
  const evalRunning = evalStatus === "streaming";

  // ── PDF report ────────────────────────────────────────────────────────────────

  const downloadReport = async () => {
    const { default: jsPDF } = await import("jspdf");

    const logoImg = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.src = "/rizvi.png";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
    });

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

    // ── Header with Logo ──────────────────────────────────────────────────────
    doc.setFillColor(255, 255, 255);
    doc.rect(0, 0, pageW, 28, "F");
    doc.setFillColor(59, 130, 246);
    doc.rect(0, 28, pageW, 1.5, "F");

    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("insurance-ai", mg, 12);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text("Underwriting Platform · Case Risk Assessment Report", mg, 20);
    doc.setTextColor(148, 163, 184);
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageW - mg, 20, { align: "right" });

    if (logoImg) {
      doc.addImage(logoImg, "PNG", pageW - mg - 36.2, 4.5, 36.2, 13);
    }

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
      const lines = summary.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) {
          y += 3;
          continue;
        }

        // Header 6
        if (line.startsWith("###### ")) {
          const text = line.replace("###### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(100, 116, 139);
          doc.text(text, mg, y);
          y += 4;
          continue;
        }

        // Header 5
        if (line.startsWith("##### ")) {
          const text = line.replace("##### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(100, 116, 139);
          doc.text(text, mg, y);
          y += 4.5;
          continue;
        }

        // Header 4
        if (line.startsWith("#### ")) {
          const text = line.replace("#### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(9);
          doc.setTextColor(71, 85, 105);
          doc.text(text, mg, y);
          y += 4.5;
          continue;
        }

        // Header 3
        if (line.startsWith("### ")) {
          const text = line.replace("### ", "").trim();
          nextPage(8);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(9.5);
          doc.setTextColor(71, 85, 105);
          doc.text(text, mg, y);
          y += 5;
          continue;
        }

        // Header 2
        if (line.startsWith("## ")) {
          const text = line.replace("## ", "").trim();
          nextPage(10);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(30, 41, 59);
          doc.text(text, mg, y);
          y += 5.5;
          continue;
        }

        // Header 1
        if (line.startsWith("# ")) {
          const text = line.replace("# ", "").trim();
          nextPage(12);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.setTextColor(15, 23, 42);
          doc.text(text, mg, y);
          y += 6;
          continue;
        }

        // Bullet list
        if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("• ")) {
          const text = line.substring(2).trim();
          const cleanText = text.replace(/\*\*/g, "").replace(/\*/g, "");
          const wrapped = doc.splitTextToSize(cleanText, cw - 6);
          nextPage(wrapped.length * 4.5 + 2);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8.5);
          doc.setTextColor(71, 85, 105);
          
          doc.text("•", mg + 2, y);
          for (let j = 0; j < wrapped.length; j++) {
            doc.text(wrapped[j], mg + 6, y);
            y += 4.5;
          }
          continue;
        }

        // Regular paragraph line
        const cleanLine = line.replace(/\*\*/g, "").replace(/\*/g, "");
        const wrapped = doc.splitTextToSize(cleanLine, cw);
        nextPage(wrapped.length * 4.5 + 2);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        for (let j = 0; j < wrapped.length; j++) {
          doc.text(wrapped[j], mg, y);
          y += 4.5;
        }
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

      for (let i = 0; i < evalResult.reasons.length; i++) {
        const isLast = i === evalResult.reasons.length - 1;
        
        let reasonText = evalResult.reasons[i];
        if (isLast) {
          const normalized = reasonText
            .replace(/×/g, "x")
            .replace(/→/g, "->")
            .replace(/!'/g, "->")
            .replace(/–/g, "-")
            .replace(/</g, "under")
            .replace(/>/g, "over");
          
          const parts = normalized.split("->").map((p: string) => p.trim());
          const calc = parts[0] || "";
          const rule = parts[1] || "";

          // Draw calculation section
          nextPage(12);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(51, 65, 85);
          doc.text("Mathematical Breakdown:", mg, y);
          y += 4.5;
          
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(51, 65, 85);
          const calcWrapped = doc.splitTextToSize(calc, cw - 4);
          for (const line of calcWrapped) {
            nextPage(4.5);
            doc.text(line, mg + 4, y);
            y += 4;
          }
          
          // Draw rule section
          if (rule) {
            y += 1.5;
            nextPage(10);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(8);
            doc.setTextColor(51, 65, 85);
            doc.text("Matched Decision Rule:", mg, y);
            y += 4;
            
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(71, 85, 105);
            const ruleWrapped = doc.splitTextToSize(rule, cw - 4);
            for (const line of ruleWrapped) {
              nextPage(4.5);
              doc.text(line, mg + 4, y);
              y += 4;
            }
          }
          continue;
        }

        // Normal reason drawing
        const prefix = "-  ";
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        
        const wrapped = doc.splitTextToSize(prefix + reasonText, cw);
        for (const line of wrapped) {
          nextPage(5);
          doc.text(line, mg, y);
          y += 4.5;
        }
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
        <div className="space-y-4 lg:sticky lg:top-5">

          {/* Case selector */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="px-5 py-3 border-b border-slate-100 rounded-t-xl">
              <p className="text-sm font-semibold text-slate-700">Select Case</p>
            </div>
            <div className="p-5 space-y-4">
              <div className="relative" ref={dropdownRef}>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Applicant</label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search or select applicant..."
                    value={applicantSearch}
                    onFocus={() => setShowApplicantDropdown(true)}
                    onChange={e => {
                      setApplicantSearch(e.target.value);
                      setShowApplicantDropdown(true);
                      if (!e.target.value) {
                        setSelectedApplicant(null);
                        setSelectedCase(null);
                      }
                    }}
                    className="w-full px-3 py-2 pr-12 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                  />
                  {applicantSearch && (
                    <button
                      type="button"
                      onClick={() => {
                        setApplicantSearch("");
                        setSelectedApplicant(null);
                        setSelectedCase(null);
                        setShowApplicantDropdown(true);
                      }}
                      className="absolute right-8 top-2 text-slate-400 hover:text-slate-600 text-xs"
                    >
                      ✕
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowApplicantDropdown(!showApplicantDropdown)}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                  >
                    <svg className={`w-4 h-4 transform transition-transform ${showApplicantDropdown ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>

                {showApplicantDropdown && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                    {(() => {
                      const filtered = applicants.filter(a =>
                        a.name.toLowerCase().includes(applicantSearch.toLowerCase()) ||
                        a.cnic.includes(applicantSearch)
                      );
                      if (filtered.length === 0) {
                        return <div className="px-3 py-2 text-xs text-slate-500">No applicants found</div>;
                      }
                      return filtered.map(a => (
                        <div
                          key={a.id}
                          onClick={() => {
                            setSelectedApplicant(a);
                            setApplicantSearch(`${a.name} (${a.cnic})`);
                            setShowApplicantDropdown(false);
                            setSelectedCase(null);
                            setSumStatus("idle");
                            setSummary("");
                          }}
                          className={`px-3 py-2 text-sm cursor-pointer hover:bg-slate-50 flex flex-col ${
                            selectedApplicant?.id === a.id ? "bg-blue-50/50" : ""
                          }`}
                        >
                          <span className="font-semibold text-slate-700">{a.name}</span>
                          <span className="text-[10px] text-slate-400 font-mono">CNIC: {a.cnic}</span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
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

              <div className="p-5 max-h-[400px] overflow-y-auto">
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
                  onClick={() => setShowEvalForm(!showEvalForm)}
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
                      <EvalField label="CNIC"                value={evalForm.cnic}            onChange={v => setEvalForm({ ...evalForm, cnic: v })}            placeholder="35201-1234567-1" />
                      <EvalField label="Full Name"           value={evalForm.name}            onChange={v => setEvalForm({ ...evalForm, name: v })}            placeholder="Muhammad Ali" />
                      <EvalField label="Date of Birth" type="date" value={evalForm.dob}       onChange={v => setEvalForm({ ...evalForm, dob: v })} />
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Gender</label>
                        <select
                          value={evalForm.gender}
                          onChange={e => setEvalForm({ ...evalForm, gender: e.target.value })}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                        >
                          <option>Male</option><option>Female</option><option>Other</option>
                        </select>
                      </div>
                      <EvalField label="Occupation"          value={evalForm.occupation}      onChange={v => setEvalForm({ ...evalForm, occupation: v })}      placeholder="Engineer" />
                      <EvalField label="Annual Income (PKR)" type="number" value={evalForm.declaredIncome} onChange={v => setEvalForm({ ...evalForm, declaredIncome: v })} placeholder="1200000" />
                      <EvalField label="Product Name"        value={evalForm.productName}     onChange={v => setEvalForm({ ...evalForm, productName: v })}     placeholder="Term Life Insurance" />
                      <EvalField label="Coverage (PKR)"      type="number" value={evalForm.coverageAmount} onChange={v => setEvalForm({ ...evalForm, coverageAmount: v })} placeholder="5000000" />
                      <EvalField label="Term (Years)"        type="number" value={evalForm.termYears}      onChange={v => setEvalForm({ ...evalForm, termYears: v })}      placeholder="20" />
                    </div>
                  </div>
                )}

                {/* Always-visible quick inputs for coverage + term (the two fields not from applicant) */}
                {!showEvalForm && (
                  <div className="px-5 py-4 grid grid-cols-2 gap-3">
                    <EvalField label="Coverage Amount (PKR)" type="number" value={evalForm.coverageAmount} onChange={v => setEvalForm({ ...evalForm, coverageAmount: v })} placeholder="5000000" />
                    <EvalField label="Term (Years)"          type="number" value={evalForm.termYears}      onChange={v => setEvalForm({ ...evalForm, termYears: v })}      placeholder="20" />
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
                    {evalResult.validationErrors.map((msg: string, i: number) => (
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
                          {evalResult.reasons.map((r: string, i: number) => {
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
