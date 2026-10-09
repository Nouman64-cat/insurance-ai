"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import VoiceOverlay from "./VoiceOverlay";
import { useRouter } from "next/navigation";
import api from "../app/services/api";
import { useNotify } from "./NotificationContext";
import { ProcessGraph } from "./ProcessGraph";
import { JourneyMap } from "./agent/JourneyMap";
import { JourneyActivityPanel } from "./agent/JourneyActivityPanel";
import { journeyFromCase, journeyFromChat } from "@/lib/agent/journey";
import type { CaseDetail, Journey, JourneyContext, ProposalState } from "@/lib/agent/journey";
import { useCaseEvents } from "@/lib/agent/useCaseEvents";
import type { CaseEvent } from "@/lib/agent/useCaseEvents";
import { isPassiveAction } from "@/lib/agent/quickActions";
import { useAgentChat, type FamilyJourney, type EnrolledOrganization } from "@/lib/agent/useAgentChat";
import { requestHighlight, triggerHighlight } from "@/lib/useHighlightTarget";
import { isCommissionTool, runCommissionTool } from "@/lib/agent/commissionTools";
import { QuickActionSelect } from "./agent/QuickActionSelect";
import { DocumentUploadDialog } from "./agent/DocumentUploadDialog";
import type { DocumentUploadResult } from "./agent/DocumentUploadDialog";
import { getQuote, listQuotes, updateQuote } from "../app/services/quotes";
import type { QuoteDetail } from "../app/services/quotes";
import type { AgentMessage, QuickAction, ProcessStep } from "@/lib/agent/types";

import { useCopilot } from "./CopilotContext";
import { RiskScoreBar, CompositeScoreRing } from "@/components/RiskScoreBar";
import { IssuanceModal, SuccessModal, PaymentModal } from "./policy/IssuanceModals";
import type { IssuanceResult, PaymentConfirmResult } from "@/app/services/policies";
import { ACRModal } from "./entities/ACRModal";
import RuleBuilderModal from "./rule-engine/RuleBuilderModal";
import { IS_DEMO } from "@/lib/envMode";
import GroupCensusClientTool from "@/components/group/GroupCensusClientTool";

const WELCOME: AgentMessage = {
  id: "1",
  role: "assistant",
  text: "Hello! I am your AI Underwriting Copilot. I can help you onboard applicants, run risk assessments, or pull case details instantly. What would you like to automate today?",
};

const STORAGE_KEY = "copilot_history";
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const actionIcons: Record<string, string> = {
  navigate: "🔗",
  submit: "▶️",
  upload: "📤",
  confirm: "✅",
  select: "🔽",
  download: "⬇️",
};

