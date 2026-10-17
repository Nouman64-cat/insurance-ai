// The underwriting report for a case. On an ordinary case that is the one-person report; on a family policy it is ONE report
// with a section for every insured member (the head and a fully insured spouse), each with their own Medical / Financial /
// Fraud risk and verdict — so a spouse who scores badly can be declined full insurance while the head goes ahead.

import api from "@/app/services/api";
import { generateAssessmentPDF, generateFamilyAssessmentPDF, type FamilyReportMember, type PDFReportData } from "@/lib/pdf-export";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
const APPROVED = ["Auto Approve", "Approve with Loading"];

const tenant = () => localStorage.getItem("tenant_id") || "00000000-0000-0000-0000-000000000001";

/** Their latest assessment, shaped for the PDF, or null when the case has none yet. */
async function loadAssessment(caseId: string): Promise<PDFReportData | null> {
  const headers = { "X-Tenant-Id": tenant() };
  const list = await (await fetch(`${API_BASE}/assessments?case_id=${caseId}`, { headers })).json();
  if (!Array.isArray(list) || list.length === 0) return null;
  const d = await (await fetch(`${API_BASE}/assessments/${list[0].id}`, { headers })).json();
  return {
    customer_name: d.customer_name, customer_cnic: d.customer_cnic, case_id: d.case_id, created_at: d.created_at,
    medical_score: d.medical_score, financial_score: d.financial_score, fraud_probability: d.fraud_probability,
    composite_risk_score: d.composite_risk_score, ai_decision: d.ai_decision, suggested_loading: d.suggested_loading,
    reasons: d.reasons, ai_summary: d.ai_summary, product_name: list[0].product_name,
  };
}

/** What the assessment (and anything an underwriter did since) means for this person's cover. */
function statusOf(caseStatus: string, report: PDFReportData | null): FamilyReportMember["status"] {
  if (!report) return "Not assessed";
  const goodAi = APPROVED.includes(report.ai_decision);
  if (caseStatus === "Rejected") return "Rejected";
  if (caseStatus === "Approved") return "Approved";
  if (caseStatus === "Closed") return goodAi ? "Approved" : "Rejected";      // closed = left off the cover or already issued
  return goodAi ? "Approved" : report.ai_decision === "Decline" ? "Rejected" : "Needs review";
}

/** The family's report for any one of its cases; null when this case is not on a family policy with more than one insured life. */
export async function buildFamilyReport(caseId: string) {
  const detail = (await api.get(`/tenants/${tenant()}/cases/${caseId}/detail`)).data;
  const members: { case_id: string; name: string; relationship?: string | null; case_status: string }[] = detail?.family_members ?? [];
  if (members.length < 2) return null;

  const out: FamilyReportMember[] = [];
  for (const m of members) {
    const report = await loadAssessment(m.case_id);
    out.push({
      role: /^self$/i.test(String(m.relationship)) ? "Head" : "Spouse",
      name: m.name, status: statusOf(m.case_status, report), report,
    });
  }

  let nominees: { name: string; relationship: string; share_pct: number; amount: number | null }[] = [];
  const fam = detail?.family;
  if (fam?.group_id && fam?.policy_id) {
    try { nominees = (await api.get(`/tenants/${tenant()}/families/${fam.group_id}/family-policies/${fam.policy_id}/nominees`)).data?.nominees ?? []; } catch { /* the report still works without them */ }
  }
  return {
    family_name: fam?.name ?? detail?.principal_participant_name ?? "Family",
    policy_label: out.find((m) => m.report?.product_name)?.report?.product_name ?? null,
    members: out, nominees,
  };
}

/** Download the right report for this case: the family report on a family policy, the ordinary one otherwise. */
export async function generateCaseReportPDF(single: PDFReportData) {
  if (single.case_id) {
    try {
      const family = await buildFamilyReport(single.case_id);
      if (family) { await generateFamilyAssessmentPDF(family); return; }
    } catch { /* fall back to the one-person report */ }
  }
  await generateAssessmentPDF(single);
}