// Human-friendly title for the in-chat panel's header — derived from the
// route rather than kept as a lookup table, so a new page never needs an
// entry here to get a reasonable label.
function routeLabel(route: string): string {
  const clean = route.split("?")[0].replace(/^\/+/, "");
  const last = clean.split("/").filter(Boolean).pop() || clean;
  const isId = /^[0-9a-f-]{8,}$/i.test(last);
  const base = isId ? clean.split("/").filter(Boolean).slice(0, -1).join(" ") : clean;
  return (base || "record")
    .split(/[\/\-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function checkIsUploaded(action: QuickAction, uploadedDocs: string[]): boolean {
  if (action.actionType !== "upload") return false;
  let docType = "";
  if (action.payload) {
    try {
      const parsed = JSON.parse(action.payload);
      if (parsed.document_type) docType = parsed.document_type;
    } catch {
      docType = action.payload;
    }
  }
  if (!docType && action.label) {
    docType = action.label.replace(/^Upload\s+/i, "").trim();
  }
  if (!docType) return false;

  return uploadedDocs.some(
    (d) =>
      d.toLowerCase().trim() === docType.toLowerCase().trim() ||
      d.toLowerCase().includes(docType.toLowerCase()) ||
      docType.toLowerCase().includes(d.toLowerCase())
  );
}

// The evidence requirements the risk-assessment gate checks (on top of the
// 7-step checklist): a readable name, and the document type that satisfies
// it when it's an upload.
const EVIDENCE_REQUIREMENTS: Record<string, { label: string; documentType?: string }> = {
  CNIC: { label: "CNIC", documentType: "CNIC" },
  SALARY_SLIP: { label: "Salary slip", documentType: "Salary Slip" },
  BANK_STATEMENT: { label: "Bank statement", documentType: "Bank Statement" },
  TAX_DOCUMENT: { label: "Tax return", documentType: "Tax Return" },
  MEDICAL_EXAMINATION: { label: "Medical examination report", documentType: "Medical Report" },
  ECG: { label: "ECG report", documentType: "ECG Report" },
  LAB_REPORTS: { label: "Lab reports", documentType: "Lab Report" },
  PHYSICIAN_REPORT: { label: "Attending physician's report", documentType: "Physician Report" },
  MEDICAL_QUESTIONNAIRE: { label: "Medical questionnaire (e-application)" },
};

/** Tool result for a risk assessment the requirements gate refused: names
 *  each outstanding item and why, and offers the buttons that fix it. */
function buildRequirementsBlockedResult(gate: any, caseId: string, caseNumber?: string) {
  const caseRef = caseNumber || caseId;
  const open = ((gate?.requirements || []) as any[]).filter(
    (r) => r.required && r.status !== "Satisfied" && r.status !== "Waived"
  );
  const nameOf = (code: string) =>
    EVIDENCE_REQUIREMENTS[code]?.label ||
    (code.startsWith("ADDITIONAL_DOCUMENT:") ? `Additional document (${code.split(":")[1]})` : code.replace(/_/g, " ").toLowerCase());
  const lines = open.map((r) => `- **${nameOf(r.code)}** — \`${r.status}\`${r.reason ? `: ${r.reason}` : ""}`);
  const uploads = Array.from(new Set(open.map((r) => EVIDENCE_REQUIREMENTS[r.code]?.documentType).filter(Boolean))) as string[];
  const needsQuestionnaire = open.some((r) => r.code === "MEDICAL_QUESTIONNAIRE");

  const message = open.length
    ? `🚫 **Risk assessment is on hold for case ${caseRef}** — the underwriting evidence check needs ${open.length === 1 ? "one more item" : `${open.length} more items`}:\n\n${lines.join("\n")}\n\n` +
      `These come from the applicant's age, cover amount and income, on top of the 7-step checklist.\n\n` +
      `👉 ${uploads.length ? "Upload the missing document" + (uploads.length > 1 ? "s" : "") + " below" : "Resolve the items above"}` +
      `, or open the case to review them (an underwriter can waive one from the Requirements panel). Then run the assessment again.`
    : `🚫 **Risk assessment is on hold for case ${caseRef}** — the underwriting evidence check didn't pass. Open the case to see the Requirements panel, then run the assessment again.`;

  const quick_actions: QuickAction[] = [];
  if (uploads.length) {
    quick_actions.push({
      label: uploads.length === 1 ? `Upload ${uploads[0]}` : "Upload missing documents",
      actionType: "upload",
      payload: JSON.stringify({ case_id: caseId, case_number: caseNumber, document_types: uploads }),
    });
  }
  if (needsQuestionnaire) {
    quick_actions.push({ label: "Send e-application link", actionType: "submit", payload: `Generate e-application link for case ${caseRef}` });
  }
  quick_actions.push(
    { label: "Open case requirements", actionType: "embed", payload: `case/${caseId}` },
    { label: "Run risk assessment again", actionType: "submit", payload: `Run risk assessment for case ${caseRef}` },
  );

  return { success: false, requirements_pending: true, message, outstanding_requirements: open, quick_actions };
}

function getRecommendedActions(lastMessage: AgentMessage | undefined): QuickAction[] {
  if (!lastMessage) {
    return [
      { label: "Add a new customer", actionType: "submit", payload: "Add a new customer" },
      { label: "Start underwriting", actionType: "submit", payload: "Start underwriting journey for a customer" },
      { label: "Add a new rule ⚡", actionType: "submit", payload: "Add a new rule" },
      { label: "Commission Summary ⚡", actionType: "submit", payload: "Show commission position and summary" },
      { label: "Add new commission type ⚡", actionType: "submit", payload: "Add a new commission type in the commission engine" },

      { label: "Add new bonuses ⚡", actionType: "submit", payload: "Create a new performance bonus plan" },
      { label: "Rate Cards & Bonuses ⚡", actionType: "submit", payload: "List commission rate card rules and performance bonus plans" },
      { label: "Register a claim (FNOL)", actionType: "submit", payload: "Register a new claim" },
      { label: "Get claims info 📋", actionType: "submit", payload: "Show claims dashboard and summary" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
      { label: "Open Commission Engine ⚡", actionType: "navigate", payload: "commissions" },
      { label: "Calculate Commission", actionType: "submit", payload: "Calculate commission for active policy" },
      { label: "Check pending cases", actionType: "submit", payload: "Show me all pending cases" },
    ];
  }



  const text = (lastMessage.text || "").toLowerCase();

  // Claim numbers are the most reliable anchor in a claims conversation — the
  // backend puts one in every claims message, so recover it and build the
  // follow-ups around that specific claim rather than a generic prompt.
  const claimMatch = text.match(/clm-\d{4}-\d{3,}/i);
  const claimRef = claimMatch ? claimMatch[0].toUpperCase() : "";
  const looksLikeClaim =
    !!claimRef ||
    text.includes("claim") ||
    text.includes("fnol") ||
    text.includes("adjudicat") ||
    text.includes("claimant");

  // ── Claims: blocked on documents ────────────────────────────────────────
  // The single most common dead end in the claims flow: the API refuses every
  // approval and payout without a document, so lead with the upload buttons.
  if (looksLikeClaim && (text.includes("no documents") || text.includes("document gate") || text.includes("nothing on file"))) {
    return [
      { label: "Upload Hospital Bill", actionType: "upload", payload: JSON.stringify({ document_type: "Hospital Bill" }) },
      { label: "Upload Discharge Summary", actionType: "upload", payload: JSON.stringify({ document_type: "Discharge Summary" }) },
      { label: "Upload CNIC", actionType: "upload", payload: JSON.stringify({ document_type: "CNIC" }) },
      { label: "What's still missing?", actionType: "submit", payload: claimRef ? `What documents are missing on claim ${claimRef}?` : "What documents are missing on this claim?" },
    ];
  }

  // ── Claims: settled / closed ────────────────────────────────────────────
  if (looksLikeClaim && (text.includes("settled") || text.includes("disbursed") || text.includes("payout of"))) {
    return [
      { label: "Close the claim", actionType: "submit", payload: claimRef ? `Move claim ${claimRef} to Closed` : "Close the claim" },
      { label: "Recover from reinsurer", actionType: "submit", payload: claimRef ? `Refer claim ${claimRef} to reinsurance` : "Refer this claim to reinsurance" },
      { label: "Claims dashboard", actionType: "submit", payload: "Show the claims dashboard" },
      { label: "Open Claims", actionType: "navigate", payload: "claims" },
    ];
  }

  // ── Claims: approved, awaiting disbursement ─────────────────────────────
  if (looksLikeClaim && (text.includes("approved") || text.includes("partial approval"))) {
    return [
      { label: "Disburse the payout", actionType: "submit", payload: claimRef ? `Issue claim payout for ${claimRef} by Bank Transfer` : "Issue the claim payout" },
      { label: "Recover from reinsurer", actionType: "submit", payload: claimRef ? `Refer claim ${claimRef} to reinsurance` : "Refer this claim to reinsurance" },
      { label: "Open claim file", actionType: "navigate", payload: "claims" },
    ];
  }

  // ── Claims: re-underwriting referral open ───────────────────────────────
  if (looksLikeClaim && (text.includes("re-underwriting") || text.includes("contestability") || text.includes("non-disclosure"))) {
    return [
      { label: "Risk stands — continue", actionType: "submit", payload: claimRef ? `Resolve underwriting on claim ${claimRef} as APPROVE_CONTINUE` : "Resolve underwriting as APPROVE_CONTINUE" },
      { label: "Approve with exclusion", actionType: "submit", payload: claimRef ? `Resolve underwriting on claim ${claimRef} as APPROVE_WITH_EXCLUSION` : "Resolve underwriting as APPROVE_WITH_EXCLUSION" },
      { label: "Approve with loading", actionType: "submit", payload: claimRef ? `Resolve underwriting on claim ${claimRef} as APPROVE_WITH_LOADING` : "Resolve underwriting as APPROVE_WITH_LOADING" },
      { label: "Decline — non-disclosure", actionType: "submit", payload: claimRef ? `Resolve underwriting on claim ${claimRef} as DECLINE_NON_DISCLOSURE` : "Resolve underwriting as DECLINE_NON_DISCLOSURE" },
    ];
  }

  // ── Claims: needs a manager ─────────────────────────────────────────────
  if (looksLikeClaim && (text.includes("referred to manager") || text.includes("manager gate") || text.includes("claimsmanager"))) {
    return [
      { label: "Approve as manager", actionType: "submit", payload: claimRef ? `Adjudicate claim ${claimRef} as APPROVED` : "Approve the claim" },
      { label: "Partial approval", actionType: "submit", payload: claimRef ? `Adjudicate claim ${claimRef} as PARTIAL_APPROVAL` : "Partially approve the claim" },
      { label: "Decline", actionType: "submit", payload: claimRef ? `Adjudicate claim ${claimRef} as DECLINED` : "Decline the claim" },
      { label: "Open Claims", actionType: "navigate", payload: "claims" },
    ];
  }

  // ── Claims: freshly registered / under investigation ────────────────────
  if (looksLikeClaim && (text.includes("registered fnol") || text.includes("triaged") || text.includes("under investigation"))) {
    return [
      { label: "Upload Hospital Bill", actionType: "upload", payload: JSON.stringify({ document_type: "Hospital Bill" }) },
      { label: "Check the document file", actionType: "submit", payload: claimRef ? `What documents are missing on claim ${claimRef}?` : "What documents are missing on this claim?" },
      { label: "Settle it end to end", actionType: "submit", payload: claimRef ? `Run the claims journey for ${claimRef}` : "Run the claims journey for this claim" },
      { label: "Open Claims", actionType: "navigate", payload: "claims" },
    ];
  }

  // ── Claims: generic context ─────────────────────────────────────────────
  if (looksLikeClaim) {
    return [
      { label: "Register a claim (FNOL)", actionType: "submit", payload: "Register a new claim" },
      { label: "Show open claims", actionType: "submit", payload: "List claims that are Under Investigation" },
      { label: "Claims dashboard", actionType: "submit", payload: "Show the claims dashboard" },
      { label: "Open Claims", actionType: "navigate", payload: "claims" },
    ];
  }

  // ── Rule engine: post-deploy / archive ──────────────────────────────────
  if (
    (text.includes("deployed") || text.includes("archived")) &&
    (text.includes("rule") || text.includes("version"))
  ) {
    // Extract the rule set code from the message if present (e.g. `RS-MED-001`)
    const codeMatch = text.match(/`(rs-[a-z]+-\d+[a-z]?)`/i);
    const code = codeMatch ? codeMatch[1].toUpperCase() : "the rule set";
    return [
      { label: "Simulate the live rules", actionType: "submit", payload: `Simulate ${code} for a 45 year old with 5000000 sum assured` },
      { label: "View audit log", actionType: "submit", payload: "Show the rule evaluation logs" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
    ];
  }

  // ── Rule engine: post-simulation / evaluation ────────────────────────────
  if (
    (text.includes("simulated") || text.includes("result:") || text.includes("matched rule") || text.includes("matched_rule")) &&
    text.includes("rule")
  ) {
    const codeMatch = text.match(/`(rs-[a-z]+-\d+[a-z]?)`/i);
    const code = codeMatch ? codeMatch[1].toUpperCase() : "";
    return [
      { label: "View rule set detail", actionType: "submit", payload: code ? `Show rule set ${code}` : "Show live underwriting rule sets" },
      { label: "Edit rules (open draft)", actionType: "submit", payload: code ? `Create a draft version of rule set ${code}` : "Open a draft version" },
      { label: "View audit log", actionType: "submit", payload: "Show the rule evaluation logs" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
    ];
  }

  // ── Rule engine: post-draft / rule added / updated ───────────────────────
  if (
    text.includes("draft") &&
    (text.includes("rule") || text.includes("version")) &&
    (text.includes("added") || text.includes("updated") || text.includes("opened") || text.includes("copying"))
  ) {
    const codeMatch = text.match(/`(rs-[a-z]+-\d+[a-z]?)`/i);
    const code = codeMatch ? codeMatch[1].toUpperCase() : "";
    const deployPayload = code ? `Deploy the draft version of rule set ${code}` : "Deploy the draft version";
    const simulatePayload = code ? `Simulate rule set ${code} for a 45 year old with 5000000 sum assured` : "Simulate the draft rules";
    return [
      { label: "Simulate draft rules", actionType: "submit", payload: simulatePayload },
      { label: "Deploy to production ⚡", actionType: "submit", payload: deployPayload },
      { label: "Add another rule", actionType: "submit", payload: code ? `Add a rule to rule set ${code}` : "Add a rule to the draft version" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
    ];
  }

  // ── Rule engine: created rule set ────────────────────────────────────────
  if (
    text.includes("rule set") &&
    text.includes("created") &&
    text.includes("draft")
  ) {
    const codeMatch = text.match(/`([A-Z0-9-]+)`/);
    const code = codeMatch ? codeMatch[1] : "";
    return [
      { label: "Add a rule", actionType: "submit", payload: code ? `Add a rule to rule set ${code}` : "Add a rule to the new rule set" },
      { label: "Create draft version", actionType: "submit", payload: code ? `Create a draft version of rule set ${code}` : "Open a draft version" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
    ];
  }

  // ── Rule engine: a catalogue level was just created ──────────────────────
  if ((text.includes("category") || text.includes("subcategory")) && text.includes("created")) {
    const codeMatch = text.match(/`([A-Z0-9_]+)`/);
    const code = codeMatch ? codeMatch[1] : "";
    return [
      { label: "Create a rule set here", actionType: "submit", payload: code ? `Create a rule set under ${code}` : "Create a rule set here" },
      { label: "Add a subcategory", actionType: "submit", payload: code ? `Add a subcategory under category ${code}` : "Add a subcategory" },
      { label: "Add a channel profile", actionType: "submit", payload: code ? `Add an eligibility profile to ${code}` : "Add a channel eligibility profile" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
    ];
  }

  // ── Rule engine: generic context ─────────────────────────────────────────
  if (text.includes("rule") || text.includes("catalog") || text.includes("category")) {
    return [
      { label: "Add a new rule ⚡", actionType: "submit", payload: "Add a new rule" },
      { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
      { label: "Simulate rules", actionType: "submit", payload: "Simulate rules for a 45 year old with 5000000 sum assured" },
      { label: "Show all rule sets", actionType: "submit", payload: "List all rule sets" },
      { label: "View audit log", actionType: "submit", payload: "Show the rule evaluation logs" },
    ];
  }


  // ── Commission engine: Rate cards & Commission Rules ────────────────────
  if (text.includes("rate card") || text.includes("commission rule") || text.includes("types")) {
    return [
      { label: "List Rate Cards ⚡", actionType: "submit", payload: "List commission rate card rules" },
      { label: "+ Add Rate Card Rule", actionType: "submit", payload: "Create a new commission rate card rule" },
      { label: "Open Rate Cards", actionType: "navigate", payload: "commissions/types" },
      { label: "Open Commission Engine ⚡", actionType: "navigate", payload: "commissions" },
    ];
  }

  // ── Commission engine: Performance Bonus Plans & Incentives ──────────────
  if (text.includes("bonus") || text.includes("incentive") || text.includes("persistency")) {
    return [
      { label: "List Bonus Plans ⚡", actionType: "submit", payload: "List performance bonus plans" },
      { label: "+ Add Bonus Plan", actionType: "submit", payload: "Create a new performance bonus plan" },
      { label: "Open Bonuses Dashboard", actionType: "navigate", payload: "commissions/bonuses" },
      { label: "Open Commission Engine ⚡", actionType: "navigate", payload: "commissions" },
    ];
  }

  if (text.includes("commission") || text.includes("payee") || text.includes("ledger") || text.includes("payout") || text.includes("waterfall")) {
    return [
      { label: "Open Rate Cards ⚡", actionType: "navigate", payload: "commissions/types" },
      { label: "Open Bonus Plans ⚡", actionType: "navigate", payload: "commissions/bonuses" },
      { label: "View Commission Ledger", actionType: "navigate", payload: "commission-ops/ledger" },
      { label: "Calculate Commission", actionType: "submit", payload: "Calculate commission for active policy" },
      { label: "Create Payout Run", actionType: "submit", payload: "Create a payout run for this month" },
      { label: "Open Statements", actionType: "navigate", payload: "commission-ops/statements" },
    ];
  }


  if (text.includes("token") || text.includes("cost") || text.includes("finops") || text.includes("llm") || text.includes("quota")) {
    return [
      { label: "Open Token Economy ⚡", actionType: "navigate", payload: "super-admin/tokens" },
      { label: "Check Token Usage", actionType: "submit", payload: "Show token usage breakdown and costs" },
      { label: "Rule Engine FinOps", actionType: "navigate", payload: "admin/rule-engine" },
      { label: "Commission Engine FinOps", actionType: "navigate", payload: "commissions" },
    ];
  }
  
  if (text.includes("missing documents") || (text.includes("upload") && text.includes("document"))) {
    // Offer an upload button only for the documents the reply actually names. This used to offer CNIC, Medical
    // Report and Salary Slip whenever it named none — telling a user (whose required documents were all in) to
    // upload a Salary Slip no one had asked for.
    const named: [string, string][] = [
      ["cnic", "CNIC"], ["medical report", "Medical Report"], ["medical examination", "Medical Report"],
      ["physician", "Physician Report"], ["salary", "Salary Slip"], ["bank statement", "Bank Statement"],
      ["ecg", "ECG Report"], ["lab report", "Lab Report"], ["tax return", "Tax Return"],
    ];
    const seen = new Set<string>();
    const actions: QuickAction[] = [];
    for (const [needle, documentType] of named) {
      if (text.includes(needle) && !seen.has(documentType)) {
        seen.add(documentType);
        actions.push({ label: `Upload ${documentType}`, actionType: "upload", payload: JSON.stringify({ document_type: documentType }) });
      }
    }
    if (actions.length) {
      actions.push({ label: "I have uploaded them", actionType: "submit", payload: "I have uploaded the documents. Please check and proceed." });
      return actions;
    }
  }

  if (text.includes("customer") && text.includes("added")) {
    return [
      { label: "Create case now", actionType: "submit", payload: "Create an underwriting case for the customer" },
      { label: "Add another customer", actionType: "submit", payload: "Add another customer" },
      { label: "View leads", actionType: "navigate", payload: "admin/customers" },
    ];
  }
  if (text.includes("case") && text.includes("created")) {
    return [
      { label: "Create proposal now", actionType: "submit", payload: "Create a proposal for the customer" },
      { label: "View case details", actionType: "navigate", payload: "cases" },
      { label: "Create another case", actionType: "submit", payload: "Create a case" },
    ];
  }
  if (text.includes("proposal") && (text.includes("created") || text.includes("ready") || text.includes("structured"))) {
    return [
      { label: "1. Generate E-App Link (Gate 1)", actionType: "submit", payload: "Generate e-application link for this case" },
      { label: "Check Pre-Underwriting Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "Clear All Gates", actionType: "submit", payload: "Clear all pre-underwriting gates for this case" },
      { label: "View proposal", actionType: "navigate", payload: "proposal" },
    ];
  }
  if (text.includes("link generated") || (text.includes("e-application") && (text.includes("link") || text.includes("pending")))) {
    return [
      { label: "Verify E-Application", actionType: "submit", payload: "Verify e-application for this case" },
      { label: "2. Submit ACR (Gate 2)", actionType: "submit", payload: "Submit agent confidential report for this case" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
    ];
  }
  if (text.includes("gate 1") || (text.includes("e-application") && text.includes("verified"))) {
    return [
      { label: "2. Submit ACR (Gate 2)", actionType: "submit", payload: "Submit agent confidential report for this case" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "View Case", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("gate 2") || (text.includes("acr") && text.includes("submitted"))) {
    return [
      { label: "3. Compliance Screen (Gate 3)", actionType: "submit", payload: "Run compliance screening for this case" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "View Case", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("gate 3") || (text.includes("compliance") && (text.includes("passed") || text.includes("screening")))) {
    return [
      { label: "4. Initial Premium (Gate 4)", actionType: "submit", payload: "Process initial premium payment for this case" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "View Case", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("gate 4") || (text.includes("initial premium") || text.includes("ipp"))) {
    return [
      { label: "5. Insurance History (Gate 5)", actionType: "submit", payload: "Run insurance history check for this case" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "View Case", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("gate 5") || text.includes("insurance history")) {
    return [
      { label: "6. Medical Exam (Gate 6)", actionType: "submit", payload: "Assess medical examination for this case" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "View Case", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("gate 6") || text.includes("gates cleared") || text.includes("pre-underwriting") || text.includes("gate")) {
    return [
      { label: "Run Risk Assessment", actionType: "submit", payload: "Run risk assessment" },
      { label: "Check Status", actionType: "submit", payload: "Check pre-underwriting status" },
      { label: "View Case", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("assessment") && (text.includes("complete") || text.includes("triggered") || text.includes("done"))) {
    return [
      { label: "Move to review", actionType: "submit", payload: "Update case status to Under Review" },
      { label: "Upload documents", actionType: "submit", payload: "Upload required documents" },
      { label: "View results", actionType: "navigate", payload: "underwriting" },
    ];
  }
  if (text.includes("review")) {
    return [
      { label: "Approve case", actionType: "submit", payload: "Approve the case" },
      { label: "Decline case", actionType: "submit", payload: "Decline the case" },
      { label: "Request documents", actionType: "submit", payload: "Request more documents" },
    ];
  }
  if (text.includes("approved") || text.includes("rejected") || text.includes("declined")) {
    return [
      { label: "Pre-Issuance Verification", actionType: "submit", payload: "Verify pre-issuance requirements for this case" },
      { label: "Issue Policy", actionType: "submit", payload: "Issue the policy" },
      { label: "Close the case", actionType: "submit", payload: "Close the case" },
      { label: "Start new application", actionType: "submit", payload: "Add a new customer" },
    ];
  }
  if (text.includes("family group") && text.includes("created")) {
    return [
      { label: "View family", actionType: "navigate", payload: "admin/families" },
      { label: "Add another family", actionType: "submit", payload: "Add another family group" },
      { label: "View leads", actionType: "navigate", payload: "admin/customers" },
    ];
  }
  if (text.includes("organization") && text.includes("created")) {
    return [
      { label: "View organization", actionType: "navigate", payload: "admin/organizations" },
      { label: "Add another organization", actionType: "submit", payload: "Add another organization" },
      { label: "View leads", actionType: "navigate", payload: "admin/customers" },
    ];
  }
  return [
    { label: "Open Rule Engine ⚡", actionType: "navigate", payload: "admin/rule-engine" },
    { label: "Open Commission Engine ⚡", actionType: "navigate", payload: "commissions" },
    { label: "FinOps Token Economy ⚡", actionType: "navigate", payload: "super-admin/tokens" },
    { label: "View all cases", actionType: "navigate", payload: "underwriting" },
  ];
}

export function CopilotInterface() {
  const router = useRouter();
  const { notify } = useNotify();
  const { isAutomationMode, setAutomationMode } = useCopilot();

  // Tools like show_record answer with an explicit navigate instruction:
  // remember the target row, push the route, and the global record
  // highlighter pops it once the destination list has rendered.
  // The URL of the open inline case view, readable from callbacks that outlive a render.
  const casePanelUrlRef = useRef<string | null>(null);

  const handleAgentNavigate = useCallback(
    (route: string, entityId: string, highlight: boolean, embed?: boolean) => {
      if (highlight && entityId) {
        requestHighlight(entityId);
        triggerHighlight(entityId);
      }
      const path = route.startsWith('/') ? route : `/${route}`;
      const sep = path.includes('?') ? '&' : '?';
      const targetUrl = `${window.location.origin}${path}${sep}_portal=1`;
      if (embed) {
        // A case view that is open is a piece of work in progress (requirements being completed, documents being
        // uploaded). A reply from the model must not swap it for some other page; another case may replace it.
        const open = casePanelUrlRef.current;
        if (open && new URL(open).pathname.startsWith("/case/") && !path.startsWith("/case/")) return;
        // The journey pausing mid pre-underwriting is the one case that
        // should open the case view automatically, inline in the chat —
        // no click needed, since that's exactly the moment the user needs
        // to track/act on the 6 gates.
        setCasePanel({ url: targetUrl, title: routeLabel(route) });
      } else {
        window.open(targetUrl, "_blank");
      }
    },
    []
  );

  const { messages, send, resolveInterrupt, isLoading, pendingInterrupt, clearChat, loadChat, steps, turnActions, addAssistantMessage, recordSelection, regenerate } = useAgentChat({
    storageKey: STORAGE_KEY,
    welcomeMessage: WELCOME,
    onNavigate: handleAgentNavigate,
    // Demo data: the customer comes with a Draft proposal, so run the same
    // proposal steps as after the form. (Defined further down — see the ref.)
    onProposalJourney: (customerId, name, family) => startProposalJourneyRef.current?.(customerId, name, family),
    // Demo data for a Corporate: the same summary and "Continue" button the full-detail form leaves behind.
    onOrganizationEnrolled: (org) => announceOrganizationEnrolledRef.current?.(org),
    // A rewind brings the last kept message's buttons back to life, and what the page tracked about the dropped steps
    // (which family members were done, an open case view) no longer applies.
    onRewound: (lastKept) => {
      if (lastKept) setUsedActions((prev) => { const next = { ...prev }; delete next[lastKept]; return next; });
      familyDoneRef.current = new Set();
      setCasePanel(null);
    },
  });
  // A family is underwritten head first, then a fully insured spouse; the risk assessments run once both members'
  // requirements are in.
  const familyQueueRef = useRef<FamilyJourney["cases"]>([]);
  // Insured family members whose pre-underwriting requirements are complete.
  const familyDoneRef = useRef<Set<string>>(new Set());
  // The family being underwritten (for the report) and each insured member's risk-assessment outcome.
  type FamilyOutcome = { m: FamilyJourney["cases"][number]; decision: string; scores: any; status: "Approved" | "Needs review" | "Rejected"; assessedAt: string; already?: boolean };
  const familyMetaRef = useRef<{ name: string; familyGroupId?: string; familyPolicyId?: string }>({ name: "The family" });
  const familyResultsRef = useRef<FamilyOutcome[]>([]);
  const runFamilyAssessmentsRef = useRef<(() => void) | null>(null);
  const startProposalJourneyRef = useRef<((customerId: string, name: string, family?: FamilyJourney) => void) | null>(null);
  const announceOrganizationEnrolledRef = useRef<((org: EnrolledOrganization) => void) | null>(null);

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFileUrl, setSelectedFileUrl] = useState<string | null>(null);
  const [autoSubmitPrompt, setAutoSubmitPrompt] = useState("");
  const [riskSteps, setRiskSteps] = useState<ProcessStep[]>([]);
  const [uploadedDocs, setUploadedDocs] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const interruptRiskRef = useRef<boolean>(false);
  
  const [bulkSteps, setBulkSteps] = useState<ProcessStep[]>([]);
  const interruptBulkRef = useRef<boolean>(false);

  const [issuanceModalPolicy, setIssuanceModalPolicy] = useState<any | null>(null);
  const [successModalResult, setSuccessModalResult] = useState<{ result: IssuanceResult | PaymentConfirmResult, policyName: string, caseNumber: string, isPayment?: boolean } | null>(null);
  const [paymentModalPolicy, setPaymentModalPolicy] = useState<any | null>(null);
  const [acrModalCase, setAcrModalCase] = useState<{ caseId: string; caseNumber: string } | null>(null);
  const [ruleBuilderModalArgs, setRuleBuilderModalArgs] = useState<any | null>(null);
  // Inline case view for "navigate" actions — embeds the destination page via
  // iframe directly in the conversation instead of opening a new tab, so the
  // user tracks a case's gates, documents and results without leaving the chat.
  const [casePanel, setCasePanel] = useState<{ url: string; title: string } | null>(null);
  // Gate / document / decision actions taken through chat must show up in the
  // open case view. The iframe used to be reloaded on every new message, which
  // threw away whatever the user was doing in it (scroll position, open
  // sections, a half-filled form) at random moments. Now it stays mounted and is
  // just told to re-read its data; pages that don't listen simply keep what they
  // have.
  useEffect(() => { casePanelUrlRef.current = casePanel?.url ?? null; }, [casePanel]);
  const casePanelFrameRef = useRef<HTMLIFrameElement | null>(null);
  const casePanelScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollCasePanel = (dir: -1 | 1) =>
    casePanelScrollRef.current?.scrollBy({ left: dir * 360, behavior: "smooth" });
  useEffect(() => {
    if (!casePanel) return;
    casePanelFrameRef.current?.contentWindow?.postMessage(
      { source: "insurance-ai-copilot", type: "refresh" },
      window.location.origin
    );
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Proposal journey, run from the chat ───────────────────────────────────
  // Mirrors the manual Proposal page's workflow and its per-status options
  // (getAvailableActions in app/proposal/page.tsx) — one chat button per
  // option. Each is a direct API call with a fixed follow-up message, not a
  // model turn, so the steps can't be skipped or reordered.
  type ProposalStepId =
    | "submit" | "review" | "underwrite" | "request_info"
    | "back_draft" | "back_submitted" | "resubmit" | "return_review" | "reject";
  type ProposalState = "draft" | "submitted" | "review" | "info";
  // A family's proposal is one shared quote for the whole group; its member cases already exist,
  // so "Send to Underwriting" hands over to pre-underwriting on those cases instead of opening one.
  type ProposalBase = { customerId: string; quoteId: string; extraQuoteIds?: string[]; policyId: string; name: string; hasMissing: boolean; memberCases?: FamilyJourney["cases"] };
  // `from` is the state the buttons were offered in, so a cancelled action can offer them again.
  type ProposalStep = ProposalBase & { step: ProposalStepId; from: ProposalState };

  // What each button does: the status it sets and the state the proposal is in
  // afterwards (which decides the next set of buttons).
  const PROPOSAL_STEPS: Record<Exclude<ProposalStepId, "underwrite">, { label: string; status: string; to: ProposalState | null; done: string }> = {
    submit:         { label: "Submit Proposal",        status: "Proposed",             to: "submitted", done: "is now **Submitted**." },
    review:         { label: "Start Review",           status: "UnderReview",          to: "review",    done: "is now **Under Review**." },
    request_info:   { label: "Request Info",           status: "InformationRequested", to: "info",      done: "is now **Info Requested** — more information is needed." },
    back_draft:     { label: "Step Back to Draft",     status: "Quoted",               to: "draft",     done: "is back to **Draft**." },
    back_submitted: { label: "Step Back to Submitted", status: "Proposed",             to: "submitted", done: "is back to **Submitted**." },
    resubmit:       { label: "Re-Submit Proposal",     status: "Proposed",             to: "submitted", done: "is **Submitted** again." },
    return_review:  { label: "Return to Under Review", status: "UnderReview",          to: "review",    done: "is back **Under Review**." },
    reject:         { label: "Reject Proposal",        status: "Declined",             to: null,        done: "has been **Rejected**." },
  };
  // The options offered in each state, the main path first — same lists as the
  // Proposal page shows for Draft / Submitted / Under Review / Info Requested.
  const PROPOSAL_OPTIONS: Record<ProposalState, { ids: ProposalStepId[]; next: string }> = {
    draft:     { ids: ["submit", "request_info", "reject"],                         next: "Next step: submit the proposal." },
    submitted: { ids: ["review", "request_info", "back_draft", "reject"],           next: "Next step: start the review." },
    review:    { ids: ["underwrite", "request_info", "back_submitted", "reject"],   next: "Next step: send it to underwriting.\n\n⚠️ **Choose carefully** — once you send it to underwriting, you can't go back." },
    info:      { ids: ["resubmit", "return_review", "reject"],                      next: "Once the information is in, re-submit the proposal." },
  };
  // Sending a proposal to underwriting is for Underwriters and above. Everyone else (Agent, Broker,
  // Bancassurance, Corporate Agent, Walk-in, Digital, Viewer...) stops once the proposal is Under
  // Review: it goes to the admin team for further review, and these roles only follow its progress.
  const canHandOffToUnderwriting = () => {
    try { return ["Underwriter", "Admin", "SuperAdmin"].includes(localStorage.getItem("user_role") ?? ""); } catch { return false; }
  };
  const SENT_FOR_REVIEW =
    "✅ **Your proposal has been sent to the admin team for further review.** They will take it from here, and you can follow its progress under Proposals.";
  const proposalNext = (state: ProposalState) =>
    state === "review" && !canHandOffToUnderwriting() ? "" : PROPOSAL_OPTIONS[state].next;
  const proposalActions = (state: ProposalState, base: ProposalBase): QuickAction[] =>
    state === "review" && !canHandOffToUnderwriting()
      ? [
          { label: "View Proposals", actionType: "navigate", payload: "proposal" },
          { label: "Add another customer", actionType: "submit", payload: "Add a new customer" },
        ]
      : PROPOSAL_OPTIONS[state].ids
      .filter((step) => !(step === "submit" && base.hasMissing))
      .map((step) => ({
      label: step === "underwrite" ? "Send to Underwriting" : PROPOSAL_STEPS[step].label,
      actionType: "proposal_step",
      payload: JSON.stringify({ ...base, step, from: state }),
    }));

  // The summary shown under each step. Built from the live proposal (the same
  // data the Proposal page's detail window reads), so it follows what actually
  // happened and differs per status, like that window does.
  const PROPOSAL_TYPE_LABELS: Record<string, string> = {
    TERM_LIFE: "Term Life", WHOLE_LIFE: "Whole Life", ENDOWMENT: "Endowment / Savings Plan",
    CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan", GROUP_LIFE: "Group Life",
    SAVINGS: "Savings / Investment Plan", SINGLE_PREMIUM: "Single Premium Investment", HEALTH_CASH: "Hospital Cash / Health Plan",
  };
  const pkr = (n: number) => `Rs. ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const missingCustomerFields = (d: QuoteDetail) =>
    [
      !d.customer_dob && "Date of Birth",
      !d.customer_gender && "Gender",
      !d.customer_occupation && "Occupation",
      !d.customer_declared_income && "Annual Income",
    ].filter(Boolean) as string[];

  const proposalSummary = (d: QuoteDetail, state: ProposalState | "rejected"): string => {
    const type = PROPOSAL_TYPE_LABELS[d.insurance_type] ?? d.insurance_type;
    const figures =
      `- **Plan:** ${d.plan_label} (${type})\n` +
      `- **Sum assured:** ${pkr(d.coverage_amount)} over ${d.term_years} years\n` +
      `- **Annual premium:** ${pkr(d.total_premium)} (${pkr(d.base_premium)} + risk loading ${pkr(d.loading_applied)})`;
    const ref = `Ref ${d.quote_id.slice(0, 8).toUpperCase()}`;
    const missing = missingCustomerFields(d);
    const created = new Date(d.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

    if (state === "draft") {
      return (
        `**Proposal statement** · ${ref}\n\n` +
        `We are pleased to present the following insurance proposal for **${d.customer_name}**. Based on the information provided, we propose a **${type}** policy under the **${d.plan_label}** plan, providing a sum assured of **${pkr(d.coverage_amount)}** over a term of **${d.term_years} years**. ` +
        `The total annual premium for this coverage is **${pkr(d.total_premium)}** (expected premium of ${pkr(d.base_premium)} plus a risk of ${pkr(d.loading_applied)}). This proposal is valid subject to satisfactory underwriting assessment and is generated as of ${created}.` +
        (missing.length ? `\n\n⚠️ **Missing information** — complete this before the proposal can be submitted: ${missing.join(", ")}.` : "")
      );
    }
    if (state === "submitted") {
      return `**Submitted proposal** · ${ref}\n\n${figures}\n- **Customer:** ${d.customer_name} (${d.customer_cnic})\n\nIt is now waiting for review.`;
    }
    if (state === "review") {
      return (
        `**Proposal under review** · ${ref}\n\n${figures}\n` +
        `- **Assigned underwriter:** ${d.assigned_underwriter_name || "Unassigned"}\n\n` +
        (canHandOffToUnderwriting()
          ? `_Sending to underwriting opens an underwriting case for this exact proposal — documents, AI risk scoring and the final decision all happen there._`
          : SENT_FOR_REVIEW)
      );
    }
    if (state === "info") {
      return (
        `**Information requested** · ${ref}\n\n${figures}\n\n` +
        (missing.length
          ? `**Information still needed:** ${missing.join(", ")}. Complete it on the customer's profile, then re-submit.`
          : `No customer fields are missing — re-submit once the requested information has been received.`)
      );
    }
    return `**Rejected proposal** · ${ref}\n\n${figures}\n- **Customer:** ${d.customer_name} (${d.customer_cnic})`;
  };

  const startProposalJourney = useCallback(async (customerId: string, name: string, family?: FamilyJourney) => {
    // The quote row is written by a background worker just after the plan is
    // saved, so look for it for a short while.
    let quote: Awaited<ReturnType<typeof listQuotes>>[number] | undefined;
    let familyQuotes: Awaited<ReturnType<typeof listQuotes>> = [];
    // A life bundle gives each member their own proposal; a floater has one shared proposal.
    const expected = family?.isLifeBundle ? Math.max(family.cases.length, 1) : 1;
    for (let i = 0; i < 15; i++) {
      try {
        const all = (await listQuotes()).filter((q) => !q.quote_id.startsWith("draft-"));
        if (family) {
          familyQuotes = all.filter((q) => q.family_group_id === family.familyGroupId && (!family.familyPolicyId || q.family_policy_id === family.familyPolicyId));
          quote = familyQuotes[0];
          if (familyQuotes.length >= expected) break;
        } else {
          quote = all.find((q) => q.customer_id === customerId);
          if (quote) break;
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!quote) {
      addAssistantMessage(
        `✅ **${name}** has been registered, but the proposal isn't ready yet. Open **Proposal** in a moment to continue it.`,
        [{ label: "Open Proposals", actionType: "navigate", payload: "proposal" }]
      );
      return;
    }
    if (family) familyMetaRef.current = { name, familyGroupId: family.familyGroupId, familyPolicyId: family.familyPolicyId };
    const detail = await getQuote(quote.quote_id).catch(() => null);
    const base: ProposalBase = {
      customerId: quote.customer_id, quoteId: quote.quote_id, policyId: quote.policy_id, name,
      extraQuoteIds: familyQuotes.slice(1).map((q) => q.quote_id),
      hasMissing: detail ? missingCustomerFields(detail).length > 0 : false,
      memberCases: family?.cases,
    };
    addAssistantMessage(
      `✅ **${name}** has been registered and the ${family ? "family " : ""}proposal is created as a **Draft**.\n\n` +
        (detail ? `${proposalSummary(detail, "draft")}\n\n` : "") +
        PROPOSAL_OPTIONS.draft.next,
      proposalActions("draft", base)
    );
  }, [addAssistantMessage]);

  // A corporate that is saved and enrolled — whether entered in the full-detail form or generated as demo data —
  // ends with the same summary and buttons, so the group scheme carries on identically from here.
  const announceOrganizationEnrolled = useCallback((d: EnrolledOrganization) => {
    const org = d.name || "The corporate";
    const classes = d.class_count ? `${d.class_count} benefit classes` : "benefit classes";
    addAssistantMessage(
      `✅ **${org}** has been registered with its **${d.plan_label ?? "group"}** policy, ${d.demo ? classes : "benefit classes"} and **${d.employee_count ?? 0} employees**${d.demo ? " (demo data)" : ""}.\n\n` +
        `The scheme is enrolled and waiting for a quote. Shall I carry on — price it, then record the employer's acceptance, issue the master policy and collect the payment?`,
      [
        // The id is what makes this the corporate that was just saved — companies can share a name.
        { label: "Continue the group scheme", actionType: "submit",
          payload: `Continue the group scheme journey for ${org} (organization id ${d.organization_id})` },
        { label: "Open the corporate", actionType: "navigate", payload: `admin/organizations/${d.organization_id}` },
      ],
      // Shown as a table under the message, like a family's enrolled members.
      d.employees?.length ? { organizationEmployees: d.employees } : undefined
    );
  }, [addAssistantMessage]);
  announceOrganizationEnrolledRef.current = announceOrganizationEnrolled;

  startProposalJourneyRef.current = startProposalJourney;

  const runProposalStep = useCallback(async (p: ProposalStep) => {
    const { step, from, ...base } = p;
    try {
      if (step === "underwrite" && p.memberCases?.length) {
        // Family: the head and — if the family chose it — an insured spouse already have underwriting cases from
        // enrolment. They are worked in this order: the head's 7 requirements first, then the spouse's.
        // Nominees have no cover and no underwriting.
        const ordered = [...p.memberCases.filter((c) => c.relationship === "Self"), ...p.memberCases.filter((c) => c.relationship !== "Self")];
        familyQueueRef.current = ordered;
        familyDoneRef.current = new Set();
        const [first, ...rest] = ordered;
        const role = (c: { relationship: string }) => (c.relationship === "Self" ? "head" : "fully insured spouse");
        addAssistantMessage(
          `**${p.name}**'s proposal has been **sent to underwriting** — case **${first.case_number}** (${first.name}, ${role(first)}) is open.` +
            (rest.length ? ` ${rest.map((c) => `**${c.name}** (${role(c)}, case ${c.case_number})`).join(", ")} ${rest.length === 1 ? "follows" : "follow"} once ${first.name}'s requirements are complete — the risk assessment runs after both.` : "") + `\n\n` +
            `Underwriting has 7 requirements (documents, e-application, agent report, PEP & sanctions screening, initial premium, insurance history and medical examination). How would you like to work through them?\n\n` +
            `- **Guide me step by step** — I'll take you through them one at a time, explaining each.\n` +
            `- **Open the case workspace** — see all 7 together and complete them yourself on the case page.`,
          [
            { label: `Guide me step by step — ${first.name}`, actionType: "uw_requirements", payload: JSON.stringify({ caseId: first.case_id, caseNo: first.case_number }) },
            { label: `Open the case workspace — ${first.name}`, actionType: "embed", payload: `case/${first.case_id}` },
          ]
        );
        return;
      }
      if (step === "underwrite") {
        const tenantId = localStorage.getItem("tenant_id");
        const res = await api.post(`/tenants/${tenantId}/cases`, {
          customer_id: p.customerId,
          policy_id: p.policyId,
          caseType: "Underwriting",
          sourceChannel: "Online",
        });
        const caseId = res.data.caseld;
        const caseNo = res.data.caseNumber || p.name;
        // Two ways to carry on, both ending in the same underwriting. Named for
        // what the user gets rather than how it is built.
        addAssistantMessage(
          `**${p.name}**'s proposal has been **sent to underwriting** — case **${caseNo}** is open.\n\n` +
            `Underwriting has 7 requirements (documents, e-application, agent report, PEP & sanctions screening, initial premium, insurance history and medical examination). How would you like to work through them?\n\n` +
            `- **Guide me step by step** — I'll take you through them one at a time, explaining each.\n` +
            `- **Open the case workspace** — see all 7 together and complete them yourself on the case page.`,
          [
            { label: "Guide me step by step", actionType: "uw_requirements", payload: JSON.stringify({ caseId, caseNo }) },
            // A family member's case must not start its own assessment the moment its gates clear: the assessments run
            // together after every insured member's underwriting (head, then spouse) is in.
            { label: "Open the case workspace", actionType: "embed", payload: `case/${caseId}${familyQueueRef.current.some((c) => c.case_id === caseId) ? "" : "?autoRun=true"}` },
          ]
        );
        return;
      }
      const def = PROPOSAL_STEPS[step];
      if (step === "reject" && !window.confirm(`Reject ${p.name}'s proposal? This cannot be undone.`)) {
        addAssistantMessage(`Okay — **${p.name}**'s proposal was not rejected. ${proposalNext(from)}`, proposalActions(from, base));
        return;
      }
      await Promise.all([p.quoteId, ...(p.extraQuoteIds ?? [])].map((id) => updateQuote(id, { status: def.status })));
      const detail = await getQuote(p.quoteId).catch(() => null);
      const fresh: ProposalBase = { ...base, hasMissing: detail ? missingCustomerFields(detail).length > 0 : base.hasMissing };
      if (def.to) {
        addAssistantMessage(
          `**${p.name}**'s proposal ${def.done}\n\n` +
            (detail ? `${proposalSummary(detail, def.to)}\n\n` : "") +
            proposalNext(def.to),
          proposalActions(def.to, fresh)
        );
      } else {
        addAssistantMessage(`**${p.name}**'s proposal ${def.done}\n\n${detail ? `${proposalSummary(detail, "rejected")}\n\n` : ""}No further steps for this proposal.`, [
          { label: "Add another customer", actionType: "submit", payload: "Add a new customer" },
          { label: "View Proposals", actionType: "navigate", payload: "proposal" },
        ]);
      }
    } catch (err: any) {
      addAssistantMessage(
        `⚠️ Couldn't complete that step: ${err?.response?.data?.detail ?? err?.message ?? "unknown error"}. You can try again.`,
        [{ label: step === "underwrite" ? "Send to Underwriting" : PROPOSAL_STEPS[step].label, actionType: "proposal_step", payload: JSON.stringify(p) }]
      );
    }
  }, [addAssistantMessage]);

  // Reverse direction of the sync above: the embedded case page (see
  // case/[id]/page.tsx's notifyParentPortal) posts a message here whenever
  // something meaningful happens inside the iframe — a document upload, all
  // gates clearing. Follow up in the chat automatically so the AI reports
  // what changed and what's next, instead of the action going unremarked
  // just because it happened inside the embed rather than via a chat click.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.source !== "insurance-ai-portal") return;
      if (!casePanel || isLoading) return;
      if (event.data.type === "quick_lead_saved") {
        // A quick lead is complete the moment it's saved — close the form and
        // confirm in the chat. Explicit actions are passed so the previous
        // turn's chips (e.g. "Add demo data") don't resurface under this reply.
        setCasePanel(null);
        addAssistantMessage(
          `✅ Quick lead saved. ${event.data.message || "The lead's information has been stored."} You can complete the full profile later from the Leads page.`,
          [
            { label: "Add another customer", actionType: "submit", payload: "Add a new customer" },
            { label: "View Leads", actionType: "navigate", payload: "admin/leads" },
          ]
        );
      } else if (event.data.type === "customer_saved") {
        // The form's job ends here — it only collected the details (including
        // the plan). Close it and run the proposal in the chat, step by step.
        setCasePanel(null);
        const { id, name } = event.data as { id?: string; name?: string };
        if (id) startProposalJourney(id, name || "The customer");
      } else if (event.data.type === "family_members_enrolled") {
        // The family form's job ends once its members are enrolled — close it and carry on in the
        // chat with the proposal steps, then pre-underwriting, just like after "Add demo data".
        setCasePanel(null);
        const d = event.data as { family_group_id: string; family_policy_id?: string; name?: string; is_life_bundle?: boolean; cases?: FamilyJourney["cases"] };
        const cases = d.cases ?? [];
        startProposalJourney("", d.name || "The family", {
          familyGroupId: d.family_group_id, familyPolicyId: d.family_policy_id, isLifeBundle: d.is_life_bundle,
          caseNumbers: cases.map((c) => c.case_number), cases,
        });
      } else if (event.data.type === "organization_enrolled") {
        // The corporate form's job ends once the census is enrolled — close it and carry on with the
        // group scheme in the chat (quote, acceptance, issuance), which resumes from the scheme's status.
        setCasePanel(null);
        announceOrganizationEnrolledRef.current?.(event.data as EnrolledOrganization);
      } else if (event.data.type === "document_uploaded") {
        // The case view is open and already re-reads its own checklist after an upload. Asking the model to
        // "re-check" sent it off on a turn whose tools navigate — which swapped this panel for another page
        // in the middle of the requirements. Leave the panel where it is; the page refreshes itself.
        casePanelFrameRef.current?.contentWindow?.postMessage({ source: "insurance-ai-copilot", type: "refresh" }, window.location.origin);
      } else if (event.data.type === "gates_cleared") {
        // All 6 gates are done — the case view has nothing further for the
        // user to act on there, so close it and hand off to the chat rather
        // than leaving an inert embed open under the next question.
        //
        // This is injected directly rather than asked of the model: an LLM
        // told "present exactly these two buttons" can still narrate them as
        // plain text instead of actually producing clickable quick_actions —
        // this outcome is already known deterministically (the gates really
        // did just clear), so there's nothing for the model to decide here.
        const caseRef = event.data.caseId;
        const queue = familyQueueRef.current;
        const at = queue.findIndex((c) => c.case_id === caseRef || c.case_number === caseRef);
        if (at >= 0) {
          // A family: the head and a fully insured spouse are underwritten on the same workspace, one tab each.
          // Stay on it until every insured member's requirements are in, then hand over to the chat.
          familyDoneRef.current.add(queue[at].case_id);
          const remaining = queue.filter((c) => !familyDoneRef.current.has(c.case_id));
          if (remaining.length > 0) {
            const next = remaining[0];
            addAssistantMessage(
              `**${queue[at].name}**'s requirements are complete. Continuing with **${next.name}** (${next.relationship === "Self" ? "head" : "fully insured spouse"}) — their tab is open now.`
            );
            setCasePanel({ url: `${window.location.origin}/case/${next.case_id}?_portal=1`, title: `Case · ${next.name}` });
            return;
          }
          setCasePanel(null);
          addAssistantMessage(`All underwriting requirements are complete for ${queue.map((c) => `**${c.name}**`).join(" and ")}. Running the risk assessment for each insured member now.`);
          runFamilyAssessmentsRef.current?.();
          return;
        }
        setCasePanel(null);
        addAssistantMessage(
          "All 6 pre-underwriting gates have cleared for this case. Would you like to proceed with the AI underwriting now?",
          [
            { label: "Run AI Underwriting", actionType: "submit", payload: `Run risk assessment for case ${caseRef}` },
            { label: "Cancel", actionType: "submit", payload: "Not right now — I'll run the risk assessment later." },
          ]
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [casePanel, isLoading, send, addAssistantMessage, startProposalJourney]);

  useEffect(() => {
    if (selectedFile && selectedFile.type.startsWith("image/")) {
      const url = URL.createObjectURL(selectedFile);
      setSelectedFileUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setSelectedFileUrl(null);
    }
  }, [selectedFile]);
  const [suggestedActions, setSuggestedActions] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY + "_suggestions");
        if (saved) return JSON.parse(saved);
      } catch { }
    }
    return [];
  });

  // Live clock for the phone status bar
  const [clock, setClock] = useState("");
  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chunksRef = useRef<Blob[]>([]);
  const selectedFileRef = useRef<File | null>(null);
  // Args for a directly-triggered upload (from a quick-action "Upload {doc}"
  // suggestion, which already knows document_type + cnic precisely) — as
  // opposed to an agent-initiated upload_document tool call, which arrives via
  // pendingInterrupt.kind === "client_execute" instead.
  const pendingUploadRef = useRef<
    { document_type: string; cnic?: string; claim_id?: string; claim_number?: string } | null
  >(null);

  // ── Underwriting requirements, shown from the chat ────────────────────────
  // The 7 prerequisites the case page's checklist shows (documents + the six
  // clearance gates), read straight from the case and rendered here with the
  // next one's button — not relayed through the model, so the list and its
  // buttons are always there. Gate actions still run as normal chat requests.
  const showUnderwritingRequirements = useCallback(async (caseId: string, caseNo?: string) => {
    try {
      const tenantId = localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID;
      const res = await api.get(`/tenants/${tenantId}/cases/${caseId}/detail`);
      const d = res.data;
      const no: string = caseNo || d.case?.caseNumber || caseId;
      // After a reload the family queue in memory is gone; rebuild it from the case itself (head first, then the spouse),
      // so a family member is never assessed on their own.
      if ((d.family_members?.length ?? 0) > 1 && !familyQueueRef.current.some((c) => c.case_id === caseId)) {
        familyQueueRef.current = [...d.family_members]
          .map((m: any) => ({ case_id: m.case_id, case_number: m.case_number, name: m.name, relationship: /^self$/i.test(String(m.relationship)) ? "Self" : "Spouse" }))
          .sort((a, b) => Number(b.relationship === "Self") - Number(a.relationship === "Self"));
        familyDoneRef.current = new Set();
      }
      const pre = d.pre_underwriting_status || {};
      const missingDocs: string[] = d.document_checklist?.missing ?? [];
      const eApp = pre.e_application ?? "NotStarted", acr = pre.acr ?? "NotStarted", comp = pre.compliance ?? "NotRun";
      const ipp = pre.ipp ?? "NotStarted", hist = pre.insurance_history ?? "NotStarted", med = pre.medical_exam ?? "NotAssessed";

      const reqs: { name: string; status: string; ok: boolean; detail: string }[] = [
        { name: "Mandatory Documents Checklist", status: missingDocs.length ? `Missing (${missingDocs.length})` : "Complete", ok: missingDocs.length === 0,
          detail: missingDocs.length ? `Missing required document(s): ${missingDocs.join(", ")}.` : "All required documents are uploaded." },
        { name: "Customer E-Application Questionnaire", status: eApp, ok: eApp === "Verified",
          detail: "The customer's health disclosures questionnaire — send the link, then verify it once submitted." },
        { name: "Agent's Confidential Report (ACR)", status: acr, ok: acr === "Submitted",
          detail: d.family_head_case ? `Filed once for the whole family (recorded on the head's case ${d.family_head_case.case_number}) — one proposer, one report.` : "The agent's own confidential assessment of the applicant, to be filed." },
        { name: "PEP & Sanctions Screening", status: comp, ok: ["Passed", "Cleared"].includes(comp),
          detail: "PEP and AML screening of the applicant against watchlists." },
        { name: "Initial Premium Payment (IPP)", status: ipp, ok: ipp === "Realized",
          detail: d.family_head_case ? `Paid once for the whole family policy (recorded on the head's case ${d.family_head_case.case_number}).` : "Collect the initial premium payment so cover can start." },
        { name: "Insurance History Clearance", status: hist, ok: ["Clear", "Cleared"].includes(hist),
          detail: "Prior policy coverage and over-insurance history check." },
        { name: "Medical Examination / NML Grid", status: med, ok: ["Completed", "Waived", "NotRequired"].includes(med),
          detail: "Non-medical limit grid or panel diagnostic check, depending on the cover amount." },
      ];
      const doneCount = reqs.filter((r) => r.ok).length;
      const icon = (r: { ok: boolean; status: string }) => (r.ok ? "✅" : /flag|fail|reject/i.test(r.status) ? "❌" : "⏳");
      const list = reqs.map((r, i) => `${icon(r)} **${i + 1}. ${r.name}** — \`${r.status}\`  \n   _${r.detail}_`).join("\n\n");

      const workspace: QuickAction = { label: "Open the case workspace", actionType: "embed", payload: `case/${caseId}` };
      const act = (label: string, payload: string): QuickAction => ({ label, actionType: "submit", payload });
      let actions: QuickAction[];
      let footer: string;
      if (reqs.every((r) => r.ok)) {
        footer = "**All 7 requirements are complete.** The case is ready for AI underwriting.";
        actions = [act("Run AI Underwriting", `Run risk assessment for case ${no}`), workspace];
        // A family's next insured member (the spouse) is underwritten once this one's requirements are in.
        const queue = familyQueueRef.current;
        const at = queue.findIndex((c) => c.case_id === caseId);
        const next = at >= 0 ? queue[at + 1] : undefined;
        if (at >= 0) familyDoneRef.current.add(caseId);
        // In a family one member is never assessed alone: the assessments run together once everyone's requirements are in.
        if (at >= 0 && queue.length > 1) actions = actions.filter((a) => a.label !== "Run AI Underwriting");
        if (next) {
          footer += `\n\n👉 **Next member:** ${next.name} (${next.relationship === "Self" ? "head" : "fully insured spouse"}) — their underwriting starts now.`;
          actions.push({ label: `Underwrite ${next.name}`, actionType: "uw_requirements", payload: JSON.stringify({ caseId: next.case_id, caseNo: next.case_number }) });
        } else if (at >= 0 && queue.length > 1 && queue.every((c) => familyDoneRef.current.has(c.case_id))) {
          // Everyone insured has their requirements in: assess them all together rather than just this member.
          footer += `\n\n👉 **Every insured member's requirements are complete** — assess them together.`;
          actions = [{ label: "Run risk assessment — all insured members", actionType: "family_assess", payload: "{}" }, workspace];
        }
      } else if (!reqs[0].ok) {
        footer = "👉 **Next — requirement 1 of 7:** upload the missing documents.";
        actions = [{
          label: "Upload Documents", actionType: "upload",
          payload: JSON.stringify({ document_types: missingDocs, case_id: caseId, case_number: no, cnic: d.customer?.cnic || "" }),
        }, workspace];
      } else if (!reqs[1].ok) {
        footer = "👉 **Next — requirement 2 of 7:** send the e-application link to the customer.";
        actions = [act("Generate E-App Link", `Generate e-application link for case ${no}`)];
        if (eApp === "Submitted") actions.push(act("Verify E-Application", `Verify e-application for case ${no} action verify`));
        actions.push(workspace);
      } else if (!reqs[2].ok) {
        footer = "👉 **Next — requirement 3 of 7:** file the agent's confidential report.";
        actions = [act("File ACR", `Submit agent confidential report for case ${no}`), workspace];
      } else if (!reqs[3].ok) {
        footer = "👉 **Next — requirement 4 of 7:** run the PEP and sanctions screening.";
        actions = [act("Run PEP Check", `Run compliance screening for case ${no}`), workspace];
      } else if (!reqs[4].ok) {
        footer = "👉 **Next — requirement 5 of 7:** collect the initial premium payment.\n\n⚠️ **Choose carefully** — a collected premium can't be undone from here.";
        actions = [act("Collect Premium", `Process initial premium payment for case ${no}`), workspace];
      } else if (!reqs[5].ok) {
        footer = "👉 **Next — requirement 6 of 7:** run the insurance history check.";
        actions = [act("Run History Check", `Run insurance history check for case ${no}`), workspace];
      } else {
        footer = "👉 **Next — requirement 7 of 7:** assess the medical examination requirement.";
        actions = [act("Assess Medical", `Assess medical examination for case ${no}`), workspace];
      }
      addAssistantMessage(`### Underwriting requirements for case **${no}** — ${doneCount} / 7 ready\n\n${list}\n\n${footer}`, actions);
    } catch (err: any) {
      addAssistantMessage(`⚠️ Couldn't load the underwriting requirements: ${err?.response?.data?.detail ?? err?.message ?? "unknown error"}.`, [
        { label: "Try again", actionType: "uw_requirements", payload: JSON.stringify({ caseId, caseNo }) },
      ]);
    }
  }, [addAssistantMessage]);

  // Popup for a case's required documents (one slot per document type), opened
  // by an "Upload Documents" button whose payload lists the types.
  const [docDialog, setDocDialog] = useState<{ case_id: string; case_number?: string; document_types: string[] } | null>(null);

  const handleDocDialogDone = useCallback(async (result: DocumentUploadResult) => {
    const d = docDialog;
    setDocDialog(null);
    if (!d) return;
    if (result.uploaded.length) setUploadedDocs((prev) => [...prev, ...result.uploaded]);
    const lines: string[] = [];
    if (result.uploaded.length) lines.push(`✅ Uploaded: ${result.uploaded.join(", ")}.`);
    if (result.failed.length) lines.push(`⚠️ Couldn't upload: ${result.failed.map((f) => `${f.type} (${f.reason})`).join("; ")}.`);
    if (lines.length) addAssistantMessage(lines.join("\n\n"));
    // Then straight on to whatever is next (or the remaining documents).
    await showUnderwritingRequirements(d.case_id, d.case_number);
  }, [docDialog, addAssistantMessage, showUnderwritingRequirements]);

  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth"
      });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages, steps]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY + "_suggestions", JSON.stringify(suggestedActions));
  }, [suggestedActions]);

  // ── Document upload — the one tool the browser must execute itself, since
  // it's the only place holding the attached File object (see graph.py's
  // CLIENT_EXECUTED_TOOLS / permission_gate's "client_execute" interrupt kind).
  const uploadDocument = useCallback(async (
    args: { document_type: string; cnic?: string; applicant_name?: string; claim_id?: string; claim_number?: string; case_number?: string; case_id?: string },
    file: File,
  ) => {
    const tenantId = localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID;

    // Claim documents hang off the claim, not the case — different endpoint,
    // different route to send the user to afterwards. The agent resolves the
    // claim server-side and hands the id down, so there is nothing to look up.
    if (args.claim_id) {
      const claimForm = new FormData();
      claimForm.append("document_type", args.document_type);
      claimForm.append("file", file);
      await api.post(`/tenants/${tenantId}/claims/${args.claim_id}/artifacts`, claimForm, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const claimRoute = `claims/${args.claim_id}`;
      const ref = args.claim_number || args.claim_id;
      return {
        success: true,
        message: `${args.document_type} (${file.name}) attached to claim ${args.claim_number || ""}.`,
        last_action: {
          tool_name: "upload_claim_document",
          entity_type: "claim",
          entity_id: args.claim_id,
          route: claimRoute,
          label: `${args.document_type} attached`,
        },
        quick_actions: [
          { label: "View claim file", actionType: "navigate", payload: claimRoute },
          { label: "What's still missing?", actionType: "submit", payload: `What documents are missing on claim ${ref}?` },
          { label: "Continue the claim", actionType: "submit", payload: `Continue the claims journey for ${ref}` },
        ],
      };
    }

    const list = await api.get(`/tenants/${tenantId}/cases`);
    const c = list.data.find((c: any) => {
      if (args.case_id && (c.caseld === args.case_id || c.id === args.case_id)) return true;
      if (args.case_number && c.caseNumber === args.case_number) return true;
      if (args.cnic && c.customer_cnic === args.cnic) return true;
      if (!args.applicant_name) return false;
      const n = args.applicant_name.toLowerCase();
      const fullName = `${c.applicant_name || ""} ${c.customer_name || ""}`.trim().toLowerCase();
      return fullName.includes(n) || c.applicant_name?.toLowerCase().includes(n) || c.customer_name?.toLowerCase().includes(n);
    });
    if (!c) throw new Error("No case found for this applicant.");
    const form = new FormData();
    form.append("document_type", args.document_type);
    form.append("file", file);
    await api.post(`/tenants/${tenantId}/cases/${c.caseld}/artifacts`, form, { headers: { "Content-Type": "multipart/form-data" } });

    if (args.document_type) {
      setUploadedDocs((prev) => Array.from(new Set([...prev, args.document_type])));
    }

    // Rich result: when this resumes the graph, the SSE pipeline re-emits
    // last_action (toast + navigate + highlight) and quick_actions (the
    // recommendation chips) exactly as if a server-side tool had run.
    const caseRoute = `cases?case_id=${c.caseld}`;
    const who = args.cnic || args.applicant_name || "";
    return {
      success: true,
      message: `${args.document_type} (${file.name}) uploaded to case ${c.caseNumber || ""}.`,
      last_action: {
        tool_name: "upload_document",
        entity_type: "case",
        entity_id: c.caseld,
        route: caseRoute,
        label: `${args.document_type} uploaded`,
      },
      quick_actions: [
        { label: "View Documents", actionType: "navigate", payload: caseRoute },
        { label: "Check remaining documents", actionType: "submit", payload: `What documents are still needed for ${who}?` },
        { label: "Run Risk Assessment", actionType: "submit", payload: `Run risk assessment for ${who}` },
      ],
    };
  }, []);

  // Set while an agent-initiated upload (client_execute interrupt) is waiting
  // for the user to choose a file — the file input's onChange completes it.
  const interruptUploadRef = useRef<{ args: any } | null>(null);

  // An agent-initiated upload_document call arrives as a "client_execute"
  // interrupt once the user has confirmed it. If a file is already attached,
  // upload straight away; otherwise pop the browser's file picker so the user
  // can hand one over without leaving the chat — the whole upload then runs
  // automatically and the graph resumes with the result.
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    if (!["upload_document", "upload_claim_document"].includes(pendingInterrupt.toolCall.name)) return;
    const file = selectedFileRef.current;
    if (!file) {
      interruptUploadRef.current = { args: pendingInterrupt.toolCall.args };
      notify("📎 Choose the file to upload — I'll handle the rest.", true);
      fileInputRef.current?.click();
      return;
    }
    (async () => {
      try {
        const result = await uploadDocument(pendingInterrupt.toolCall.args as any, file);
        setSelectedFile(null);
        resolveInterrupt(result);
      } catch (e: any) {
        resolveInterrupt({ success: false, error: e.message || "Upload failed." });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInterrupt]);

  // Runs one case through the risk engine, streaming its live steps into the progress graph. Shared by the single-case
  // assessment below and by the family run (every insured member in turn). Throws when the engine rejects the input;
  // `blockedGate` is set when mandatory requirements stop the assessment.
  const streamAssessment = useCallback(async (payload: { customer: any; policy: any; case_id: string }) => {
    const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
    const finalScores: any = {};
    let finalDecision = "";
    let blockedGate: any = null;
    const updateStep = (id: string, label: string, status: "active" | "done" | "error") => {
      setRiskSteps(prev => {
        const copy = [...prev];
        const idx = copy.findIndex(st => st.id === id);
        if (idx >= 0) copy[idx] = { id, label, status };
        else copy.push({ id, label, status });
        return copy;
      });
    };
    setRiskSteps([{ id: "medical", label: "Analyzing medical history", status: "active" }]);

    const res = await fetch(`${API_BASE}/evaluate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Stream failed");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    stream: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        let evt: any;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === "progress") {
          const node = evt.node;
          const data = evt.data || {};
          if (node === "medical_scoring") {
            updateStep("medical", "Analyzing medical history", "done");
            updateStep("financial", "Evaluating financial profile", "active");
            finalScores.medical_score = data.medical_score;
            finalScores.medical_reasons = data.medical_reasons ?? [];
          } else if (node === "financial_scoring") {
            updateStep("financial", "Evaluating financial profile", "done");
            updateStep("fraud", "Checking fraud signals", "active");
            finalScores.financial_score = data.financial_score;
            finalScores.financial_reasons = data.financial_reasons ?? [];
          } else if (node === "fraud_detection") {
            updateStep("fraud", "Checking fraud signals", "done");
            updateStep("decision", "Calculating composite risk", "active");
            finalScores.fraud_probability = data.fraud_probability;
            finalScores.fraud_reasons = data.fraud_reasons ?? [];
          } else if (node === "decision_engine") {
            updateStep("decision", "Calculating composite risk", "done");
            finalScores.composite_risk_score = data.composite_risk_score;
            finalDecision = data.ai_decision;
            finalScores.reasons = data.reasons ?? [];
          }
        } else if (evt.type === "pending_requirements") {
          updateStep("decision", "Mandatory requirements not yet satisfied", "error");
          blockedGate = evt.data || {};
          break stream;
        } else if (evt.type === "invalid" || evt.type === "error") {
          updateStep("error", "Assessment failed", "error");
          throw new Error(evt.errors?.length ? evt.errors.join("; ") : (evt.message || "Validation failed"));
        }
      }
    }
    return { finalScores, finalDecision, blockedGate };
  }, []);

  // Client-executed risk assessment (so we can stream the live steps to the UI)
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    if (pendingInterrupt.toolCall.name !== "run_risk_assessment") return;
    
    if (interruptRiskRef.current) return;
    interruptRiskRef.current = true;
    
    setRiskSteps([
      { id: "medical", label: "Analyzing medical history", status: "active" }
    ]);
    
    const args = pendingInterrupt.toolCall.args;
    
    (async () => {
      try {
        const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
        const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
        
        const payload = {
          customer: args.customer,
          policy: args.policy,
          case_id: args.case_id,
        };

        const { finalScores, finalDecision, blockedGate } = await streamAssessment(payload);

        if (blockedGate) {
          resolveInterrupt(buildRequirementsBlockedResult(blockedGate, args.case_id, args.case_number));
          return;
        }

        const summary = `I've completed the underwriting risk assessment for **${args.case_id}**.\n- Medical: ${finalScores.medical_score ?? '—'}/100\n- Financial: ${finalScores.financial_score ?? '—'}/100\n- Fraud: ${finalScores.fraud_probability ?? '—'}\n- **Decision: ${finalDecision}**\n\nWould you like to **proceed** with these results, or **decline**?`;
        const results_route = `case/${args.case_id}`;

        resolveInterrupt({
          success: true,
          message: summary,
          assessment: {
            scores: finalScores,
            ai_decision: finalDecision,
            case_id: args.case_id,
            reasons: finalScores.reasons ?? [],
            medical_reasons: finalScores.medical_reasons ?? [],
            financial_reasons: finalScores.financial_reasons ?? [],
            fraud_reasons: finalScores.fraud_reasons ?? [],
          },
          last_action: {
            toolName: "run_risk_assessment",
            entityType: "case",
            entityId: args.case_id,
            route: results_route,
            label: "Risk assessment complete"
          },
          quick_actions: [
            { label: "Proceed", actionType: "submit", payload: `Approve case ${args.case_id} based on the risk assessment results` },
            { label: "Decline", actionType: "submit", payload: `Reject case ${args.case_id} based on the risk assessment results` },
            { label: "View Results", actionType: "navigate", payload: results_route },
            { label: "Download Report", actionType: "download", payload: args.case_id },
          ]
        });
      } catch (err: any) {
        resolveInterrupt({ success: false, message: `Assessment failed: ${err.message}` });
      } finally {
        interruptRiskRef.current = false;
        setRiskSteps([]);
      }
    })();
  }, [pendingInterrupt, resolveInterrupt, streamAssessment]);
  // Client-executed bulk underwriting journey
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    if (pendingInterrupt.toolCall.name !== "bulk_underwriting_journey") return;
    
    if (interruptBulkRef.current) return;
    interruptBulkRef.current = true;
    
    const cnics = pendingInterrupt.toolCall.args.cnics || [];
    setBulkSteps(cnics.map((c: string) => ({ id: c, label: `Processing ${c}`, status: "pending" })));
    
    (async () => {
      try {
        const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
        const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
        
        // Remove /api from API_BASE because chat API runs on 8003
        // Actually, we'll use the Chat agent URL directly for this stream.
        const chatAgentUrl = process.env.NEXT_PUBLIC_CHAT_API_URL ?? "http://localhost:8003";

        const res = await fetch(`${chatAgentUrl}/bulk-underwriting/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId },
          body: JSON.stringify({ cnics }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error("No stream reader available");

        let buffer = "";
        let finalMessage = "Processed bulk underwriting journey.\n";
        let missingUploadActions: QuickAction[] = [];
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          
          for (let p of parts) {
            p = p.trim();
            if (!p.startsWith("data: ")) continue;
            
            try {
              const evt = JSON.parse(p.slice(6));
              
              if (evt.type === "progress") {
                setBulkSteps(prev => prev.map(s => 
                  s.id === evt.cnic ? { ...s, status: "active", label: `${evt.step} for ${evt.cnic}` } : s
                ));
              } else if (evt.type === "warning") {
                setBulkSteps(prev => prev.map(s => 
                  s.id === evt.cnic ? { ...s, status: "error", label: `Missing docs for ${evt.cnic}` } : s
                ));
                finalMessage += `\n❌ **${evt.cnic}**: Missing ${evt.missing.length} documents.`;
                evt.missing.slice(0, 3).forEach((doc: string) => {
                  missingUploadActions.push({
                    label: `Upload ${doc} (${evt.cnic})`,
                    actionType: "upload",
                    payload: JSON.stringify({ document_type: doc, cnic: evt.cnic })
                  });
                });
              } else if (evt.type === "error") {
                setBulkSteps(prev => prev.map(s => 
                  s.id === evt.cnic ? { ...s, status: "error", label: `Error: ${evt.message}` } : s
                ));
                finalMessage += `\n❌ **${evt.cnic}**: Failed - ${evt.message}`;
              } else if (evt.type === "done") {
                setBulkSteps(prev => prev.map(s => 
                  s.id === evt.cnic ? { ...s, status: "done", label: `Completed ${evt.cnic}` } : s
                ));
                const d = evt.result.ai_decision || "Unknown";
                finalMessage += `\n✅ **${evt.cnic}**: Case ${evt.caseNumber} opened. Decision: **${d}**`;
              }
            } catch (e) {
              console.warn("Failed to parse SSE event", p, e);
            }
          }
        }
        
        resolveInterrupt({
          success: true,
          message: finalMessage,
          quick_actions: [
            ...missingUploadActions,
            { label: "View Cases", actionType: "navigate", payload: "cases" }
          ]
        });
      } catch (err: any) {
        resolveInterrupt({ success: false, message: `Bulk processing failed: ${err.message}` });
      } finally {
        interruptBulkRef.current = false;
        setBulkSteps([]);
      }
    })();
  }, [pendingInterrupt, resolveInterrupt]);

  // Commission tools run in the browser — the payee registry, waterfall,
  // ledger and payout runs live in app/services/commissions.ts because there
  // is no commission backend yet. chat-agent resolves what it can server-side
  // and hands the rest here through the same client_execute interrupt.
  const commissionRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    const name = pendingInterrupt.toolCall.name;
    if (!isCommissionTool(name)) return;
    // Guard against the effect re-firing for the same pending interrupt and
    // running a payout twice.
    if (commissionRunRef.current === name) return;
    commissionRunRef.current = name;

    (async () => {
      try {
        const result = await runCommissionTool(name, pendingInterrupt.toolCall.args ?? {});
        resolveInterrupt(result);
      } finally {
        commissionRunRef.current = null;
      }
    })();
  }, [pendingInterrupt, resolveInterrupt]);

  // Client-executed Policy Issuance and Payment
  useEffect(() => {
    if (pendingInterrupt?.kind !== "client_execute") return;
    if (pendingInterrupt.toolCall.name === "issue_policy") {
      setIssuanceModalPolicy(pendingInterrupt.toolCall.args.policy);
    } else if (pendingInterrupt.toolCall.name === "confirm_policy_payment") {
      setPaymentModalPolicy(pendingInterrupt.toolCall.args.policy);
    } else if (pendingInterrupt.toolCall.name === "submit_agent_confidential_report") {
      setAcrModalCase({
        caseId: pendingInterrupt.toolCall.args.case_id,
        caseNumber: pendingInterrupt.toolCall.args.case_number,
      });
    } else if (pendingInterrupt.toolCall.name === "build_rule_ui") {
      setRuleBuilderModalArgs(pendingInterrupt.toolCall.args);
    }
  }, [pendingInterrupt]);

  const getBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  };

  const handleSubmit = useCallback(async (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const text = overrideText ?? input;
    if ((!text.trim() && !selectedFile) || isLoading || isUploading) return;
    if (!overrideText) setInput("");

    // A member of a family is never assessed on their own: the risk assessment runs for every insured member together,
    // after the head's AND the spouse's underwriting. Anything asking for one member's assessment is turned into that.
    const riskAsk = /^\s*run (?:ai )?risk assessment for case (\S+)/i.exec(text);
    const queue = familyQueueRef.current;
    const member = riskAsk && queue.length > 1 ? queue.find((c) => c.case_number === riskAsk[1] || c.case_id === riskAsk[1]) : undefined;
    if (member) {
      (async () => {
        const states = await Promise.all(queue.map(async (c) => {
          try { return { c, ready: !!(await api.get(`/tenants/${tenantOf()}/cases/${c.case_id}/detail`)).data?.pre_underwriting_status?.is_ready }; }
          catch { return { c, ready: false }; }
        }));
        const waiting = states.filter((x) => !x.ready).map((x) => x.c);
        if (waiting.length === 0) {
          addAssistantMessage("Every insured member's underwriting is complete — running the risk assessment for all of them together.");
          runFamilyAssessmentsRef.current?.();
        } else {
          addAssistantMessage(`The risk assessment runs for all insured members together, once everyone's underwriting is in — **${waiting[0].name}** is next.`);
          showUnderwritingRequirements(waiting[0].case_id, waiting[0].case_number);
        }
      })();
      return;
    }

    let attachments = undefined;
    if (selectedFile) {
        try {
            const base64Url = await getBase64(selectedFile);
            attachments = [{ name: selectedFile.name, url: base64Url }];
            setSelectedFile(null);
        } catch (error) {
            console.error("Error converting file to base64", error);
        }
    }

    if (pendingInterrupt?.kind === "clarify") {
      resolveInterrupt(text.trim());
    } else if (pendingInterrupt?.kind === "confirm") {
      const lowerText = text.trim().toLowerCase();
      if (lowerText === "yes" || lowerText === "y") {
        resolveInterrupt(true);
      } else if (lowerText === "no" || lowerText === "n" || lowerText === "cancel") {
        resolveInterrupt(false);
      } else {
        send(text.trim(), attachments);
      }
    } else {
      send(text.trim(), attachments);
    }
  }, [input, isLoading, pendingInterrupt, send, resolveInterrupt, selectedFile, isUploading, addAssistantMessage, showUnderwritingRequirements]);

  // ── Family underwriting: assess every insured member, then let the underwriter decide ───────────────────────────────
  // Only the head and a fully insured spouse are insured; nominees carry no cover and are not assessed. The assessments
  // run one after another once every member's requirements are in, and the results come back as one summary
  // with the three ways forward.
  const FAMILY_APPROVED = ["Auto Approve", "Approve with Loading"];
  const familyStatusOf = (decision: string): FamilyOutcome["status"] =>
    FAMILY_APPROVED.includes(decision) ? "Approved" : decision === "Decline" ? "Rejected" : "Needs review";
  const tenantOf = () => localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID;

  const fetchNominees = useCallback(async () => {
    const { familyGroupId, familyPolicyId } = familyMetaRef.current;
    if (!familyGroupId || !familyPolicyId) return [] as { name: string; relationship: string; share_pct: number; amount: number | null }[];
    try {
      const r = await api.get(`/tenants/${tenantOf()}/families/${familyGroupId}/family-policies/${familyPolicyId}/nominees`);
      return (r.data?.nominees ?? []) as { name: string; relationship: string; share_pct: number; amount: number | null }[];
    } catch { return []; }
  }, []);

  const runFamilyAssessments = useCallback(async () => {
    const queue = familyQueueRef.current;
    if (!queue.length) return;
    const results: FamilyOutcome[] = [];
    try {
      for (const m of queue) {
        const detail = (await api.get(`/tenants/${tenantOf()}/cases/${m.case_id}/detail`)).data;

        // Past underwriting already (a step was refreshed, or the chat was reopened later): say where the family stands
        // instead of assessing — and holding — a case whose decision is already on record.
        const policyState = String(detail.policy?.status ?? "").replace(/\s/g, "").toLowerCase();
        const headNo = (queue.find((c) => c.relationship === "Self") ?? queue[0]).case_number;
        if (policyState === "active" || policyState === "pendingpayment") {
          familyResultsRef.current = results;
          addAssistantMessage(
            policyState === "active"
              ? `✅ This family's case is already done — the policy is issued and **Active**. There is nothing left to assess.`
              : `This family's policy is already issued and is **waiting for the first payment**.`,
            [policyState === "active"
              ? { label: "View active policy", actionType: "submit", payload: `Show me the active policy status for case ${headNo}` }
              : { label: "Confirm payment", actionType: "submit", payload: `Confirm payment for case ${headNo}` }]
          );
          return;
        }
        if (["Approved", "Closed"].includes(String(detail.case?.caseStatus)) && detail.latest_assessment) {
          const a = detail.latest_assessment;   // decision already recorded — reuse it, don't run the engine again
          results.push({
            m, decision: a.ai_decision, already: true, status: "Approved", assessedAt: new Date().toISOString(),
            scores: { medical_score: a.medical_score, financial_score: a.financial_score, fraud_probability: a.fraud_probability, composite_risk_score: a.composite_risk_score, reasons: a.reasons },
          });
          continue;
        }

        const { finalScores, finalDecision, blockedGate } = await streamAssessment({ customer: detail.customer, policy: detail.policy, case_id: m.case_id });
        if (blockedGate) {
          // The evidence check wants something more for this member — say so, with the same buttons as a single case.
          const held = buildRequirementsBlockedResult(blockedGate, m.case_id, m.case_number);
          addAssistantMessage(`**${m.name}**${m.relationship === "Spouse" ? " (fully insured spouse)" : ""}: ${held.message}`, held.quick_actions as QuickAction[]);
          familyResultsRef.current = results;
          return;
        }
        results.push({ m, decision: finalDecision, scores: finalScores, status: familyStatusOf(finalDecision), assessedAt: new Date().toISOString() });
      }
    } catch (err: any) {
      addAssistantMessage(`⚠️ The family risk assessment stopped: ${err?.message ?? "unknown error"}. You can run it again.`,
        [{ label: "Run risk assessment — all insured members", actionType: "family_assess", payload: "{}" }]);
      return;
    } finally {
      setRiskSteps([]);
    }
    familyResultsRef.current = results;

    if (results.length && results.every((r) => r.already)) {
      const headNo = (queue.find((c) => c.relationship === "Self") ?? queue[0]).case_number;
      addAssistantMessage(
        `Every insured member is already **approved** — ${results.map((r) => `**${r.m.name}**`).join(" and ")}. The decisions are on record, so nothing is assessed again. ` +
          `The family policy is issued to the head, on the head's case **${headNo}**.`,
        [
          { label: "Yes — Issue Policy", actionType: "submit", payload: `Run pre-issuance verification and issue the policy for case ${headNo}` },
          { label: "Download family report", actionType: "family_report", payload: "{}" },
        ]
      );
      return;
    }

    const nominees = await fetchNominees();
    const icon = { "Approved": "✅", "Needs review": "⏳", "Rejected": "❌" } as const;
    const pct = (v: number | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
    const shown = [...results].sort((a, b) => Number(b.m.relationship === "Self") - Number(a.m.relationship === "Self"));   // head first, whatever order they were assessed in
    const lines = shown.map((r) =>
      `${icon[r.status]} **${r.m.name}** (${r.m.relationship === "Self" ? "Head" : r.m.relationship}) — **${r.status}** · ${r.decision}${r.already ? " · already decided" : ""}` +
      ` · Medical ${r.scores.medical_score ?? "—"} · Financial ${r.scores.financial_score ?? "—"} · Fraud ${pct(r.scores.fraud_probability)}`);
    const nomLines = nominees.map((n) => `- ${n.name} (${n.relationship}) — ${n.share_pct}%${n.amount != null ? ` · PKR ${Math.round(n.amount).toLocaleString()}` : ""}`);
    const head = results.find((r) => r.m.relationship === "Self") ?? results[0];
    const approved = results.filter((r) => r.status === "Approved");
    const review = results.filter((r) => r.status === "Needs review");
    const rejected = results.filter((r) => r.status === "Rejected");

    const actions: QuickAction[] = [];
    if (head && head.status === "Approved") {
      actions.push({ label: "Proceed head with all approved members", actionType: "family_decision", payload: JSON.stringify({ mode: "approved" }) });
    }
    if (review.length || (head && head.status === "Needs review")) {
      actions.push({ label: "Proceed head with unapproved members", actionType: "family_decision", payload: JSON.stringify({ mode: "with_unapproved" }) });
    }
    // Anyone who was not approved can have their data corrected and be assessed again — rejected, or still needing review.
    if (rejected.length || review.length) {
      actions.push({ label: rejected.length ? "Resubmit data for the rejected members" : "Resubmit data for the unapproved members", actionType: "family_decision", payload: JSON.stringify({ mode: "resubmit" }) });
    }
    actions.push({ label: "Download family report", actionType: "family_report", payload: "{}" });

    addAssistantMessage(
      `### Family underwriting results\n\n${lines.join("\n\n")}` +
        (nomLines.length ? `\n\n**Nominees** — no cover, not underwritten:\n${nomLines.join("\n")}` : "") +
        `\n\n${approved.length} approved · ${review.length} need review · ${rejected.length} rejected. How would you like to go on?\n\n` +
        `- **Proceed head with all approved members** — the policy goes ahead for the head and the approved members; anyone else is left off the cover.\n` +
        `- **Proceed head with unapproved members** — an underwriter accepts the members who still need review, so they are covered too.\n` +
        `- **Resubmit data for the rejected members** — correct their details, then assess them again.`,
      actions
    );
  }, [streamAssessment, addAssistantMessage, fetchNominees]);
  runFamilyAssessmentsRef.current = runFamilyAssessments;

  const setCaseStatus = (caseId: string, status: string) =>
    api.patch(`/tenants/${tenantOf()}/cases/${caseId}/status`, { status });
  const noteOnCase = (caseId: string, text: string) =>
    api.post(`/tenants/${tenantOf()}/cases/${caseId}/comments`, { commentText: text, commentType: "Internal", visibilityLevel: "Team" }).catch(() => undefined);

  const runFamilyDecision = useCallback(async (mode: "approved" | "with_unapproved" | "resubmit") => {
    const results = familyResultsRef.current;
    if (!results.length) { addAssistantMessage("The assessment results are no longer available — run the family risk assessment again.", [{ label: "Run risk assessment — all insured members", actionType: "family_assess", payload: "{}" }]); return; }
    const head = results.find((r) => r.m.relationship === "Self") ?? results[0];
    const rejected = results.filter((r) => r.status === "Rejected");

    if (mode === "resubmit") {
      const targets = rejected.length ? rejected : results.filter((r) => r.status !== "Approved");
      try { await Promise.all(targets.map((r) => setCaseStatus(r.m.case_id, "InProgress"))); } catch { /* the workspace still opens */ }
      addAssistantMessage(
        `${targets.map((r) => `**${r.m.name}**`).join(" and ")} ${targets.length === 1 ? "is" : "are"} back in progress. Correct the details or documents in ${targets.length === 1 ? "their" : "each"} workspace, then run the assessment again.`,
        targets.flatMap((r): QuickAction[] => [
          { label: `Open ${r.m.name}'s workspace`, actionType: "embed", payload: `case/${r.m.case_id}` },
          { label: `Re-run assessment — ${r.m.name}`, actionType: "submit", payload: `Re-run risk assessment for case ${r.m.case_number}` },
        ])
      );
      return;
    }

    // Who goes ahead and who is left off the cover.
    const goes = results.filter((r) => (mode === "approved" ? r.status === "Approved" : r.status !== "Rejected"));
    const left = results.filter((r) => !goes.includes(r));
    if (!goes.includes(head)) {
      addAssistantMessage(`**${head.m.name}**'s own result is **${head.status}**, so the policy can't go ahead for the head yet.`,
        [{ label: "Resubmit data for the rejected members", actionType: "family_decision", payload: JSON.stringify({ mode: "resubmit" }) }]);
      return;
    }
    try {
      // Members left off the cover are closed first, so the family policy is not held waiting for them; the head is last.
      for (const r of left) {
        await noteOnCase(r.m.case_id, `Left off the family cover — AI decision "${r.decision}" (${r.status}).`);
        await setCaseStatus(r.m.case_id, "Closed");
      }
      for (const r of [...goes.filter((x) => x !== head), head]) {
        if (r.status !== "Approved") await noteOnCase(r.m.case_id, `Accepted by the underwriter from chat despite the AI recommendation "${r.decision}".`);
        await setCaseStatus(r.m.case_id, "Approved");
      }
    } catch (err: any) {
      addAssistantMessage(`⚠️ Couldn't record the decision: ${err?.response?.data?.detail ?? err?.message ?? "unknown error"}. You can try again.`,
        [{ label: mode === "approved" ? "Proceed head with all approved members" : "Proceed head with unapproved members", actionType: "family_decision", payload: JSON.stringify({ mode }) }]);
      return;
    }
    addAssistantMessage(
      `Approved: ${goes.map((r) => `**${r.m.name}**`).join(", ")}.` +
        (left.length ? ` Left off the cover: ${left.map((r) => `**${r.m.name}**`).join(", ")} — they stay on the policy as nominees only.` : "") +
        `\n\nThe family policy is issued to the head, on the head's case **${head.m.case_number}**. Do you want to issue it now?`,
      [
        { label: "Yes — Issue Policy", actionType: "submit", payload: `Run pre-issuance verification and issue the policy for case ${head.m.case_number}` },
        { label: "No — Not Yet", actionType: "submit", payload: "Okay, I'll issue the policy later." },
      ]
    );
  }, [addAssistantMessage]);

  const downloadFamilyReport = useCallback(async () => {
    const first = familyQueueRef.current[0];
    if (!first) { notify("Run the family risk assessment first.", false); return; }
    try {
      notify("Generating the family report...", true);
      const { buildFamilyReport } = await import("@/lib/case-report");
      const { generateFamilyAssessmentPDF } = await import("@/lib/pdf-export");
      const report = await buildFamilyReport(first.case_id);
      if (!report) throw new Error("This family has no insured members to report on");
      await generateFamilyAssessmentPDF(report);
      notify("✅ Family report downloaded", true);
    } catch (err: any) {
      notify(`⚠️ Could not build the family report: ${err.message}`, false);
    }
  }, [notify]);

  const handleQuickAction = useCallback((action: QuickAction) => {
    if (action.actionType === "navigate") {
      // Payloads carry the destination page's own self-select param
      // ("cases?case_id=…", "admin/leads?cnic=…") — mirror it into the
      // highlighter so the row pops, not just loads.
      const query = action.payload.split("?")[1];
      const entityId = query ? new URLSearchParams(query).values().next().value : undefined;
      if (entityId) {
        requestHighlight(entityId);
        triggerHighlight(entityId); // same-URL pushes don't re-fire the nav watcher
      }
      const path = action.payload.startsWith('/') ? action.payload : `/${action.payload}`;
      const sep = path.includes('?') ? '&' : '?';
      window.open(`${window.location.origin}${path}${sep}_portal=1`, "_blank");
    } else if (action.actionType === "embed") {
      // Opens the page inline in the chat panel. Used for the 6 pre-underwriting
      // gate stages and the customer intake form ("Fill the form instead") —
      // everything else uses "navigate" above and opens a normal new tab.
      const path = action.payload.startsWith('/') ? action.payload : `/${action.payload}`;
      const sep = path.includes('?') ? '&' : '?';
      setCasePanel({ url: `${window.location.origin}${path}${sep}_portal=1`, title: routeLabel(action.payload) });
    } else if (action.actionType === "proposal_step") {
      runProposalStep(JSON.parse(action.payload));
    } else if (action.actionType === "uw_requirements") {
      const { caseId, caseNo } = JSON.parse(action.payload);
      showUnderwritingRequirements(caseId, caseNo);
    } else if (action.actionType === "family_assess") {
      runFamilyAssessments();
    } else if (action.actionType === "family_decision") {
      runFamilyDecision(JSON.parse(action.payload).mode);
    } else if (action.actionType === "family_report") {
      downloadFamilyReport();
    } else if (action.actionType === "submit" && /^Check pre-underwriting status for case (\S+)/.test(action.payload)) {
      // The "Check Gate Status" button every gate result ends with — answer it
      // here rather than asking the model, so the list and its buttons are
      // always shown. Falls back to a normal request if the case can't be found.
      const caseNo = action.payload.match(/^Check pre-underwriting status for case (\S+)/)![1];
      const tenantId = localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID;
      api.get(`/tenants/${tenantId}/cases`)
        .then((r) => {
          const c = (r.data || []).find((x: any) => x.caseNumber === caseNo);
          if (c) showUnderwritingRequirements(c.caseld || c.id, caseNo);
          else handleSubmit(undefined, action.payload);
        })
        .catch(() => handleSubmit(undefined, action.payload));
    } else if (action.actionType === "upload") {
      const data = JSON.parse(action.payload);
      if (Array.isArray(data.document_types) && data.document_types.length && data.case_id) {
        setDocDialog({ case_id: data.case_id, case_number: data.case_number, document_types: data.document_types });
        return;
      }
      pendingUploadRef.current = data;
      fileInputRef.current?.click();
    } else if (action.actionType === "confirm") {
      resolveInterrupt(action.payload === "Yes");
    } else if (action.actionType === "download") {
      handleDownloadPDF(action.payload);
    } else {
      handleSubmit(undefined, action.payload);
    }
  }, [router, resolveInterrupt, handleSubmit, runProposalStep, showUnderwritingRequirements, runFamilyAssessments, runFamilyDecision, downloadFamilyReport]);

  const handleDownloadPDF = async (caseId: string) => {
    try {
      const tenantId = localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";
      const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
      
      notify("Generating PDF report...", true);
      const listRes = await fetch(`${API_BASE}/assessments?case_id=${caseId}`, {
        headers: { "X-Tenant-Id": tenantId }
      });
      if (!listRes.ok) throw new Error("Failed to fetch assessment list");
      const list = await listRes.json();
      if (!list || list.length === 0) throw new Error("No assessment found for this case");
      
      const a = list[0];
      const detailRes = await fetch(`${API_BASE}/assessments/${a.id}`, {
        headers: { "X-Tenant-Id": tenantId }
      });
      if (!detailRes.ok) throw new Error("Failed to fetch assessment details");
      const detail = await detailRes.json();
      
      const { generateCaseReportPDF } = await import("@/lib/case-report");
      await generateCaseReportPDF({
        customer_name: detail.customer_name,
        customer_cnic: detail.customer_cnic,
        case_id: detail.case_id,
        created_at: detail.created_at,
        medical_score: detail.medical_score,
        financial_score: detail.financial_score,
        fraud_probability: detail.fraud_probability,
        composite_risk_score: detail.composite_risk_score,
        ai_decision: detail.ai_decision,
        suggested_loading: detail.suggested_loading,
        reasons: detail.reasons,
        ai_summary: detail.ai_summary,
        product_name: a.product_name,
      });
      notify("✅ PDF downloaded successfully", true);
    } catch (err: any) {
      notify(`⚠️ Could not download PDF: ${err.message}`, false);
    }
  };

  // Fire RAG "next best action" suggestions once a turn finishes — fire-and-
  // forget, completely off the critical path.
  //
  // Only when the turn produced no backend suggestions of its own. Tools
  // already return `quick_actions` computed from real state, and those are
  // both better and free; running the RAG pipeline anyway spent an embedding
  // call plus a Gemini generation on every single turn to produce chips that
  // were then overwritten by the tool's own.
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && turnActions.length === 0) {
      const tenantId = localStorage.getItem("tenant_id");
      if (tenantId) {
        const ctx = messages.slice(-4).map((m) => `${m.role}: ${m.text}`).join("\n");
        api.post("/agent/suggest-actions", { context: ctx, tenant_id: tenantId })
          .then((r) => setSuggestedActions(r.data?.suggested_actions?.length > 0 ? r.data.suggested_actions : []))
          .catch(() => { });
      }
    }
    wasLoadingRef.current = isLoading;
    // turnActions intentionally read, not depended on: adding it would re-run
    // this when the chips arrive and fire the very call we are trying to skip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, messages]);

  // ── Case journey graph + live case events ─────────────────────────────────
  // What the chat is currently working on, read from the newest message that
  // names it: a case (tool result or requirements/embed button), else a
  // proposal (its step buttons carry the state they were offered in), else a
  // freshly onboarded customer.
  const journeyContext = React.useMemo<JourneyContext | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.actionResult?.entityType === "case" && m.actionResult.entityId) {
        return { kind: "case", caseId: m.actionResult.entityId };
      }
      for (const qa of m.quickActions ?? []) {
        if (qa.actionType === "uw_requirements") {
          try { return { kind: "case", caseId: JSON.parse(qa.payload).caseId }; } catch { /* ignore */ }
        }
        if (qa.actionType === "embed") {
          const match = /^\/?case\/([0-9a-f-]{36})/i.exec(qa.payload);
          if (match) return { kind: "case", caseId: match[1] };
        }
      }
      const proposalActions = (m.quickActions ?? []).filter((qa) => qa.actionType === "proposal_step");
      if (proposalActions.length) {
        try {
          const p = JSON.parse(proposalActions[0].payload);
          return { kind: "proposal", state: p.from as ProposalState, name: p.name, actions: proposalActions };
        } catch { /* ignore */ }
      }
      if (m.role === "assistant" && /proposal has been \*\*Rejected\*\*/.test(m.text)) {
        return { kind: "proposal", state: "rejected", actions: [] };
      }
      if (m.actionResult?.entityType === "customer") return { kind: "customer" };
    }
    return null;
  }, [messages]);

  const journeyCaseId = journeyContext?.kind === "case" ? journeyContext.caseId : null;
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [journeyLoading, setJourneyLoading] = useState(false);

  const refreshJourney = useCallback(async (caseId: string | null) => {
    if (!caseId) { setCaseDetail(null); return; }
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setJourneyLoading(true);
    try {
      const res = await api.get(`/tenants/${tenantId}/cases/${caseId}/detail`);
      setCaseDetail(res.data);
    } catch {
      /* keep the last good snapshot */
    } finally {
      setJourneyLoading(false);
    }
  }, []);

  // Re-read the case when the chat moves to another one and after every turn.
  useEffect(() => {
    if (caseDetail && caseDetail.case.caseld !== journeyCaseId) setCaseDetail(null);
    if (!isLoading) refreshJourney(journeyCaseId);
    // messages.length: client-side steps (proposal / requirements buttons) add
    // replies without a loading phase, and still change the case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyCaseId, isLoading, messages.length]);

  const journey: Journey | null = React.useMemo(() => {
    if (journeyContext?.kind === "case") {
      return caseDetail && caseDetail.case.caseld === journeyContext.caseId ? journeyFromCase(caseDetail) : null;
    }
    return journeyContext ? journeyFromChat(journeyContext) : null;
  }, [journeyContext, caseDetail]);

  // Steps queued by live events, run once the chat is idle — never while a
  // turn is streaming or a clarify/confirm question is waiting, where a prompt
  // would be taken as the answer to that question.
  const [autoActions, setAutoActions] = useState<QuickAction[]>([]);
  const seenEventIds = useRef<Set<string>>(new Set());

  const handleCaseEvent = useCallback(async (evt: CaseEvent) => {
    if (seenEventIds.current.has(evt.event_id)) return;
    seenEventIds.current.add(evt.event_id);

    const caseNo = evt.case_number || evt.case_id;
    const who = evt.customer_name || "The customer";
    const inThisChat =
      evt.case_id === journeyCaseId ||
      (!!evt.case_number && messages.some((m) => m.text?.includes(evt.case_number!)));
    if (evt.case_id === journeyCaseId) refreshJourney(journeyCaseId);

    if (evt.event_type === "EApplicationSubmitted") {
      if (!inThisChat) {
        notify(`📨 ${who} submitted the e-application for ${caseNo}`, true, `case/${evt.case_id}`);
        return;
      }
      setMapRun({ startIndex: messages.length, nodeId: "e_application", title: "Verify e-application" });
      addAssistantMessage(`📨 **${who}** just submitted the e-application for case **${caseNo}** — starting verification.`);
      setAutoActions((q) => [...q, { label: "Verify e-application", actionType: "submit", payload: `Verify e-application for case ${caseNo} action verify` }]);
      return;
    }

    if (evt.event_type === "ACRSubmitted") {
      const recommendation = (evt.detail?.recommendation as string | undefined) ?? null;
      const filedBy = (evt.detail?.submitted_by as string | undefined) || "The agent";
      if (!inThisChat) {
        notify(`📝 ${filedBy} filed the confidential report for ${caseNo}`, true, `case/${evt.case_id}`);
        return;
      }
      // Filed from this browser (the ACR form the chat opened) — that turn
      // already reported it and offered the next gate.
      const selfInflicted =
        isLoading ||
        messages.slice(-3).some((m) => m.actionResult?.toolName === "submit_agent_confidential_report" && m.actionResult.label !== "ACR requested" && m.actionResult.entityId === evt.case_id);
      if (selfInflicted) return;

      setMapRun({ startIndex: messages.length, nodeId: "acr", title: "Agent confidential report filed" });
      addAssistantMessage(
        `📝 **${filedBy}** just filed the Agent's Confidential Report for case **${caseNo}**${recommendation ? ` — recommendation **${recommendation}**` : ""}. Moving on to compliance screening.`
      );
      // The screening tool skips itself (and points onward) if it's already clear.
      setAutoActions((q) => [...q, { label: "Run compliance screening", actionType: "submit", payload: `Run compliance screening for case ${caseNo}` }]);
      return;
    }

    if (evt.event_type === "MedicalExamCompleted") {
      const outcome = (evt.detail?.outcome as string | undefined) ?? null;
      if (!inThisChat) {
        notify(`🩺 Medical examination completed for ${caseNo}`, true, `case/${evt.case_id}`);
        return;
      }
      // The chat's own "assess medical examination" tool records results too —
      // that turn already reports the outcome and offers the next step, so
      // don't move the workflow forward a second time.
      const selfInflicted =
        isLoading ||
        messages.slice(-3).some((m) => m.actionResult?.toolName === "assess_medical_examination" && m.actionResult.entityId === evt.case_id);
      if (selfInflicted) return;

      setMapRun({ startIndex: messages.length, nodeId: "medical_exam", title: "Medical examination completed" });
      addAssistantMessage(
        `🩺 The medical examination for case **${caseNo}** is complete${outcome ? ` — outcome **${outcome}**` : ""}. Moving on to the next step.`
      );
      // All requirements clear → straight to the risk assessment; otherwise
      // show the requirements list, which points at the next one.
      let ready = false;
      try {
        const tenantId = localStorage.getItem("tenant_id");
        const res = await api.get(`/tenants/${tenantId}/cases/${evt.case_id}/detail`);
        ready = !!res.data?.pre_underwriting_status?.is_ready;
      } catch { /* fall back to the status check */ }
      setAutoActions((q) => [
        ...q,
        ready
          ? { label: "Run risk assessment", actionType: "submit", payload: `Run risk assessment for case ${caseNo}` }
          : { label: "Check requirements", actionType: "submit", payload: `Check pre-underwriting status for case ${caseNo}` },
      ]);
    }
  }, [journeyCaseId, messages, isLoading, refreshJourney, addAssistantMessage, notify]);

  const eventsLive = useCaseEvents(handleCaseEvent);

  // Header toggle between the conversation and the full-page journey map.
  const [showJourneyMap, setShowJourneyMap] = useState(false);

  // The transcript is display:none under the journey map, which drops its
  // scroll position (and auto-scroll can't run while hidden) — so coming back
  // to the chat, jump straight to the latest messages.
  useEffect(() => {
    if (showJourneyMap) return;
    const el = scrollContainerRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [showJourneyMap]);

  // A step started from the map runs in this same conversation, but the user
  // stays on the map: `mapRun` marks where in the transcript the step began,
  // so the map's activity card can show just this step's progress, reply and
  // follow-up questions. Null when nothing is being tracked.
  const [mapRun, setMapRun] = useState<{ startIndex: number; nodeId?: string; title?: string } | null>(null);
  const handleMapAction = useCallback((action: QuickAction, nodeId?: string) => {
    if (action.actionType === "embed") {
      // The case workspace only renders inline in the conversation.
      setShowJourneyMap(false);
      handleQuickAction(action);
      return;
    }
    setMapRun({ startIndex: messages.length, nodeId, title: action.label });
    handleQuickAction(action);
  }, [handleQuickAction, messages.length]);

  // Once the step's turn finishes, it no longer owns the spinner — otherwise
  // the next turn (a follow-up chip, an auto-action, a chat message) would
  // show the finished node as "Working" again. The activity card stays.
  const mapRunLoadingRef = useRef(false);
  useEffect(() => {
    const busy = isLoading || isUploading;
    if (mapRunLoadingRef.current && !busy && !pendingInterrupt) {
      setMapRun((r) => (r?.nodeId ? { ...r, nodeId: undefined } : r));
    }
    mapRunLoadingRef.current = busy;
  }, [isLoading, isUploading, pendingInterrupt]);

  useEffect(() => {
    if (autoActions.length === 0 || isLoading || isUploading || pendingInterrupt) return;
    const [next, ...rest] = autoActions;
    setAutoActions(rest);
    handleQuickAction(next);
  }, [autoActions, isLoading, isUploading, pendingInterrupt, handleQuickAction]);

  const [sessions, setSessions] = useState<{id: string, date: number, title: string, messages: any[], actions: any[], pinned?: boolean, titleStage?: number, titleLocked?: boolean}[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY + "_sessions");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });
  // Which sidebar entry the open conversation belongs to. Kept across reloads:
  // the conversation itself is restored from storage, and without this the page
  // treated it as a brand-new chat each time and gave it a fresh sidebar entry
  // (and a fresh generic title).
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const id = localStorage.getItem(STORAGE_KEY + "_active_session");
      if (id && JSON.parse(localStorage.getItem(STORAGE_KEY + "_sessions") || "[]").some((x: any) => x.id === id)) return id;
    } catch { /* fall through */ }
    return null;
  });
  useEffect(() => {
    try {
      if (activeSessionId) localStorage.setItem(STORAGE_KEY + "_active_session", activeSessionId);
      else localStorage.removeItem(STORAGE_KEY + "_active_session");
    } catch { /* storage unavailable */ }
  }, [activeSessionId]);
  // Chat-history sidebar open/closed. Remembered across reloads; closing it gives the
  // conversation the full width.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return localStorage.getItem("copilot_sidebar_open") !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("copilot_sidebar_open", String(sidebarOpen)); } catch { /* storage unavailable */ }
  }, [sidebarOpen]);
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuSessionId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY + "_sessions", JSON.stringify(sessions));
    }
  }, [sessions]);

  // Chats that start the same way ("Add a new customer") get the same title from
  // their first exchange, and the list can't tell them apart. So titles are
  // refreshed as a chat progresses — from a condensed transcript, told what the
  // other chats are called, leading with the specific detail (a name, a case
  // number) — and a title already in use gets a number.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const makeUniqueTitle = (title: string, id: string) => {
    const others = new Set(sessionsRef.current.filter((x) => x.id !== id && x.title).map((x) => x.title.trim().toLowerCase()));
    if (!others.has(title.trim().toLowerCase())) return title;
    for (let n = 2; n < 100; n++) {
      if (!others.has(`${title} (${n})`.toLowerCase())) return `${title} (${n})`;
    }
    return title;
  };
  const refreshSessionTitle = useCallback(async (id: string, msgs: { role: string; text: string }[]) => {
    const firstUser = msgs.find((m) => m.role === "user");
    const firstReply = msgs.slice(msgs.findIndex((m) => m.role === "user") + 1).find((m) => m.role === "assistant" && m.text);
    if (!firstUser) return;
    const transcript = msgs
      .filter((m) => m.text)
      .slice(0, 30)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.replace(/\s+/g, " ").slice(0, 220)}`)
      .join("\n");
    const avoid = sessionsRef.current.filter((x) => x.id !== id && x.title).map((x) => x.title);
    try {
      const res = await api.post("/chat/title", {
        first_user_message: firstUser.text,
        first_assistant_reply: firstReply?.text || "",
        transcript,
        avoid,
      });
      const title = res.data?.title?.trim();
      if (title) {
        const unique = makeUniqueTitle(title, id);
        setSessions((prev) => prev.map((x) => (x.id === id && !x.titleLocked ? { ...x, title: unique } : x)));
      }
    } catch { /* keep the current title */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retitle the open chat as it grows (once it has real content, and again once
  // it is well under way) so its name reflects what actually happened in it.
  useEffect(() => {
    if (isLoading || !activeSessionId) return;
    const session = sessionsRef.current.find((x) => x.id === activeSessionId);
    if (!session || !session.title || session.titleLocked) return;
    const stage = session.titleStage ?? 0;
    const target = messages.length >= 24 ? 2 : messages.length >= 10 ? 1 : 0;
    if (target <= stage) return;
    setSessions((prev) => prev.map((x) => (x.id === activeSessionId ? { ...x, titleStage: target } : x)));
    refreshSessionTitle(activeSessionId, messages);
  }, [messages, isLoading, activeSessionId, refreshSessionTitle]);

  // One-time clean-up of chats saved before this: give each one that shares its
  // title with another a distinct name, one at a time.
  const titleBackfillDone = useRef(false);
  useEffect(() => {
    if (titleBackfillDone.current) return;
    titleBackfillDone.current = true;

    // The open conversation was saved before the active chat was remembered:
    // find the sidebar entry it already has (it holds the same first message)
    // and re-attach to it instead of creating a duplicate.
    if (!activeSessionId) {
      const firstId = messages.find((m) => m.role === "user")?.id;
      const own = firstId && sessionsRef.current.find((x) => x.messages.some((m: any) => m.id === firstId));
      if (own) setActiveSessionId(own.id);
    }
    // A title still blank because the page was closed while it was being
    // generated would show a loading skeleton forever — generate it now.
    sessionsRef.current
      .filter((x) => !x.title && x.messages.length >= 2)
      .forEach((x) => refreshSessionTitle(x.id, x.messages));
    const seen = new Map<string, number>();
    sessionsRef.current.forEach((x) => { const k = x.title.trim().toLowerCase(); if (k) seen.set(k, (seen.get(k) || 0) + 1); });
    const dupes = sessionsRef.current.filter(
      (x) => x.title && !x.titleLocked && x.titleStage === undefined && (seen.get(x.title.trim().toLowerCase()) || 0) > 1 && x.messages.length >= 4
    ).slice(0, 25);
    if (!dupes.length) return;
    (async () => {
      for (const d of dupes) {
        setSessions((prev) => prev.map((x) => (x.id === d.id ? { ...x, titleStage: 1 } : x)));
        await refreshSessionTitle(d.id, d.messages);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI-generated sidebar titles: as soon as a brand-new conversation has its
  // first exchange (one real user message + the assistant's first reply —
  // enough for an LLM to know what it's about), create its sidebar row early
  // with a pending title and ask the backend for a short title. The row shows
  // a skeleton in place of the title until that call resolves. Loaded/past
  // sessions already have a title and are skipped via the `activeSessionId`
  // guard below.
  useEffect(() => {
    if (isLoading || activeSessionId) return;
    const firstUserIdx = messages.findIndex(m => m.role === "user");
    if (firstUserIdx === -1) return;
    const firstAssistantReply = messages.slice(firstUserIdx + 1).find(m => m.role === "assistant" && m.text);
    if (!firstAssistantReply) return;
    const firstUserMessage = messages[firstUserIdx];

    const newSessionId = Date.now().toString();
    setActiveSessionId(newSessionId);
    setSessions(prev => [{
      id: newSessionId,
      date: Date.now(),
      title: "", // pending — rendered as a skeleton until the title call resolves
      messages: [...messages],
      actions: [...turnActions],
      pinned: false,
    }, ...prev]);

    api.post("/chat/title", {
      first_user_message: firstUserMessage.text,
      first_assistant_reply: firstAssistantReply.text,
      avoid: sessionsRef.current.filter(x => x.title).map(x => x.title),
    })
      .then(res => {
        const title = res.data?.title?.trim();
        // Only apply if still pending — the user may have already renamed it
        // by hand while the call was in flight.
        if (title) {
          const unique = makeUniqueTitle(title, newSessionId);
          setSessions(prev => prev.map(s => s.id === newSessionId && !s.title ? { ...s, title: unique } : s));
        }
      })
      .catch(() => {
        // Fall back to the same naive truncation saveCurrentSession used to
        // always use, rather than leaving the row stuck on a skeleton forever.
        const fallback = firstUserMessage.text.length > 35
          ? firstUserMessage.text.slice(0, 35) + "..."
          : firstUserMessage.text;
        setSessions(prev => prev.map(s => s.id === newSessionId && !s.title ? { ...s, title: fallback || "New Conversation" } : s));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isLoading, activeSessionId]);

  const saveCurrentSession = () => {
    if (messages.length <= 1) return;
    const userMsgTitle = messages.find(m => m.role === 'user')?.text || "New Conversation";
    const defaultTitle = userMsgTitle.length > 35 ? userMsgTitle.slice(0, 35) + "..." : userMsgTitle;
    const sessionId = activeSessionId || Date.now().toString();
    setSessions(prev => {
      const existing = prev.find(s => s.id === sessionId);
      // Merely opening a chat saves the one being left, which used to stamp it
      // with a fresh date and float it to the top of the list — burying the
      // chat that was actually most recent. Only real changes count as activity.
      if (existing && JSON.stringify(existing.messages) === JSON.stringify(messages)) {
        return prev.map(s => s.id === sessionId ? { ...s, actions: [...turnActions] } : s);
      }
      const filtered = prev.filter(s => s.id !== sessionId);
      return [{
        id: sessionId,
        date: Date.now(),
        title: existing?.title || defaultTitle,
        messages: [...messages],
        actions: [...turnActions],
        pinned: existing?.pinned || false
      }, ...filtered];
    });
  };

  // Per-conversation UI that lives outside the message list. Must be reset on
  // every switch: button selections are keyed by message id and the welcome
  // message is always id "1", so a stale map pre-selected the new chat's
  // first chip; and an open embed belonged to the previous conversation.
  const resetConversationUi = () => {
    setMapRun(null);
    setCasePanel(null);
    setUsedActions({});
    setAutoActions([]);
  };

  // Belt and braces: whatever path empties the conversation back to the
  // welcome screen, nothing from the previous one may survive into it.
  const isFreshConversation = messages.length <= 1;
  useEffect(() => {
    if (isFreshConversation) resetConversationUi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFreshConversation]);

  const handleClearChat = () => {
    resetConversationUi();
    saveCurrentSession();
    setActiveSessionId(null);
    clearChat();
    setSuggestedActions([]);
    localStorage.removeItem(STORAGE_KEY + "_suggestions");
  };

  const handleLoadSession = (session: any) => {
    resetConversationUi();
    saveCurrentSession();
    setActiveSessionId(session.id);
    loadChat(session.messages, session.actions || []);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) {
      handleClearChat();
    }
  };

  const handleTogglePinSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.map(s => s.id === id ? { ...s, pinned: !s.pinned } : s));
    setOpenMenuSessionId(null);
  };

  const handleExportSession = (
    session: { id: string; title: string; date: number; messages: AgentMessage[] },
    format: "md" | "json",
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    setOpenMenuSessionId(null);
    // The open chat's saved copy can lag behind what's on screen.
    const msgs: AgentMessage[] = session.id === activeSessionId ? messages : session.messages;
    const title = session.title || "Chat";
    const exportedAt = new Date();

    let content: string;
    let mime: string;
    if (format === "json") {
      content = JSON.stringify(
        { title, created: new Date(session.date).toISOString(), exported: exportedAt.toISOString(), messages: msgs },
        null,
        2,
      );
      mime = "application/json";
    } else {
      const lines = [
        `# ${title}`,
        "",
        `_Created ${new Date(session.date).toLocaleString()} · Exported ${exportedAt.toLocaleString()}_`,
        "",
      ];
      for (const m of msgs) {
        if (!m.text && !m.attachments?.length) continue;
        lines.push("---", "", `**${m.role === "user" ? "You" : "Rizviz Copilot"}**`, "");
        if (m.text) lines.push(m.text, "");
        for (const a of m.attachments ?? []) lines.push(`📎 [${a.name}](${a.url})`);
        if (m.attachments?.length) lines.push("");
        const picked = Object.values(m.selections ?? {});
        if (picked.length) lines.push(`> Selected: ${picked.join(", ")}`, "");
      }
      content = lines.join("\n");
      mime = "text/markdown";
    }

    const safeName = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "chat";
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeName}-${exportedAt.toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleStartRename = (session: { id: string, title: string }, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
    setOpenMenuSessionId(null);
  };

  const handleSaveRename = (id: string, e?: React.FormEvent | React.FocusEvent | React.KeyboardEvent) => {
    if (e) e.stopPropagation();
    if (editingTitle.trim()) {
      // A name the user typed is theirs — never retitle it automatically.
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title: editingTitle.trim(), titleLocked: true } : s));
    }
    setEditingSessionId(null);
  };

  const [chatSearch, setChatSearch] = useState("");
  // Chat history renders in windows: 15 up front, 14 more per "See more" click,
  // so a very long history is never mounted at once.
  const CHAT_PAGE_FIRST = 15;
  const CHAT_PAGE_NEXT = 14;
  const [visibleChats, setVisibleChats] = useState(CHAT_PAGE_FIRST);
  useEffect(() => { setVisibleChats(CHAT_PAGE_FIRST); }, [chatSearch]);
  // Bulk-delete selection mode for the history list.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(new Set());
  const [chatToolsOpen, setChatToolsOpen] = useState(false);
  const chatToolsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chatToolsOpen) return;
    const close = (e: MouseEvent) => {
      if (chatToolsRef.current && !chatToolsRef.current.contains(e.target as Node)) setChatToolsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [chatToolsOpen]);
  const getFilteredSessions = () =>
    [...sessions]
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.date - a.date;
      })
      .filter(s => !chatSearch.trim() || s.title.toLowerCase().includes(chatSearch.trim().toLowerCase()));
  const exitSelectMode = () => { setSelectMode(false); setSelectedChatIds(new Set()); };
  const toggleSelectedChat = (id: string) =>
    setSelectedChatIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const handleDeleteSelected = () => {
    const ids = selectedChatIds;
    if (ids.size === 0) return;
    if (!window.confirm(`Delete ${ids.size} chat${ids.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setSessions(prev => prev.filter(x => !ids.has(x.id)));
    if (activeSessionId && ids.has(activeSessionId)) handleClearChat();
    exitSelectMode();
  };

  // Once one button in a message's quick-action group is clicked, the whole
  // group locks — the clicked one stays highlighted, the rest grey out —
  // instead of remaining clickable as if the choice never happened. Keyed by
  // message id -> the index of the action that was clicked. Upload actions
  // are excluded: a group can offer several "Upload X" buttons for several
  // missing documents, and clicking one must not lock out the others — that
  // type already shows its own real "Uploaded" state from uploadedDocs.
  const [usedActions, setUsedActions] = useState<Record<string, number>>({});



  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        try {
          const fd = new FormData();
          fd.append("audio", blob, "recording.webm");
          const sttRes = await fetch("/api/stt", { method: "POST", body: fd });
          if (!sttRes.ok) throw new Error("STT failed");
          const { transcript } = await sttRes.json();
          if (transcript?.trim()) await handleSubmit(undefined, transcript);
        } catch {
          notify("⚠️ Could not transcribe audio. Please try again.", false);
        }
      };
      mr.start();
      setIsRecording(true);
    } catch {
      alert("Microphone access denied. Please allow microphone access in your browser.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  if (isAutomationMode) {
    return (
      <div className="flex h-full w-full bg-white text-slate-900 font-sans overflow-hidden">
        <>
          {issuanceModalPolicy && (
            <IssuanceModal
              policy={issuanceModalPolicy}
              onClose={() => {
                setIssuanceModalPolicy(null);
                resolveInterrupt({ success: false, message: "User cancelled issuance." });
              }}
              onIssued={(result, policyId) => {
                setIssuanceModalPolicy(null);
                setSuccessModalResult({ result, policyName: issuanceModalPolicy.customer_name, caseNumber: pendingInterrupt?.toolCall.args.case_number, isPayment: false });
              }}
            />
          )}
          {paymentModalPolicy && (
            <PaymentModal
              policy={paymentModalPolicy}
              onClose={() => {
                setPaymentModalPolicy(null);
                resolveInterrupt({ success: false, message: "User cancelled payment confirmation." });
              }}
              onConfirmed={(result, policyId) => {
                setPaymentModalPolicy(null);
                setSuccessModalResult({ result, policyName: paymentModalPolicy.customer_name, caseNumber: pendingInterrupt?.toolCall.args.case_number, isPayment: true });
              }}
            />
          )}
          {successModalResult && !successModalResult.isPayment && (
            <SuccessModal
              result={successModalResult.result as IssuanceResult}
              policyName={successModalResult.policyName}
              onClose={() => {
                const res = successModalResult.result as IssuanceResult;
                const caseNum = successModalResult.caseNumber;
                setSuccessModalResult(null);
                
                const total = res.premium_breakdown?.total_premium || 0;
                const msg = `Policy **${res.policy_number}** drafted for **${caseNum}** ✅\n\n- Status: **Pending Payment**\n- Effective: ${res.effective_date}\n- Expiry: ${res.expiry_date}\n- Total Premium: PKR ${total.toLocaleString()}\n- Payment Reference: ${res.payment?.reference || '—'}\n\nConfirm payment to activate coverage and bind the contract.`;
                
                resolveInterrupt({
                  success: true,
                  message: msg,
                  policy_id: res.policy_id,
                  policy_number: res.policy_number,
                  issuance_result: res,
                  last_action: {
                    tool_name: "issue_policy",
                    entity_type: "case",
                    entity_id: pendingInterrupt?.toolCall.args.case_id,
                    route: "policy-issuance",
                    label: `Policy ${res.policy_number} drafted`
                  },
                  quick_actions: [
                    { label: "Confirm Payment Now", actionType: "submit", payload: `Confirm payment for case ${caseNum}` },
                    { label: "Open Policy Issuance", actionType: "embed", payload: "policy-issuance" }
                  ]
                });
              }}
            />
          )}
          {successModalResult && successModalResult.isPayment && (
            <SuccessModal
              result={successModalResult.result as any}
              policyName={successModalResult.policyName}
              onClose={() => {
                const res = successModalResult.result as PaymentConfirmResult;
                const caseNum = successModalResult.caseNumber;
                setSuccessModalResult(null);
                
                const msg = `🎉 Policy **${res.policy_number}** is now **Active**!\n\n- Coverage bound effective: ${res.effective_date}\n- Expiry: ${res.expiry_date}\n- Free-look period ends: ${res.free_look_end_date}\n- Payment: ${res.payment?.reference || '—'}\n\nThe case has been closed and the customer promoted to Policyholder.\nThis policy is now visible in the **Post-Issuance** section.`;
                
                resolveInterrupt({
                  success: true,
                  message: msg,
                  policy_id: pendingInterrupt?.toolCall.args.policy.id,
                  policy_number: res.policy_number,
                  payment_result: res,
                  last_action: {
                    tool_name: "confirm_policy_payment",
                    entity_type: "policy",
                    entity_id: pendingInterrupt?.toolCall.args.policy.id,
                    route: `post-issuance/${pendingInterrupt?.toolCall.args.policy.id}`,
                    label: `Policy ${res.policy_number} activated`
                  },
                  quick_actions: [
                    { label: "View Active Policy", actionType: "submit", payload: `Show me the active policy status for case ${caseNum}` },
                    { label: "Open Post-Issuance", actionType: "embed", payload: "policy-management/post-issuance" }
                  ]
                });
              }}
            />
          )}
          {docDialog && (
        <DocumentUploadDialog
          tenantId={localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID}
          caseId={docDialog.case_id}
          caseNumber={docDialog.case_number}
          documentTypes={docDialog.document_types}
          onClose={() => setDocDialog(null)}
          onDone={handleDocDialogDone}
        />
      )}
      {acrModalCase && (
            <ACRModal
              caseId={acrModalCase.caseId}
              initial={null}
              onClose={() => {
                setAcrModalCase(null);
                resolveInterrupt({ success: false, message: "Okay, the ACR form was closed without submitting." });
              }}
              onDone={() => {
                const caseNum = acrModalCase.caseNumber;
                const caseId = acrModalCase.caseId;
                setAcrModalCase(null);
                resolveInterrupt({
                  success: true,
                  message: `✅ **Gate 2: Agent Confidential Report (ACR) Submitted** for case **${caseNum}**.\n\n👉 Next Gate: **Gate 3: Compliance / PEP Screening**.`,
                  status: "Submitted",
                  last_action: {
                    tool_name: "submit_agent_confidential_report",
                    entity_type: "case",
                    entity_id: caseId,
                    route: `case/${caseId}`,
                    label: "ACR submitted",
                  },
                  quick_actions: [
                    { label: "3. Compliance Screen (Gate 3)", actionType: "submit", payload: `Run compliance screening for case ${caseNum}` },
                    { label: "Check Gate Status", actionType: "submit", payload: `Check pre-underwriting status for case ${caseNum}` },
                  ],
                });
              }}
            />
          )}
          {ruleBuilderModalArgs && (
            <RuleBuilderModal
              mode={ruleBuilderModalArgs.mode}
              ruleSetCode={ruleBuilderModalArgs.rule_set_code}
              ruleCode={ruleBuilderModalArgs.rule_code}
              initialRule={ruleBuilderModalArgs.initial_rule}
              onClose={() => {
                setRuleBuilderModalArgs(null);
                resolveInterrupt({ success: false, error: "Rule building cancelled." });
              }}
              onSave={(data) => {
                setRuleBuilderModalArgs(null);
                resolveInterrupt(data);
              }}
            />
          )}
        </>
        {/* Browser half of the agent's group-census upload (opens its own picker) */}
        <GroupCensusClientTool interrupt={pendingInterrupt} resolve={resolveInterrupt} notify={notify} />
        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            
            // For immediate uploads, don't show the preview to avoid DOM layout thrashing
            if (interruptUploadRef.current || pendingUploadRef.current || autoSubmitPrompt) {
              setIsUploading(true);
              
              if (interruptUploadRef.current) {
                const { args } = interruptUploadRef.current;
                interruptUploadRef.current = null;
                try {
                  const result = await uploadDocument(args, file);
                  resolveInterrupt(result);
                } catch (err: any) {
                  resolveInterrupt({ success: false, error: err.message || "Upload failed." });
                } finally {
                  setIsUploading(false);
                }
              } else if (pendingUploadRef.current) {
                const args = pendingUploadRef.current;
                pendingUploadRef.current = null;
                try {
                  const result = await uploadDocument(args, file);
                  notify(`✅ ${result.message}`, true);
                  setUploadedDocs((prev) => [...prev, args.document_type]);
                } catch (err: any) {
                  notify(`⚠️ ${err.message || "Upload failed."}`, false);
                } finally {
                  setIsUploading(false);
                }
              } else if (autoSubmitPrompt) {
                // To attach and immediately submit, we do set the file briefly
                setSelectedFile(file);
                handleSubmit(undefined, `Upload ${file.name} as ${autoSubmitPrompt} for this case.`);
                setAutoSubmitPrompt("");
                setIsUploading(false);
              }
              
              // Reset the file input
              if (fileInputRef.current) fileInputRef.current.value = "";
              return;
            }

            // Normal attach (for chat message)
            setSelectedFile(file);
            selectedFileRef.current = file;
          }}
          className="hidden"
          accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
        />

        {/* Sidebar */}
        <div className={`w-[260px] flex-shrink-0 bg-zinc-50 border-r border-zinc-200 dark:bg-[#0f1115] dark:border-zinc-800 flex-col hidden ${sidebarOpen ? "md:flex" : ""} relative overflow-hidden`}>
          <div className="absolute top-0 left-0 w-full h-48 bg-gradient-to-b from-blue-500/5 dark:from-blue-500/10 to-transparent pointer-events-none" />
          
          <div className="p-5 flex items-center gap-3 font-bold text-lg text-zinc-900 dark:text-white relative z-10">
             <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 shadow-[0_0_15px_rgba(99,102,241,0.4)]">
               <img src="/rizvi.png" alt="Rizviz" className="w-5 h-5 object-contain brightness-0 invert" />
             </div>
             <span className="tracking-wide">Rizviz<span className="text-blue-600 dark:text-blue-400">.ai</span></span>
          </div>
          <div className="px-4 pb-3 mt-2 relative z-10 space-y-2">
            <button onClick={handleClearChat} className="flex items-center gap-3 w-full px-4 py-3 text-sm font-semibold text-zinc-800 bg-white hover:bg-zinc-100 border-zinc-200 dark:text-zinc-200 dark:bg-white/5 dark:hover:bg-white/10 rounded-xl transition-all border dark:border-white/5 shadow-sm">
              <svg className="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg>
              New chat
            </button>
            {/* Search input + chat tools (3 dots) */}
            <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <svg className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <input
                type="text"
                value={chatSearch}
                onChange={e => setChatSearch(e.target.value)}
                placeholder="Search chats…"
                className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-zinc-200 text-zinc-700 placeholder:text-zinc-400 dark:bg-white/5 dark:border-white/10 dark:text-zinc-300 dark:placeholder:text-zinc-600 rounded-xl focus:outline-none focus:border-blue-500/60 transition-all"
              />
              {chatSearch && (
                <button onClick={() => setChatSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              )}
            </div>
            <div ref={chatToolsRef} className="relative shrink-0">
              <button
                onClick={() => setChatToolsOpen(o => !o)}
                title="Chat tools"
                aria-label="Chat tools"
                className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/10 transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                </svg>
              </button>
              {chatToolsOpen && (
                <div className="absolute right-0 top-9 w-44 bg-white border border-zinc-200 dark:bg-[#181b21] dark:border-white/15 rounded-xl shadow-2xl py-1.5 z-50 text-xs">
                  <button
                    onClick={() => { setChatToolsOpen(false); setSelectMode(true); setSelectedChatIds(new Set()); }}
                    disabled={sessions.length === 0}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/10 font-medium text-left disabled:opacity-50"
                  >
                    Select chats
                  </button>
                </div>
              )}
            </div>
            </div>
            {selectMode && (() => {
              const all = getFilteredSessions();
              const allSelected = all.length > 0 && all.every(x => selectedChatIds.has(x.id));
              return (
                <div className="flex items-center justify-between gap-2 px-1 pt-1 text-xs">
                  <label className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setSelectedChatIds(allSelected ? new Set() : new Set(all.map(x => x.id)))}
                      className="w-3.5 h-3.5 accent-blue-600"
                    />
                    Select all ({all.length})
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={handleDeleteSelected}
                      disabled={selectedChatIds.size === 0}
                      className="px-2.5 py-1 rounded-lg font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Delete ({selectedChatIds.size})
                    </button>
                    <button onClick={exitSelectMode} className="px-2.5 py-1 rounded-lg font-medium text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-white/10 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {sessions.length > 0 && (() => {
              const filtered = getFilteredSessions();
              if (filtered.length === 0) return (
                <div className="text-center py-8 text-zinc-500 dark:text-zinc-600 text-xs">
                  No chats match &ldquo;{chatSearch}&rdquo;
                </div>
              );
              return (
                <div className="space-y-1">
                  {filtered.slice(0, visibleChats).map(session => (
                    <div
                      key={session.id}
                      className="relative group"
                    >
                      <div
                        onClick={() => (selectMode ? toggleSelectedChat(session.id) : handleLoadSession(session))}
                        className={`w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between border ${
                          selectMode && selectedChatIds.has(session.id)
                            ? 'bg-blue-50 border-blue-200 text-zinc-900 dark:bg-blue-500/10 dark:border-blue-500/30 dark:text-white'
                            : activeSessionId === session.id
                            ? 'bg-white border-zinc-200 text-zinc-900 dark:bg-white/10 dark:border-white/10 dark:text-white shadow-sm'
                            : 'border-transparent text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-white/5 dark:hover:text-white'
                        }`}
                      >
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selectedChatIds.has(session.id)}
                            onChange={() => toggleSelectedChat(session.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${session.title || "chat"}`}
                            className="w-3.5 h-3.5 mr-2.5 shrink-0 accent-blue-600"
                          />
                        )}
                        <div className="flex-1 min-w-0 pr-2">
                          {editingSessionId === session.id ? (
                            <input
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveRename(session.id, e);
                                if (e.key === "Escape") setEditingSessionId(null);
                              }}
                              onBlur={(e) => handleSaveRename(session.id, e)}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              className="w-full bg-white text-zinc-900 dark:bg-zinc-800 dark:text-white text-[13px] px-2 py-0.5 rounded border border-blue-500/80 outline-none"
                            />
                          ) : session.title ? (
                            <div className="flex items-center gap-1.5 text-[13px] font-medium truncate">
                              {session.pinned && (
                                <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                                </svg>
                              )}
                              <span className="truncate">{session.title}</span>
                            </div>
                          ) : (
                            // Empty title = the AI title-gen call is still in flight.
                            <div className="h-3.5 w-[70%] rounded bg-zinc-200 dark:bg-white/10 animate-pulse" title="Generating title…" />
                          )}
                          <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-2">
                            <span>{new Date(session.date).toLocaleDateString()}</span>
                            {session.pinned && <span className="text-[10px] text-blue-600 dark:text-blue-400 font-semibold uppercase tracking-wider">Pinned</span>}
                          </div>
                        </div>

                        {/* 3-dots Menu Toggle Button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuSessionId(openMenuSessionId === session.id ? null : session.id);
                          }}
                          className={`p-1 rounded-lg text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200 dark:hover:text-white dark:hover:bg-white/10 transition-all ${
                            openMenuSessionId === session.id ? "opacity-100 bg-zinc-200 text-zinc-900 dark:bg-white/10 dark:text-white" : "opacity-0 group-hover:opacity-100"
                          }`}
                          title="Chat options"
                          style={selectMode ? { display: "none" } : undefined}
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                          </svg>
                        </button>
                      </div>

                      {/* Dropdown Menu (Claude style) */}
                      {openMenuSessionId === session.id && (
                        <div
                          ref={menuRef}
                          className="absolute right-2 top-10 w-44 bg-white border border-zinc-200 dark:bg-[#181b21] dark:border-white/15 rounded-xl shadow-2xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100 text-xs backdrop-blur-xl"
                        >
                          <button
                            onClick={(e) => handleTogglePinSession(session.id, e)}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-white dark:hover:bg-white/10 transition-colors font-medium text-left"
                          >
                            <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                            </svg>
                            {session.pinned ? "Unpin chat" : "Pin chat"}
                          </button>

                          <button
                            onClick={(e) => handleStartRename(session, e)}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-white dark:hover:bg-white/10 transition-colors font-medium text-left"
                          >
                            <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                            </svg>
                            Rename
                          </button>

                          {IS_DEMO && (
                            <>
                              <button
                                onClick={(e) => handleExportSession(session, "md", e)}
                                className="flex items-center gap-2.5 w-full px-3 py-2 text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-white dark:hover:bg-white/10 transition-colors font-medium text-left"
                              >
                                <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                </svg>
                                Export as Markdown
                              </button>

                              <button
                                onClick={(e) => handleExportSession(session, "json", e)}
                                className="flex items-center gap-2.5 w-full px-3 py-2 text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:text-white dark:hover:bg-white/10 transition-colors font-medium text-left"
                              >
                                <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                </svg>
                                Export as JSON
                              </button>
                            </>
                          )}

                          <div className="my-1 border-t border-zinc-200 dark:border-white/10" />

                          <button
                            onClick={(e) => {
                              setOpenMenuSessionId(null);
                              handleDeleteSession(session.id, e);
                            }}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-500/10 transition-colors font-medium text-left"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                            </svg>
                            Delete chat
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {visibleChats < filtered.length && (
                    <button
                      onClick={() => setVisibleChats(n => n + CHAT_PAGE_NEXT)}
                      className="w-full mt-1 py-2.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-white/5 rounded-xl transition-colors"
                    >
                      See more
                    </button>
                  )}
              </div>
              );
            })()}

          </div>
          <div className="p-4 mt-auto border-t border-zinc-200 bg-zinc-100/60 dark:border-white/5 dark:bg-black/20 relative z-10">
            <button onClick={() => setAutomationMode(false)} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 rounded-xl transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
              Back to Dashboard
            </button>
          </div>
        </div>
        
        {/* Main Chat Area + Right Suggestions Panel */}
        <div className="flex-1 flex flex-row relative h-full min-w-0 min-h-0">
        <div className="flex-1 flex flex-col relative h-full min-w-0 min-h-0 bg-[#fdfdfe] dark:bg-[#0f172a]">
           {/* Subtle ambient glowing orbs */}
           <div className="absolute top-[-10%] left-[-5%] w-[500px] h-[500px] bg-blue-400/10 rounded-full blur-[100px] pointer-events-none" />
           <div className="absolute bottom-[-10%] right-[-5%] w-[400px] h-[400px] bg-fuchsia-400/10 rounded-full blur-[120px] pointer-events-none" />
           
           {/* Chat Header */}
           <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200/60 bg-white/40 dark:bg-zinc-900/40 backdrop-blur-md relative z-20">
             <div className="flex items-center gap-3">
               <button onClick={() => setAutomationMode(false)} className="md:hidden p-2 -ml-2 text-slate-600 hover:text-blue-600 transition-colors">
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
               </button>
               <button
                 type="button"
                 onClick={() => setSidebarOpen((v) => !v)}
                 aria-label={sidebarOpen ? "Hide chat history" : "Show chat history"}
                 aria-expanded={sidebarOpen}
                 title={sidebarOpen ? "Hide chat history" : "Show chat history"}
                 className="hidden md:flex p-2 -ml-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/10 transition-colors"
               >
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                   <rect x="3" y="4" width="18" height="16" rx="2.5" />
                   <path strokeLinecap="round" d="M9 4v16" />
                   {sidebarOpen && <path strokeLinecap="round" strokeLinejoin="round" d="M16 10l-2 2 2 2" />}
                   {!sidebarOpen && <path strokeLinecap="round" strokeLinejoin="round" d="M14 10l2 2-2 2" />}
                 </svg>
               </button>
               <div className="flex items-center gap-2">
                 <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                 <span className="font-bold text-sm text-slate-800 tracking-tight">Rizviz Copilot</span>
                 <span className="hidden sm:inline-block px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-[10px] font-bold uppercase tracking-widest ml-1 border border-blue-100">Beta</span>
               </div>
             </div>
             <div className="flex items-center gap-3">
               <button
                 onClick={() => setShowJourneyMap((v) => !v)}
                 aria-pressed={showJourneyMap}
                 title={showJourneyMap ? "Back to chat" : "Journey map"}
                 className={`relative text-sm font-semibold transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${
                   showJourneyMap
                     ? "bg-indigo-600 text-white hover:bg-indigo-500"
                     : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/10"
                 }`}
               >
                 {showJourneyMap ? (
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5m-9 6l2.5-3H19a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v14z" /></svg>
                 ) : (
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="5" cy="6" r="2.25" /><circle cx="19" cy="6" r="2.25" /><circle cx="12" cy="18" r="2.25" /><path strokeLinecap="round" d="M7.25 6h9.5M6.2 8l4.6 8M17.8 8l-4.6 8" /></svg>
                 )}
                 <span className="hidden sm:inline">{showJourneyMap ? "Chat" : "Journey"}</span>
                 {!showJourneyMap && journey && journey.gates.concat(journey.before, journey.after).some((n) => n.state === "next" || n.state === "failed") && (
                   <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-500 ring-2 ring-white dark:ring-zinc-900" />
                 )}
               </button>
               <button onClick={handleClearChat} className="text-sm font-semibold text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-slate-100">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                 <span className="hidden sm:inline">Clear</span>
               </button>
             </div>
           </div>
           
           {showJourneyMap && (
             <JourneyMap
               journey={journey}
               onAction={handleMapAction}
               disabled={isLoading || isUploading || !!pendingInterrupt}
               loading={journeyLoading}
               live={eventsLive}
               runningNodeId={
                 (isLoading || isUploading) && mapRun?.nodeId &&
                 !journey?.before.concat(journey.gates, journey.after).some((n) => n.id === mapRun.nodeId && n.state === "done")
                   ? mapRun.nodeId
                   : null
               }
               activity={mapRun && (() => {
                 let runMsg: AgentMessage | null = null;
                 for (let i = messages.length - 1; i >= mapRun.startIndex; i--) {
                   if (messages[i].role === "assistant") { runMsg = messages[i]; break; }
                 }
                 const isLatest = !!runMsg && runMsg.id === messages[messages.length - 1]?.id;
                 const runActions = runMsg?.quickActions?.length
                   ? runMsg.quickActions
                   : isLatest ? turnActions : [];
                 return (
                   <JourneyActivityPanel
                     title={mapRun.title}
                     working={isLoading || isUploading}
                     awaitingInput={!!pendingInterrupt}
                     steps={isLoading ? steps : []}
                     message={runMsg}
                     actions={runActions}
                     usedIdx={runMsg ? usedActions[runMsg.id] : undefined}
                     onAction={(idx, action) => {
                       if (runMsg && !isPassiveAction(action)) {
                         setUsedActions((prev) => ({ ...prev, [runMsg!.id]: idx }));
                       }
                       if (action.actionType === "embed") {
                         setShowJourneyMap(false);
                         handleQuickAction(action);
                       } else if (isPassiveAction(action)) {
                         handleQuickAction(action);
                       } else {
                         // A follow-up starts a new step — track (and spin) its own node.
                         const node = journey?.before.concat(journey.gates, journey.after)
                           .find((n) => n.action?.payload && n.action.payload === action.payload);
                         handleMapAction(action, node?.id);
                       }
                     }}
                     onSelectRun={(text) => handleSubmit(undefined, text)}
                     onSelected={(idx, label) => runMsg && recordSelection(runMsg.id, idx, label)}
                     onOpenChat={() => setShowJourneyMap(false)}
                     onDismiss={() => setMapRun(null)}
                   />
                 );
               })()}
             />
           )}

           {/* Messages — kept mounted under the map so scroll position survives */}
           <div className={`flex-1 overflow-y-auto custom-scrollbar ${showJourneyMap ? "hidden" : ""}`} ref={scrollContainerRef}>
             <div className="w-full">
               {messages.length === 1 && messages[0].id === "1" && messages[0].role === "assistant" ? (
                 <div className="flex flex-col items-center justify-center h-full min-h-[60vh] px-4">
                   <div className="w-full max-w-3xl flex flex-col items-center mt-10">
                     <div className="text-slate-400 font-bold text-xs uppercase tracking-[0.2em] mb-3">Rizviz AI Copilot</div>
                     <h2 className="text-4xl md:text-[50px] font-bold tracking-tight text-center mb-10 bg-clip-text text-transparent bg-gradient-to-r from-blue-500 via-blue-500 to-fuchsia-500 pb-2 leading-tight">
                       How can I help you today?
                     </h2>
                     
                     {/* Input Box - Perplexity style */}
                     <div className="w-full relative shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-2xl bg-white/70 dark:bg-zinc-800/70 backdrop-blur-xl border border-white/60 dark:border-white/10 focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-500/10 transition-all duration-300">
                       {selectedFile && (
                         <div className="px-4 pt-4 pb-0 flex items-center gap-2">
                           <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3 p-2 pr-3 min-w-[160px] max-w-[260px]">
                             {selectedFile.type.startsWith("image/") && selectedFileUrl ? (
                               <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-slate-200">
                                 <img src={selectedFileUrl} alt="preview" className="w-full h-full object-cover" />
                               </div>
                             ) : (
                               <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-red-100 text-red-500 flex items-center justify-center">
                                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                               </div>
                             )}
                             <div className="flex flex-col min-w-0 flex-1">
                               <span className="text-sm font-semibold text-slate-700 truncate">{selectedFile.name}</span>
                               <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{selectedFile.type.startsWith("image/") ? "Image" : "Document"}</span>
                             </div>
                             <button
                               type="button"
                               onClick={() => setSelectedFile(null)}
                               className="absolute top-1 right-1 p-1 bg-white/80 hover:bg-white dark:bg-zinc-700/80 dark:hover:bg-zinc-700 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-all text-slate-500 hover:text-red-500"
                             >
                               <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                             </button>
                           </div>
                         </div>
                       )}
                       <form onSubmit={handleSubmit} className="flex flex-col w-full">
                         <textarea 
                           rows={1}
                           value={input}
                           onChange={(e) => setInput(e.target.value)}
                           onKeyDown={(e) => {
                             if (e.key === 'Enter' && !e.shiftKey) {
                               e.preventDefault();
                               handleSubmit();
                             }
                           }}
                           placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Ask anything..."}
                           className="w-full max-h-48 px-5 pt-4 pb-2 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-[16px] text-slate-900 placeholder:text-slate-400"
                           style={{ minHeight: "60px" }}
                         />
                         
                         <div className="flex items-center justify-between px-3 pb-3">
                           <div className="flex items-center gap-2">
                             <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors">
                               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4M4 12h16"/></svg>
                               Attach
                             </button>
                           </div>
                           <div className="flex items-center gap-2">
                             <button type="submit" disabled={(!input.trim() && !selectedFile) || isLoading} className="p-2 bg-[#1a1a1a] hover:bg-black dark:bg-blue-600 dark:hover:bg-blue-500 text-white rounded-full disabled:bg-slate-100 disabled:text-slate-300 transition-colors flex items-center justify-center h-10 w-10">
                               <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7"/></svg>
                             </button>
                           </div>
                         </div>
                       </form>
                     </div>

                     {/* Action Cards */}
                     <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                       {(turnActions.length > 0
                         ? turnActions
                         : getRecommendedActions(undefined)
                       ).slice(0, 10).map((action, idx) => action.actionType === "select" ? (
                         <QuickActionSelect
                           key={idx}
                           action={action}
                           onRun={(text) => handleSubmit(undefined, text)}
                           variant="card"
                         />
                       ) : (
                         <button
                           key={idx}
                           onClick={() => handleQuickAction(action)}
                           className="flex flex-col items-start p-4 bg-white/60 dark:bg-zinc-800/60 backdrop-blur-sm hover:bg-white dark:hover:bg-zinc-800 border border-white/60 dark:border-white/10 hover:border-blue-100 hover:shadow-[0_8px_20px_rgb(99,102,241,0.08)] rounded-2xl transition-all text-left group"
                         >
                           <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-1 group-hover:text-blue-600 transition-colors">
                             {action.actionType === "navigate" ? (
                               <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                             ) : (
                               <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                             )}
                             {action.label}
                           </div>
                           <div className="text-xs text-slate-500 font-medium w-full truncate">
                             {action.payload}
                           </div>
                         </button>
                       ))}
                     </div>
                     
                   </div>
                 </div>
               ) : (
                 <div className="flex flex-col pb-8 pt-8">
                   {messages.map((msg, msgIdx) => (
                     <div key={msg.id} className="w-full px-4 py-4 md:py-6">
                       <div className={`max-w-3xl mx-auto flex gap-4 md:gap-5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                         
                         {/* Avatar (only for Agent) */}
                         {msg.role !== "user" && (
                           <div className="flex-shrink-0 mt-1">
                             <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-[0_0_12px_rgba(99,102,241,0.3)] flex items-center justify-center p-1.5 ring-2 ring-white">
                               <img src="/rizvi.png" alt="Agent" className="w-full h-full object-contain brightness-0 invert" />
                             </div>
                           </div>
                         )}

                         <div className={`flex-1 min-w-0 flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                           
                           <div className={`flex flex-col gap-2 ${msg.role === "user" ? "items-end max-w-[85%]" : "items-start w-full"}`}>
                             {msg.role === "user" ? (
                               <>
                                 {msg.text && (
                                   <div className="group/usermsg relative">
                                     <div className="bg-[#f3f4f6] dark:bg-zinc-700 text-slate-900 px-5 py-3 rounded-[24px] rounded-tr-md text-[15px] leading-relaxed whitespace-pre-wrap">
                                       {msg.text}
                                     </div>
                                     <button
                                       type="button"
                                       title="Copy"
                                       onClick={() => navigator.clipboard.writeText(msg.text)}
                                       className="absolute -bottom-6 right-0 p-1 opacity-0 group-hover/usermsg:opacity-100 transition-opacity text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                                     >
                                       <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                     </button>
                                   </div>
                                 )}
                                 {msg.attachments && msg.attachments.length > 0 && (
                                   <div className="flex flex-wrap gap-2 justify-end">
                                     {msg.attachments.map((att, idx) => (
                                       <div key={idx} className="flex items-center gap-2.5 p-1 pr-3.5 bg-white border border-slate-200/80 shadow-sm rounded-full max-w-[220px]">
                                         {att.url.startsWith("data:image/") ? (
                                           <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 border border-slate-100">
                                             <img src={att.url} alt={att.name} className="w-full h-full object-cover" />
                                           </div>
                                         ) : (
                                           <div className="w-7 h-7 rounded-full flex-shrink-0 bg-slate-100 text-slate-500 flex items-center justify-center border border-slate-200/50">
                                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                                           </div>
                                         )}
                                         <span className="text-[13px] font-medium text-slate-700 truncate">{att.name}</span>
                                       </div>
                                     ))}
                                   </div>
                                 )}
                               </>
                             ) : (
                               <div className="w-full flex flex-col gap-3">
                                 <div className="prose prose-slate max-w-none text-[16px] leading-relaxed break-words text-slate-800 w-full copilot-markdown prose-p:font-serif prose-headings:font-serif prose-li:font-serif">
                                   <ReactMarkdown>{msg.text}</ReactMarkdown>
                                 </div>

                                 {msg.familyMembers && msg.familyMembers.length > 0 && (
                                   <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm max-w-3xl">
                                     <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Enrolled Members</div>
                                     <div className="overflow-x-auto -mx-1">
                                       <table className="w-full min-w-[420px] text-[13px]">
                                         <thead>
                                           <tr className="border-b border-slate-100">
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Name</th>
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Relationship</th>
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Occupation</th>
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Declared Income</th>
                                           </tr>
                                         </thead>
                                         <tbody>
                                           {msg.familyMembers.map((m, i) => (
                                             <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                                               <td className="py-2 px-2 align-top font-semibold text-slate-800">{m.name || "—"}</td>
                                               <td className="py-2 px-2 align-top text-slate-600">{m.relationship || "—"}</td>
                                               <td className="py-2 px-2 align-top text-slate-500">{m.occupation || "—"}</td>
                                               <td className="py-2 px-2 align-top text-slate-500">
                                                 {m.declared_income != null ? `PKR ${Number(m.declared_income).toLocaleString()}` : "—"}
                                               </td>
                                             </tr>
                                           ))}
                                         </tbody>
                                       </table>
                                     </div>
                                   </div>
                                 )}

                                 {msg.organizationEmployees && msg.organizationEmployees.length > 0 && (
                                   <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm max-w-3xl">
                                     <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Enrolled Employees</div>
                                     <div className="overflow-x-auto -mx-1">
                                       <table className="w-full min-w-[480px] text-[13px]">
                                         <thead>
                                           <tr className="border-b border-slate-100">
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Employee</th>
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">ID</th>
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Designation</th>
                                             <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Class</th>
                                             <th className="text-right py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Cover</th>
                                           </tr>
                                         </thead>
                                         <tbody>
                                           {msg.organizationEmployees.map((e, i) => (
                                             <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                                               <td className="py-2 px-2 align-top font-semibold text-slate-800">{e.name || "—"}</td>
                                               <td className="py-2 px-2 align-top text-slate-500">{e.employee_id || "—"}</td>
                                               <td className="py-2 px-2 align-top text-slate-500">{e.designation || "—"}</td>
                                               <td className="py-2 px-2 align-top text-slate-600">{e.benefit_class || "—"}</td>
                                               <td className="py-2 px-2 align-top text-right tabular-nums text-slate-700">
                                                 {e.coverage_amount != null ? `PKR ${Number(e.coverage_amount).toLocaleString()}` : "—"}
                                               </td>
                                             </tr>
                                           ))}
                                         </tbody>
                                       </table>
                                     </div>
                                   </div>
                                 )}

                                 {/* AI Message Action Bar (Perplexity Style) */}
                                 <div className="flex items-center justify-between w-full mt-1 pt-1 text-slate-400 max-w-3xl">
                                   <div className="flex items-center gap-3 md:gap-4">
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Share">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Download">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                     </button>
                                     <button type="button" title="Copy" onClick={() => navigator.clipboard.writeText(msg.text)} className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                     </button>
                                     <button type="button" onClick={() => regenerate(msg.id)} disabled={isLoading || riskSteps.length > 0 || bulkSteps.length > 0} className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title="Regenerate from here — drops everything after this reply">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                     </button>
                                   </div>
                                   <div className="flex items-center gap-2">
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Helpful">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Unhelpful">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"></path></svg>
                                     </button>
                                     <button type="button" className="p-1 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="More">
                                       <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z"></path></svg>
                                     </button>
                                   </div>
                                 </div>
                               </div>
                             )}
                           </div>
                           
                           {/* Quick Actions — falls back to turnActions (set the
                               moment a quick_actions SSE event lands, independent
                               of message-array timing) so the latest reply's
                               buttons never silently go missing. */}
                           {(() => {
                             const isLast = msgIdx === messages.length - 1;
                             // A reply that just narrates in prose without calling a tool this
                             // turn (e.g. re-listing missing documents from earlier context)
                             // never gets its own quick_actions SSE event, so msg.quickActions
                             // is empty — falling back straight to turnActions would then show
                             // a stale, unrelated action set (turnActions deliberately strips
                             // upload actions, assuming they live on the message that requested
                             // them). Derive fresh, content-matched actions from this message's
                             // own text first, so "documents are missing" always gets its upload
                             // chips back even when no backend tool_call fired this turn.
                             // Only reach for the content-derived fallback on the specific
                             // "documents are missing" pattern — getRecommendedActions' final
                             // branch is a broad catch-all (Rule Engine/Commission Engine
                             // shortcuts) that would misfire on almost any plain reply.
                             const lowerText = (msg.text || "").toLowerCase();
                             const looksLikeMissingDocs = msg.role === "assistant" &&
                               (lowerText.includes("missing documents") ||
                                (lowerText.includes("missing") && lowerText.includes("document")) ||
                                (lowerText.includes("upload") && lowerText.includes("document")));
                             const contentActions = looksLikeMissingDocs ? getRecommendedActions(msg) : [];
                             const effectiveActions = msg.quickActions && msg.quickActions.length > 0
                               ? msg.quickActions
                               : contentActions.length > 0
                               ? contentActions
                               : (isLast && msg.role === "assistant" ? turnActions : undefined);
                             if (!effectiveActions || effectiveActions.length === 0) return null;
                             return (
                             <div className={`flex flex-wrap gap-2 mt-4 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                               {effectiveActions.map((action, idx) => {
                                 if (action.actionType === "select") {
                                   return (
                                     <QuickActionSelect
                                       key={`select-${action.label}-${idx}`}
                                       action={action}
                                       onRun={(text) => handleSubmit(undefined, text)}
                                       variant="card"
                                       selectedLabel={msg.selections?.[idx]}
                                       onSelected={(label) => recordSelection(msg.id, idx, label)}
                                     />
                                   );
                                 }
                                 const isUploaded = checkIsUploaded(action, uploadedDocs);
                                 const usedIdx = usedActions[msg.id];
                                 const isChosen = usedIdx === idx;
                                 const isLocked = !isPassiveAction(action) && usedIdx !== undefined && !isChosen;
                                 return (
                                   <button
                                     key={`${action.actionType}-${action.label}-${idx}`}
                                     disabled={isLocked || isChosen}
                                     onClick={() => {
                                       if (!isPassiveAction(action)) {
                                         setUsedActions(prev => ({ ...prev, [msg.id]: idx }));
                                       }
                                       handleQuickAction(action);
                                     }}
                                     className={`px-3 py-1.5 text-xs font-semibold rounded-full border shadow-sm transition-all flex items-center gap-1.5 ${
                                       isUploaded
                                         ? "bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-600 font-bold"
                                         : isChosen
                                         ? "bg-blue-600 text-white border-blue-600 font-bold cursor-default"
                                         : isLocked
                                         ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
                                         : "bg-white border-slate-200 hover:bg-slate-50 hover:border-blue-200 hover:text-blue-700"
                                     }`}
                                   >
                                     {isUploaded ? (
                                       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M20 6L9 17l-5-5" /></svg>
                                     ) : action.actionType === "navigate" ? (
                                       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
                                     ) : action.actionType === "upload" ? (
                                       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                                     ) : null}
                                     {isUploaded ? `Uploaded ${action.label.replace(/^Upload\s+/i, "")}` : action.label}
                                   </button>
                                 );
                               })}
                             </div>
                             );
                           })()}
                         </div>
                       </div>
                     </div>
                   ))}

                   {/* Live case view — embedded inline in the conversation
                       (not an overlay/modal, not a sidebar) so it reads as
                       part of this reply and the chat stays fully usable
                       above and below it. Remounts on every open via `key`,
                       so it always reflects the case's current stage/status
                       rather than a stale snapshot from when it first loaded. */}
                   {casePanel && (
                     <div className="w-full px-4 py-4">
                       <div className="max-w-5xl mx-auto">
                         <div className="rounded-2xl border border-slate-200 shadow-sm bg-white flex flex-col overflow-hidden">
                           <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50 shrink-0">
                             <div className="flex items-center gap-2 min-w-0">
                               <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                               <span className="font-bold text-xs text-slate-800 truncate">{casePanel.title}</span>
                             </div>
                             <div className="flex items-center gap-1 shrink-0">
                               {/* Sideways scroll for the embedded page. Overlay scrollbars (Firefox on
                                   Linux, macOS) stay hidden until hovered, so these are always there. */}
                               <button
                                 type="button"
                                 onClick={() => scrollCasePanel(-1)}
                                 title="Scroll left"
                                 className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
                               >
                                 <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                               </button>
                               <button
                                 type="button"
                                 onClick={() => scrollCasePanel(1)}
                                 title="Scroll right"
                                 className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
                               >
                                 <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                               </button>
                               <a
                                 href={casePanel.url}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 title="Open in new tab"
                                 className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
                               >
                                 <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                               </a>
                               <button
                                 type="button"
                                 onClick={() => setCasePanel(null)}
                                 title="Close"
                                 className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
                               >
                                 <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                               </button>
                             </div>
                           </div>
                           {/* The embedded pages are laid out for a desktop width, so the frame
                               keeps a minimum width and the panel scrolls sideways when the chat
                               column is narrower — instead of cutting the right-hand side off. */}
                           <div
                             ref={casePanelScrollRef}
                             className="overflow-x-auto overflow-y-hidden [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-track]:bg-slate-100"
                           >
                             <iframe
                               ref={casePanelFrameRef}
                               key={casePanel.url}
                               src={casePanel.url}
                               className="w-full border-0 block"
                               style={{ height: "70vh", minWidth: 980 }}
                               title={casePanel.title}
                             />
                           </div>
                         </div>
                       </div>
                     </div>
                   )}

                   {isLoading && (
                     <div className="w-full px-4 py-6">
                       <div className="max-w-3xl mx-auto flex gap-4 md:gap-6">
                         <div className="flex-shrink-0 mt-1">
                           <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-[0_0_12px_rgba(99,102,241,0.3)] flex items-center justify-center p-1.5 ring-2 ring-white">
                              <img src="/rizvi.png" alt="Agent" className="w-full h-full object-contain brightness-0 invert" />
                           </div>
                         </div>
                         <div className="flex items-center gap-2 pt-2">
                           <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" style={{ animationDelay: "0ms" }} />
                           <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" style={{ animationDelay: "150ms" }} />
                           <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" style={{ animationDelay: "300ms" }} />
                         </div>
                       </div>
                     </div>
                   )}
                   <div ref={messagesEndRef} />
                 </div>
               )}
             </div>
           </div>

           {/* Bottom Input Area for ongoing chat (when not empty state) */}
           {!showJourneyMap && (messages.length > 1 || (messages.length === 1 && messages[0].role !== "assistant") ? (
             <div className="w-full px-4 z-20 pb-4 bg-[#fdfdfe] dark:bg-[#0f172a]">
               <div className="max-w-3xl mx-auto relative flex flex-col gap-2">
                 
                 {/* Suggestions are now shown in the right panel (below) */}
                 {(() => {
                   const actionsToShow = turnActions.length > 0
                     ? turnActions
                     : (messages[messages.length - 1]?.role === "assistant" 
                         ? getRecommendedActions(messages[messages.length - 1]) 
                         : []);
                   
                   const extraActions = suggestedActions
                     .filter((s) => !actionsToShow.some((a) => a.label === s))
                     .map((s) => ({ label: s, actionType: "submit", payload: s } as QuickAction));
                   
                   const finalActions = [...actionsToShow, ...extraActions];
                   
                   if (finalActions.length === 0) return null;
                   
                   return (
                     <div className="flex flex-wrap gap-2 px-1 pb-1 hidden">
                       {finalActions.slice(0, 5).map((action, idx) => (
                         <button
                           key={`${action.actionType}-${idx}`}
                           onClick={() => handleQuickAction(action)}
                           className="px-3.5 py-1.5 text-xs font-semibold rounded-full bg-white/90 dark:bg-zinc-800/90 backdrop-blur-md border border-slate-200/80 hover:bg-white dark:hover:bg-zinc-700 hover:border-indigo-300 hover:text-indigo-700 hover:shadow-sm text-slate-700 transition-all flex items-center gap-1.5 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
                         >
                           {action.actionType === "navigate" ? (
                             <svg className="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                           ) : action.actionType === "upload" ? (
                             <svg className="w-3.5 h-3.5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                           ) : (
                             <svg className="w-3.5 h-3.5 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                           )}
                           {action.label}
                         </button>
                       ))}
                     </div>
                   );
                 })()}

                 <div className="w-full relative shadow-[0_8px_30px_rgb(0,0,0,0.06)] rounded-2xl bg-white/70 dark:bg-zinc-800/70 backdrop-blur-xl border border-white/60 dark:border-white/10 focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-500/10 transition-all duration-300">
                   {selectedFile && (
                     <div className="px-4 pt-4 pb-0 flex items-center gap-2">
                       <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3 p-2 pr-3 min-w-[160px] max-w-[260px]">
                         {selectedFile.type.startsWith("image/") && selectedFileUrl ? (
                           <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-slate-200">
                             <img src={selectedFileUrl} alt="preview" className="w-full h-full object-cover" />
                           </div>
                         ) : (
                           <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-red-100 text-red-500 flex items-center justify-center">
                             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                           </div>
                         )}
                         <div className="flex flex-col min-w-0 flex-1">
                           <span className="text-sm font-semibold text-slate-700 truncate">{selectedFile.name}</span>
                           <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{selectedFile.type.startsWith("image/") ? "Image" : "Document"}</span>
                         </div>
                         <button
                           type="button"
                           onClick={() => setSelectedFile(null)}
                           className="absolute top-1 right-1 p-1 bg-white/80 hover:bg-white dark:bg-zinc-700/80 dark:hover:bg-zinc-700 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-all text-slate-500 hover:text-red-500"
                         >
                           <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                         </button>
                       </div>
                     </div>
                   )}
                   <form onSubmit={handleSubmit} className="flex flex-col w-full">
                     <textarea 
                       rows={1}
                       value={input}
                       onChange={(e) => setInput(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === 'Enter' && !e.shiftKey) {
                           e.preventDefault();
                           handleSubmit();
                         }
                       }}
                       placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Ask anything..."}
                       className="w-full max-h-48 px-5 pt-4 pb-2 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-[16px] text-slate-900 placeholder:text-slate-400"
                       style={{ minHeight: "60px" }}
                     />
                     
                     <div className="flex items-center justify-between px-3 pb-3">
                       <div className="flex items-center gap-1">
                         <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors">
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4M4 12h16"/></svg>
                           Attach
                         </button>
                       </div>
                       <div className="flex items-center">
                         <button type="submit" disabled={(!input.trim() && !selectedFile) || isLoading} className="p-2 bg-[#1a1a1a] hover:bg-black dark:bg-blue-600 dark:hover:bg-blue-500 text-white rounded-full disabled:bg-slate-100 disabled:text-slate-300 transition-colors flex items-center justify-center h-10 w-10">
                           <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7"/></svg>
                         </button>
                       </div>
                     </div>
                   </form>
                 </div>
               </div>
             </div>
           ) : null)}
        </div>
        </div>
        {/* Right sidebar: static — stays mounted for the whole conversation so
            the pipeline's live/settled status is always visible alongside chat,
            instead of scrolling away as part of one message bubble. */}
        {!showJourneyMap && !(messages.length <= 1 && messages[0]?.role === "assistant") && (() => {
          const actionsToShow = turnActions.length > 0
            ? turnActions
            : (messages[messages.length - 1]?.role === "assistant"
                ? getRecommendedActions(messages[messages.length - 1])
                : []);
          const extraActions = suggestedActions
            .filter((s) => !actionsToShow.some((a) => a.label === s))
            .map((s) => ({ label: s, actionType: "submit", payload: s } as QuickAction));
          const finalActions = [...actionsToShow, ...extraActions];
          return (
            <div className="hidden xl:flex flex-col w-[260px] flex-shrink-0 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-sm border-l border-slate-200/60 h-full overflow-y-auto custom-scrollbar py-5 px-3 gap-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-2 pb-2">Pipeline</div>
                {steps.length > 0 ? (
                  <ProcessGraph steps={steps} />
                ) : (
                  <p className="px-2 text-[12px] text-slate-400">No active process right now.</p>
                )}
              </div>
              {finalActions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 px-2 pb-1">Suggested Actions</div>
              {finalActions.slice(0, 8).map((action, idx) => {
                const isUploaded = checkIsUploaded(action, uploadedDocs);
                return (
                  <button
                    key={`rp-${action.actionType}-${idx}`}
                    onClick={() => handleQuickAction(action)}
                    className={`w-full text-left px-3 py-2.5 text-[12.5px] font-medium rounded-xl border transition-all shadow-sm flex items-start gap-2.5 group ${
                      isUploaded
                        ? "bg-emerald-50 hover:bg-emerald-100 border-emerald-300 text-emerald-800 font-bold"
                        : "bg-white hover:bg-indigo-50 border-slate-200/80 hover:border-indigo-200 hover:text-indigo-700 text-slate-700"
                    }`}
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      {isUploaded ? (
                        <svg className="w-3.5 h-3.5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" /></svg>
                      ) : action.actionType === "navigate" ? (
                        <svg className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                      ) : action.actionType === "upload" ? (
                        <svg className="w-3.5 h-3.5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                      ) : (
                        <svg className="w-3.5 h-3.5 text-violet-400 group-hover:text-violet-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                      )}
                    </span>
                    <span className="leading-snug">{isUploaded ? `Uploaded ${action.label.replace(/^Upload\s+/i, "")}` : action.label}</span>
                  </button>
                );
              })}
              </div>
              )}
            </div>
          );
        })()}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative overflow-hidden">
      {/* ── Clean white backdrop ───────────────────────────────────────── */}
      <div className="absolute inset-0 bg-slate-50" />

      {showVoice && <VoiceOverlay onClose={() => setShowVoice(false)} />}

      {docDialog && (
        <DocumentUploadDialog
          tenantId={localStorage.getItem("tenant_id") || DEFAULT_TENANT_ID}
          caseId={docDialog.case_id}
          caseNumber={docDialog.case_number}
          documentTypes={docDialog.document_types}
          onClose={() => setDocDialog(null)}
          onDone={handleDocDialogDone}
        />
      )}
      {acrModalCase && (
        <ACRModal
          caseId={acrModalCase.caseId}
          initial={null}
          onClose={() => {
            setAcrModalCase(null);
            resolveInterrupt({ success: false, message: "Okay, the ACR form was closed without submitting." });
          }}
          onDone={() => {
            const caseNum = acrModalCase.caseNumber;
            const caseId = acrModalCase.caseId;
            setAcrModalCase(null);
            resolveInterrupt({
              success: true,
              message: `✅ **Gate 2: Agent Confidential Report (ACR) Submitted** for case **${caseNum}**.\n\n👉 Next Gate: **Gate 3: Compliance / PEP Screening**.`,
              status: "Submitted",
              last_action: {
                tool_name: "submit_agent_confidential_report",
                entity_type: "case",
                entity_id: caseId,
                route: `case/${caseId}`,
                label: "ACR submitted",
              },
              quick_actions: [
                { label: "3. Compliance Screen (Gate 3)", actionType: "submit", payload: `Run compliance screening for case ${caseNum}` },
                { label: "Check Gate Status", actionType: "submit", payload: `Check pre-underwriting status for case ${caseNum}` },
              ],
            });
          }}
        />
      )}

      {/* ── Phone Frame / Desktop Frame ────────────────────────────────────────────────── */}
      <div className={`relative z-10 flex-1 flex flex-col ${isAutomationMode ? "max-w-4xl mx-auto w-full pt-8 pb-4" : "items-center justify-center p-3 sm:p-5"} min-h-0`}>
        <div className={`w-full flex-1 flex flex-col ${isAutomationMode ? "bg-white rounded-2xl shadow-xl border border-slate-200" : "max-w-[420px] bg-slate-900 rounded-[2.75rem] p-2.5 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.6)] ring-1 ring-white/20"} min-h-0 animate-in fade-in zoom-in-95 duration-500`}>
          {/* Screen */}
          <div className={`relative flex-1 flex flex-col bg-white overflow-hidden min-h-0 ${isAutomationMode ? "rounded-2xl" : "rounded-[2.25rem]"}`}>

            {/* ── Status Bar ─────────────────────────────────────────── */}
            {!isAutomationMode && (
              <div className="flex-shrink-0 relative bg-gradient-to-r from-blue-600 to-fuchsia-600 pt-2 pb-1 px-6 flex items-center justify-between text-white text-[11px] font-semibold">
                <span className="tabular-nums">{clock || "9:41"}</span>
                {/* Notch */}
                <div className="absolute left-1/2 -translate-x-1/2 top-1.5 w-24 h-5 bg-slate-900 rounded-full" />
                <div className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="14" width="3" height="6" rx="1" /><rect x="7" y="10" width="3" height="10" rx="1" /><rect x="12" y="6" width="3" height="14" rx="1" /><rect x="17" y="2" width="3" height="18" rx="1" /></svg>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 18a2 2 0 100 4 2 2 0 000-4zm0-5c1.7 0 3.3.66 4.5 1.8l-1.4 1.4A4.5 4.5 0 009 16.2l-1.4-1.4A6.4 6.4 0 0112 13zm0-4.5c2.9 0 5.6 1.15 7.6 3.1l-1.4 1.4A9 9 0 006 13.1l-1.4-1.4A10.7 10.7 0 0112 8.5z" /></svg>
                  <svg className="w-6 h-3.5" viewBox="0 0 28 14" fill="none"><rect x="1" y="1" width="22" height="12" rx="3" stroke="currentColor" strokeWidth="1.5" /><rect x="3" y="3" width="16" height="8" rx="1.5" fill="currentColor" /><rect x="24.5" y="4.5" width="2" height="5" rx="1" fill="currentColor" /></svg>
                </div>
              </div>
            )}

            {/* ── Chat Header ────────────────────────────────────────── */}
            <div className="flex-shrink-0 bg-gradient-to-r from-blue-600 to-fuchsia-600 px-4 pb-3 pt-1 flex items-center justify-between text-white shadow-lg">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-white logo-white flex items-center justify-center shadow-md overflow-hidden ring-2 ring-white/40">
                    <img src="/rizvi.png" alt="Rizviz" className="w-7 h-7 object-contain" />
                  </div>
                  <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-blue-400 ring-2 ring-blue-600" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-[15px] font-bold tracking-tight">Rizviz AI Agent</span>
                  <span className="text-[11px] text-white/80 font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-300 animate-pulse" /> Online · Automation
                  </span>
                </div>
              </div>
              <button onClick={handleClearChat} title="Clear chat" className="p-2 rounded-full hover:bg-white/15 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </button>
            </div>

            {/* ── Chat Feed ──────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-3.5 py-4 relative bg-gradient-to-b from-blue-50 via-white to-fuchsia-50" ref={scrollContainerRef}>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.04] z-0">
                <img src="/rizvi.png" alt="" className="w-1/2 max-w-[200px] object-contain" />
              </div>
              <div className="relative z-10 space-y-4 pb-2">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} items-end gap-2 group animate-in slide-in-from-bottom-2 duration-300`}>
                    {msg.role === "assistant" && (
                      <div className="w-7 h-7 rounded-full bg-white logo-white border border-blue-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                        <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                      </div>
                    )}
                    <div className={`max-w-[82%] px-4 py-2.5 text-[14px] leading-relaxed shadow-sm flex flex-col gap-3 ${msg.role === "user"
                        ? "bg-gradient-to-br from-blue-500 to-fuchsia-500 text-white rounded-2xl rounded-br-md"
                        : "bg-white border border-slate-100 text-slate-700 rounded-2xl rounded-bl-md"
                      }`}>
                      {msg.role === "user" ? (
                        <div className="flex flex-col gap-2">
                          <div className="whitespace-pre-wrap">{msg.text}</div>
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 justify-end mt-1">
                              {msg.attachments.map((att, idx) => (
                                <div key={idx} className="flex items-center gap-2 p-1 pr-2.5 bg-white/20 backdrop-blur-sm border border-white/30 rounded-full max-w-[200px]">
                                  {att.url.startsWith("data:image/") ? (
                                    <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0">
                                      <img src={att.url} alt={att.name} className="w-full h-full object-cover" />
                                    </div>
                                  ) : (
                                    <div className="w-5 h-5 rounded-full flex-shrink-0 bg-white/40 text-white flex items-center justify-center">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                                    </div>
                                  )}
                                  <span className="text-[11px] font-medium text-white truncate">{att.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="copilot-markdown">
                          <ReactMarkdown>{msg.text}</ReactMarkdown>
                          {msg.steps && msg.steps.length > 0 && (
                            <div className="mt-4 mb-1">
                              <ProcessGraph steps={msg.steps} compact={true} />
                            </div>
                          )}
                          {msg.assessment && (() => {
                            const aScores = msg.assessment.scores ?? {} as any;
                            const medicalPct = aScores.medical_score || 0;
                            const financialPct = aScores.financial_score || 0;
                            const fraudPct = aScores.fraud_probability ? Math.round(aScores.fraud_probability * 100) : 0;
                            const compositePct = aScores.composite_score || aScores.composite_risk_score || 0;
                            const scoreTier = (s: number) => s <= 25 ? { label: "Low Risk", text: "text-emerald-600", bar: "#22c55e" } : s <= 50 ? { label: "Moderate Risk", text: "text-amber-600", bar: "#f59e0b" } : s <= 75 ? { label: "Elevated Risk", text: "text-orange-500", bar: "#f97316" } : { label: "High Risk", text: "text-red-600", bar: "#ef4444" };
                            const ringColor = (s: number) => s <= 25 ? "border-emerald-500" : s <= 50 ? "border-amber-400" : s <= 75 ? "border-orange-500" : "border-red-500";
                            const dec = msg.assessment.ai_decision || "";
                            const decStyle = dec.toLowerCase().includes("approv") ? { bg: "bg-emerald-50", border: "border-emerald-200", icon: "text-emerald-600", title: "text-emerald-900", desc: "text-emerald-700" }
                              : dec.toLowerCase().includes("review") || dec.toLowerCase().includes("human") ? { bg: "bg-blue-50", border: "border-blue-200", icon: "text-blue-600", title: "text-blue-900", desc: "text-blue-700" }
                              : { bg: "bg-rose-50", border: "border-rose-200", icon: "text-rose-600", title: "text-rose-900", desc: "text-rose-700" };
                            const compTier = scoreTier(compositePct);
                            // Merge all reasons into one list with category tag
                            const allReasons: any[] = [
                              ...(msg.assessment.medical_reasons ?? []).map((r: any) => ({ ...r, _cat: "MEDICAL" })),
                              ...(msg.assessment.financial_reasons ?? []).map((r: any) => ({ ...r, _cat: "FINANCIAL" })),
                              ...(msg.assessment.fraud_reasons ?? []).map((r: any) => ({ ...r, _cat: "FRAUD" })),
                              ...(msg.assessment.reasons ?? []).filter((r: any) => !String(r?.observation || r?.reason || "").includes("->") && !String(r?.observation || r?.reason || "").toLowerCase().includes("composite")),
                            ];
                            const catIcon: Record<string, string> = { MEDICAL: "🩺", FINANCIAL: "💰", FRAUD: "🛡️" };
                            const ratingDot = (rating: string = "") => rating.toLowerCase().includes("high") ? "bg-red-500" : rating.toLowerCase().includes("moderate") || rating.toLowerCase().includes("elevated") ? "bg-amber-400" : "bg-emerald-500";
                            const ratingText = (rating: string = "") => rating.toLowerCase().includes("high") ? "text-red-600" : rating.toLowerCase().includes("moderate") || rating.toLowerCase().includes("elevated") ? "text-amber-600" : "text-emerald-600";
                            return (
                              <div className="mt-4 flex flex-col gap-3 text-[13px]">
                                {/* Block 1: Scores */}
                                <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">AI Risk Assessment</div>
                                  <div className="flex flex-col gap-4 mb-5">
                                    {[
                                      { label: "Medical Risk Score", pct: medicalPct },
                                      { label: "Financial Risk Score", pct: financialPct },
                                      { label: "Fraud Risk Score", pct: fraudPct },
                                    ].map(({ label, pct }) => {
                                      const t = scoreTier(pct);
                                      return (
                                        <div key={label}>
                                          <div className="flex justify-between items-center mb-1.5">
                                            <span className="font-semibold text-slate-800">{label}</span>
                                            <span className={`font-semibold ${t.text}`}>{t.label} <span className="font-black text-slate-900 ml-1">{pct}%</span></span>
                                          </div>
                                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: t.bar }} />
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {/* Composite ring */}
                                  <div className="flex items-center gap-5 pt-4 border-t border-slate-100">
                                    <div className={`relative w-20 h-20 rounded-full border-[5px] ${ringColor(compositePct)} flex items-center justify-center flex-shrink-0`}>
                                      <div className="text-center">
                                        <span className="block text-xl font-extrabold text-slate-900 leading-none">{compositePct}<span className="text-sm">%</span></span>
                                      </div>
                                    </div>
                                    <div>
                                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Composite Risk Score</p>
                                      <p className={`text-[15px] font-bold mt-1 ${compTier.text}`}>{compTier.label}</p>
                                    </div>
                                  </div>
                                </div>
                                {/* Block 2: AI Recommendation */}
                                <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">AI Recommendation</div>
                                  <div className={`p-3 rounded-xl border flex items-start gap-3 ${decStyle.bg} ${decStyle.border}`}>
                                    <svg className={`w-5 h-5 mt-0.5 flex-shrink-0 ${decStyle.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={dec.toLowerCase().includes("approv") ? "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" : "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"} /></svg>
                                    <div>
                                      <div className={`text-[11px] font-black uppercase tracking-wide ${decStyle.title}`}>{dec || "Pending"}</div>
                                      <div className={`text-[11px] mt-0.5 ${decStyle.desc}`}>
                                        {compositePct <= 25 ? "Low composite risk. Eligible for auto-approval." : compositePct <= 50 ? `Composite risk at ${compositePct}. Moderate risk factors detected.` : compositePct <= 75 ? `Composite risk at ${compositePct}. Departmental review required.` : `High composite risk at ${compositePct}. Manual underwriting required.`}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                {/* Block 3: AI Analysis table (only if reasons available) */}
                                {allReasons.length > 0 && (
                                  <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
                                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">AI Analysis</div>
                                    <div className="overflow-x-auto -mx-1">
                                      <table className="w-full min-w-[420px] text-[11.5px]">
                                        <thead>
                                          <tr className="border-b border-slate-100">
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400 w-[90px]">Category</th>
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400 w-[110px]">Parameter</th>
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400">Observation</th>
                                            <th className="text-left py-1.5 px-2 font-bold text-[10px] uppercase tracking-widest text-slate-400 w-[80px]">Risk</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {allReasons.slice(0, 12).map((r: any, i: number) => {
                                            const cat = r._cat || r.category || "GENERAL";
                                            const param = r.parameter || r.factor || "—";
                                            const obs = r.observation || r.reason || "—";
                                            const rating = r.risk_rating || r.risk_level || "Low";
                                            return (
                                              <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/60 transition-colors">
                                                <td className="py-2 px-2 align-top">
                                                  <span className="font-bold text-slate-600">{catIcon[cat] || "📋"} {cat}</span>
                                                </td>
                                                <td className="py-2 px-2 align-top font-semibold text-slate-800">{param}</td>
                                                <td className="py-2 px-2 align-top text-slate-500 leading-snug">{obs}</td>
                                                <td className="py-2 px-2 align-top">
                                                  <span className={`flex items-center gap-1.5 font-semibold ${ratingText(rating)}`}>
                                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ratingDot(rating)}`} />
                                                    {rating}
                                                  </span>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                    {/* Download button always at bottom of analysis table */}
                                    {msg.assessment.case_id && (
                                      <div className="flex justify-end mt-3 pt-3 border-t border-slate-100">
                                        <button
                                          onClick={() => handleDownloadPDF(msg.assessment?.case_id as string)}
                                          className="flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors shadow-sm"
                                        >
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                          Download PDF Report
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {/* Download button when no reasons table */}
                                {allReasons.length === 0 && msg.assessment.case_id && (
                                  <div className="flex justify-end">
                                    <button
                                      onClick={() => handleDownloadPDF(msg.assessment?.case_id as string)}
                                      className="flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors shadow-sm"
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                      Download PDF Report
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      {(() => {
                        const lowerText = (msg.text || "").toLowerCase();
                        const looksLikeMissingDocs = msg.role === "assistant" &&
                          (lowerText.includes("missing documents") ||
                           (lowerText.includes("missing") && lowerText.includes("document")) ||
                           (lowerText.includes("upload") && lowerText.includes("document")));
                        const phoneEffectiveActions = msg.quickActions && msg.quickActions.length > 0
                          ? msg.quickActions
                          : looksLikeMissingDocs
                          ? getRecommendedActions(msg)
                          : undefined;
                        if (!phoneEffectiveActions || phoneEffectiveActions.length === 0) return null;
                        return (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {phoneEffectiveActions.map((action, idx) => {
                            if (action.actionType === "select") {
                              return (
                                <QuickActionSelect
                                  key={`select-${action.label}-${idx}`}
                                  action={action}
                                  onRun={(text) => handleSubmit(undefined, text)}
                                  selectedLabel={msg.selections?.[idx]}
                                  onSelected={(label) => recordSelection(msg.id, idx, label)}
                                />
                              );
                            }
                            const isUploaded = checkIsUploaded(action, uploadedDocs);
                            const usedIdx = usedActions[msg.id];
                            const isChosen = usedIdx === idx;
                            const isLocked = !isPassiveAction(action) && usedIdx !== undefined && !isChosen;
                            return (
                            <button
                              key={`${action.actionType}-${action.label}-${idx}`}
                              disabled={isLocked || isChosen}
                              onClick={() => {
                                if (!isPassiveAction(action)) {
                                  setUsedActions(prev => ({ ...prev, [msg.id]: idx }));
                                }
                                handleQuickAction(action);
                              }}
                              className={`px-3 py-1.5 text-[12px] font-bold rounded-full border transition-all flex items-center gap-1.5 shadow-sm active:scale-95 ${
                                isUploaded
                                  ? "bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-600"
                                  : isChosen
                                    ? "bg-blue-600 hover:bg-blue-600 text-white border-blue-600 cursor-default"
                                    : isLocked
                                      ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
                                      : action.actionType === "navigate"
                                        ? "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                                        : action.actionType === "upload"
                                          ? "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200"
                                          : action.actionType === "confirm"
                                            ? "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                                            : "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                                }`}
                            >
                              {isUploaded ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M20 6L9 17l-5-5" /></svg>
                              ) : action.actionType === "navigate" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
                              ) : action.actionType === "upload" ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v8" /></svg>
                              )}
                              {isUploaded ? `Uploaded ${action.label.replace(/^Upload\s+/i, '')}` : action.label}
                            </button>
                            );
                          })}
                        </div>
                        );
                      })()}
                    </div>
                  </div>
                ))}
                {/* Live process graph — the agent narrating its own state
                    machine, node by node, while (and after) it works. */}
                {(steps.length > 0 || riskSteps.length > 0 || bulkSteps.length > 0) && (
                  <div className="flex justify-start items-start gap-2">
                    <div className="w-7 h-7 rounded-full bg-white logo-white border border-blue-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                      <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                    </div>
                    <div className="max-w-[82%] flex-1">
                      <ProcessGraph steps={bulkSteps.length > 0 ? bulkSteps : (riskSteps.length > 0 ? riskSteps : steps)} />
                    </div>
                  </div>
                )}
                {isLoading && (
                  <div className="flex justify-start items-end gap-2">
                    <div className="w-7 h-7 rounded-full bg-white logo-white border border-blue-100 shadow-sm flex flex-shrink-0 items-center justify-center overflow-hidden">
                      <img src="/rizvi.png" alt="Agent" className="w-5 h-5 object-contain" />
                    </div>
                    <div className="flex items-center gap-1.5 bg-white rounded-2xl rounded-bl-md px-4 py-3 shadow-sm border border-slate-100">
                      {[0, 1, 2].map(i => (
                        <span key={i} className="w-2 h-2 rounded-full bg-fuchsia-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                      ))}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* ── Input Area ─────────────────────────────────────────── */}
            <div className="flex-shrink-0 px-3 pt-2.5 pb-3 bg-white border-t border-slate-100">
              {selectedFile && (
                <div className="mb-2 flex items-center gap-2">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 text-xs font-semibold rounded-full border border-blue-100">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                    {selectedFile.name}
                    <button type="button" onClick={() => setSelectedFile(null)} className="ml-1 hover:text-blue-900 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
              )}
              <form onSubmit={handleSubmit} className="flex items-end gap-2">
                <GroupCensusClientTool interrupt={pendingInterrupt} resolve={resolveInterrupt} notify={notify} />
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setSelectedFile(file);
                    selectedFileRef.current = file;

                    if (interruptUploadRef.current) {
                      // Agent-initiated upload: picker was auto-opened by the
                      // client_execute interrupt — upload now and resume the
                      // graph so the agent narrates the result + next steps.
                      const { args } = interruptUploadRef.current;
                      interruptUploadRef.current = null;
                      try {
                        const result = await uploadDocument(args, file);
                        setSelectedFile(null);
                        resolveInterrupt(result);
                      } catch (err: any) {
                        setSelectedFile(null);
                        resolveInterrupt({ success: false, error: err.message || "Upload failed." });
                      }
                    } else if (pendingUploadRef.current) {
                      // Quick-action upload ("Upload Salary Slip" chip): upload
                      // directly, then hand the outcome to the agent so the
                      // conversation moves forward with fresh recommendations.
                      const args = pendingUploadRef.current;
                      pendingUploadRef.current = null;
                      try {
                        const result = await uploadDocument(args, file);
                        notify(`✅ ${result.message}`, true);
                        setUploadedDocs((prev) => [...prev, args.document_type]);
                        // Do not auto-send a message. The user can upload multiple docs
                        // and then click 'Retry Risk Assessment' manually.
                      } catch (err: any) {
                        notify(`⚠️ ${err.message || "Upload failed."}`, false);
                      } finally {
                        setSelectedFile(null);
                      }
                    } else if (autoSubmitPrompt) {
                      handleSubmit(undefined, `Upload ${file.name} as ${autoSubmitPrompt} for this case.`);
                      setAutoSubmitPrompt("");
                    }
                  }}
                  className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
                />
                {/* Pill input with inline actions */}
                <div className="flex-1 flex items-center gap-0.5 bg-slate-100 rounded-full pl-1.5 pr-1 py-1 focus-within:ring-2 focus-within:ring-blue-400/50 transition-all">
                  <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach Document"
                    className="p-2 text-slate-400 hover:text-blue-600 rounded-full transition-all shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  </button>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={pendingInterrupt?.kind === "clarify" ? "Type your answer…" : "Message…"}
                    className="flex-1 bg-transparent text-slate-900 py-1.5 focus:outline-none text-[14px] placeholder:text-slate-400 min-w-0 disabled:opacity-50"
                    disabled={isLoading || isUploading}
                  />
                  <button type="button" onClick={() => setShowVoice(true)} title="Live Voice Agent"
                    className="p-2 text-slate-400 hover:text-blue-600 rounded-full transition-all shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 18v-6a9 9 0 0118 0v6M3 18a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5zm16 0a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5z" /></svg>
                  </button>
                  <button type="button" onMouseDown={startRecording} onMouseUp={stopRecording}
                    onMouseLeave={() => isRecording && stopRecording()} title="Hold to dictate"
                    className={`p-2 rounded-full transition-all shrink-0 ${isRecording ? "bg-rose-100 text-rose-600 animate-pulse" : "text-slate-400 hover:text-blue-600"}`}>
                    {isRecording
                      ? <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                      : <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    }
                  </button>
                </div>
                <button type="submit" disabled={!input.trim() || isLoading || isUploading}
                  className="p-3 bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 disabled:from-slate-300 disabled:to-slate-300 text-white rounded-full transition-all shadow-lg shadow-fuchsia-500/30 active:scale-90 shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                </button>
              </form>
              {/* Recommended Next Steps — backend quick_actions are the source
                  of truth (each tool result ships context-aware suggestions);
                  the text heuristic only covers turns with no tool involved. */}
              <div className="flex items-center justify-center gap-1.5 mt-2 flex-wrap">
                {(turnActions.length > 0
                  ? turnActions
                  : getRecommendedActions(messages.length > 0 ? messages[messages.length - 1] : undefined)
                )
                  .slice(0, 3)
                  .map((action, idx) => {
                    const isUploaded = checkIsUploaded(action, uploadedDocs);
                    return (
                      <button
                        key={idx}
                        onClick={() => handleQuickAction(action)}
                        disabled={isLoading || isUploading}
                        className={`text-[10px] px-2.5 py-1 rounded-full font-medium transition-all border ${
                          (isLoading || isUploading) ? "opacity-60 cursor-not-allowed pointer-events-none " : ""
                        }${
                          isUploaded
                            ? "text-emerald-700 bg-emerald-100 hover:bg-emerald-200 border-emerald-300 font-bold"
                            : action.actionType === "navigate"
                              ? "text-emerald-600 hover:text-white hover:bg-emerald-600 border-emerald-200"
                              : action.actionType === "upload"
                                ? "text-amber-600 hover:text-white hover:bg-amber-600 border-amber-200"
                                : "text-blue-600 hover:text-white hover:bg-blue-600 border-blue-200"
                          }`}
                      >
                        {isUploaded ? `✓ Uploaded ${action.label.replace(/^Upload\s+/i, '')}` : action.label}
                      </button>
                    );
                  })}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── Floating Suggestions Panel ─────────────────────────────────── */}
      {suggestedActions.length > 0 && !isLoading && (
        <div className="absolute bottom-[100px] right-full mr-6 w-[280px] z-50 animate-in slide-in-from-right-8 fade-in duration-500 pointer-events-auto">
          <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-[0_15px_50px_-12px_rgba(0,0,0,0.15)] border border-slate-200 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 px-1">
              <span className="flex h-2.5 w-2.5 items-center justify-center rounded-full bg-blue-100">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              </span>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Suggested Next Actions</span>
            </div>
            <div className="flex flex-col gap-2">
              {suggestedActions.map((action, idx) => (
                <button
                  key={`${action}-${idx}`}
                  onClick={() => { setSuggestedActions([]); handleSubmit(undefined, action); }}
                  className="w-full text-left px-4 py-2.5 bg-slate-50 hover:bg-blue-50 text-slate-700 hover:text-blue-700 text-[13px] font-semibold rounded-xl border border-transparent hover:border-blue-100 transition-all active:scale-[0.98]"
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
