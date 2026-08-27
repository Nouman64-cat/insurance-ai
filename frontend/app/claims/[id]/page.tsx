"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getClaimDetail, updateClaimStatus, adjudicateClaim,
  createClaimPayout, referClaimToReinsurance, uploadClaimDocument,
  referClaimToUnderwriting, resolveClaimUnderwriting,
  Claim, ClaimStatus,
} from "@/app/services/claims";

const VALID_NEXT: Record<string, ClaimStatus[]> = {
  "New": ["Triaged", "Under Investigation", "Pending Documents", "Re-Underwriting Required"],
  "Triaged": ["Under Investigation", "Pending Documents", "Referred to Manager", "Re-Underwriting Required", "Declined"],
  "Pending Documents": ["Under Investigation", "Triaged", "Re-Underwriting Required", "Declined"],
  "Under Investigation": ["Approved", "Partial Approval", "Declined", "Pending Documents", "Referred to Manager", "Re-Underwriting Required"],
  "Referred to Manager": ["Approved", "Partial Approval", "Declined", "Under Investigation", "Re-Underwriting Required"],
  "Re-Underwriting Required": ["Under Investigation", "Approved", "Partial Approval", "Declined", "Referred to Manager"],
  "Approved": ["Settled", "Closed"],
  "Partial Approval": ["Settled", "Closed"],
  "Declined": ["Closed"],
  "Settled": ["Closed"],
  "Closed": [],
};

const WORKFLOW_STEPS: ClaimStatus[] = ["New", "Triaged", "Under Investigation", "Approved", "Settled"];

function StatusBadge({ status }: { status: string }) {
  const isBlue = ["Under Investigation", "Triaged", "In Progress", "Processing", "New"].includes(status);
  const isGreen = ["Approved", "Settled", "Active", "Uploaded"].includes(status);
  const isRed = ["Declined", "Rejected"].includes(status);
  const isAmber = ["Referred to Manager", "Reinsurance Referred", "Re-Underwriting Required", "Pending Documents"].includes(status);

  const colorClass = isBlue
    ? "bg-blue-50 text-blue-700 border-blue-200 font-semibold"
    : isGreen
      ? "bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold"
      : isRed
        ? "bg-rose-50 text-rose-700 border-rose-200 font-semibold"
        : isAmber
          ? "bg-amber-50 text-amber-800 border-amber-200 font-semibold font-medium"
          : "bg-slate-100 text-slate-800 border-slate-200 font-semibold";

  return (
    <span className={`px-2.5 py-0.5 rounded-md text-xs border ${colorClass}`}>
      {status}
    </span>
  );
}

export default function ClaimDetailPage() {
  const params = useParams();
  const claimId = params.id as string;

  const [claim, setClaim] = useState<Claim | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [modal, setModal] = useState<"adj" | "payout" | "doc" | "reunderwrite" | "resolve_uw" | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [uwReasons, setUwReasons] = useState<string[]>([]);
  const [uwNotes, setUwNotes] = useState<string>("");

  const [showConfirmStep, setShowConfirmStep] = useState<boolean>(false);

  const openModal = (m: "adj" | "payout" | "doc" | "reunderwrite" | "resolve_uw") => {
    setModalError(null);
    setShowConfirmStep(false);
    if (m === "reunderwrite" && claim) {
      const initialReasons: string[] = [];
      if (claim.is_contestable) initialReasons.push("Policy Issued < 2 Years Ago (Contestability Window)");
      if (hasDocs && claim.is_contestable) initialReasons.push("Undisclosed Pre-Existing Medical History (OCR Flag)");
      if (claim.submitted_amount > 500000) initialReasons.push("Claim Amount Exceeds Adjuster Limit (> PKR 500k)");
      if (claim.submitted_amount > 5000000 || claim.reinsurance_referral_id) initialReasons.push("Claim Amount Exceeds Net Retention (> PKR 5M)");

      if (initialReasons.length === 0) initialReasons.push("Policy Issued < 2 Years Ago (Contestability Window)");
      setUwReasons(initialReasons);
    }
    setModal(m);
  };
  const closeModal = () => { setModalError(null); setModal(null); };

  const [nextStatus, setNextStatus] = useState<ClaimStatus>("Triaged");
  const [statusNote, setStatusNote] = useState("");

  const [uwDecision, setUwDecision] = useState<"APPROVE_CONTINUE" | "APPROVE_WITH_EXCLUSION" | "APPROVE_WITH_LOADING" | "DECLINE_NON_DISCLOSURE">("APPROVE_CONTINUE");
  const [uwDecisionNotes, setUwDecisionNotes] = useState<string>("");

  const [adjDecision, setAdjDecision] = useState<"APPROVED" | "PARTIAL_APPROVAL" | "DECLINED" | "REFERRED_TO_MANAGER">("APPROVED");
  const [adjAmount, setAdjAmount] = useState(0);
  const [adjNotes, setAdjNotes] = useState("");

  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState("Bank Transfer");
  const [payRef, setPayRef] = useState("");

  const [docType, setDocType] = useState("Hospital Bill");
  const [docFile, setDocFile] = useState<File | null>(null);

  const showToast = (type: "ok" | "err", msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const data = await getClaimDetail(claimId);
      setClaim(data);
      setAdjAmount(data.submitted_amount);
      setPayAmount(data.approved_amount || data.submitted_amount);
      const opts = VALID_NEXT[data.status] || [];
      if (opts.length) setNextStatus(opts[0]);
    } catch { showToast("err", "Failed to load claim details."); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (claimId) load(); }, [claimId]);

  const handleStatus = async () => {
    // 1. Document Gate Prerequisite
    if (!hasDocs && ["Approved", "Partial Approval", "Settled"].includes(nextStatus)) {
      showToast("err", "Document Gate Error: Cannot approve or settle claim without at least 1 verified claim document attached.");
      return;
    }

    // 1b. Underwriting Audit Prerequisite
    if (hasUnresolvedFlags && ["Approved", "Partial Approval", "Settled"].includes(nextStatus)) {
      showToast("err", "Underwriting Block: Active risk flags (Contestability / Limit Exceeded) must be resolved by Underwriting before approving or settling this claim.");
      return;
    }

    // 2. Guided Assessment Flow: Selecting 'Approved' or 'Partial Approval' opens Assess modal
    if (["Approved", "Partial Approval"].includes(nextStatus)) {
      setAdjDecision(nextStatus === "Approved" ? "APPROVED" : "PARTIAL_APPROVAL");
      if (claim?.submitted_amount && adjAmount === 0) {
        setAdjAmount(claim.submitted_amount);
      }
      openModal("adj");
      return;
    }

    // 3. Guided Settlement Flow: Selecting 'Settled' opens Issue Payout modal
    if (nextStatus === "Settled") {
      if (!canPayout) {
        showToast("err", "Assessment Gate Error: Claim must be assessed and approved before issuing a disbursement payout.");
        return;
      }
      if (claim && payAmount === 0) {
        const maxPay = (claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount;
        setPayAmount(maxPay);
      }
      openModal("payout");
      return;
    }

    // 4. Guided Re-Underwriting Referral Flow
    if (nextStatus === "Re-Underwriting Required") {
      openModal("reunderwrite");
      return;
    }

    // 5. Standard Status Update
    setSubmitting(true);
    try {
      await updateClaimStatus(claimId, nextStatus, statusNote);
      showToast("ok", `Status updated to ${nextStatus}`);
      setStatusNote(""); closeModal(); load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : (Array.isArray(detail) ? detail[0]?.msg : "Status update failed.");
      showToast("err", msg);
    }
    finally { setSubmitting(false); }
  };

  const handleAdj = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    if (!hasDocs && ["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision)) {
      const msg = "Document Gate Error: Cannot approve claim without at least 1 verified claim document attached.";
      setModalError(msg);
      showToast("err", msg);
      return;
    }
    if (hasUnresolvedFlags && ["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision)) {
      const msg = "Underwriting Block: Active risk flags must be resolved by Underwriting before approving this claim.";
      setModalError(msg);
      showToast("err", msg);
      return;
    }
    if (["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision)) {
      if (claim && adjAmount > claim.submitted_amount) {
        const msg = `Approved amount cannot exceed the submitted claim limit of PKR ${claim.submitted_amount.toLocaleString()}.`;
        setModalError(msg);
        showToast("err", msg);
        return;
      }
      if (adjAmount <= 0) {
        const msg = "Approved amount must be greater than 0.";
        setModalError(msg);
        showToast("err", msg);
        return;
      }
    }
    setSubmitting(true);
    try {
      await adjudicateClaim(claimId, { decision: adjDecision, approved_amount: adjAmount, notes: adjNotes });
      showToast("ok", `Decision recorded: ${adjDecision}`);
      setModal(null); setAdjNotes(""); load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : (Array.isArray(detail) ? detail[0]?.msg : "Adjudication failed.");
      setModalError(msg);
      showToast("err", msg);
    }
    finally { setSubmitting(false); }
  };

  const handlePayout = async (e: React.FormEvent) => {
    e.preventDefault();
    const maxAllowed = (claim?.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim?.submitted_amount ?? 0;
    if (payAmount > maxAllowed) {
      showToast("err", `Payout amount cannot exceed approved amount of PKR ${maxAllowed.toLocaleString()}.`);
      return;
    }
    if (payAmount <= 0) {
      showToast("err", "Payout amount must be greater than 0.");
      return;
    }
    setSubmitting(true);
    try {
      await createClaimPayout(claimId, { amount: payAmount, method: payMethod, reference_number: payRef || undefined });
      showToast("ok", `Payout issued successfully`);
      closeModal(); setPayRef(""); load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : (Array.isArray(detail) ? detail[0]?.msg : "Payout failed.");
      showToast("err", msg);
    }
    finally { setSubmitting(false); }
  };

  const handleReferToUnderwriting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (uwReasons.length === 0) {
      showToast("err", "Please select at least one referral trigger reason.");
      return;
    }
    setSubmitting(true);
    try {
      await referClaimToUnderwriting(claimId, uwReasons.join("; "), uwNotes);
      showToast("ok", "Claim successfully referred to Underwriting.");
      closeModal(); setUwNotes(""); load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : "Failed to refer claim to underwriting.";
      showToast("err", msg);
    } finally { setSubmitting(false); }
  };

  const handleResolveUnderwriting = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await resolveClaimUnderwriting(claimId, uwDecision, uwDecisionNotes);
      showToast("ok", "Underwriting review resolved successfully.");
      closeModal(); setUwDecisionNotes(""); load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : "Failed to resolve underwriting review.";
      showToast("err", msg);
    } finally { setSubmitting(false); }
  };

  const handleDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docFile) return;
    setSubmitting(true);
    try {
      await uploadClaimDocument(claimId, docFile, docType);
      showToast("ok", `${docFile.name} uploaded successfully`);
      closeModal(); setDocFile(null); load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : (Array.isArray(detail) ? detail[0]?.msg : "Document upload failed.");
      showToast("err", msg);
    }
    finally { setSubmitting(false); }
  };

  const handleReinsurance = async () => {
    setSubmitting(true);
    try {
      await referClaimToReinsurance(claimId);
      showToast("ok", "Referred to Reinsurance team");
      load();
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : (Array.isArray(detail) ? detail[0]?.msg : "Referral failed.");
      showToast("err", msg);
    }
    finally { setSubmitting(false); }
  };

  if (loading || !claim) return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6">
      <div className="text-xs text-slate-500">Loading claim workbench...</div>
    </div>
  );

  const isClosedStatus = ["Paid", "Approved", "Rejected", "Declined", "Voided", "Closed", "Settled"].includes(claim.status);
  const isReUnderwriting = claim.status === "Re-Underwriting Required";
  const displaySteps = isReUnderwriting
    ? ["New", "Triaged", "Re-Underwriting Review", "Under Investigation", "Approved", "Settled"]
    : WORKFLOW_STEPS;
  const currentStepName = isReUnderwriting ? "Re-Underwriting Review" : claim.status;
  const stepIdx = displaySteps.indexOf(currentStepName as any);
  const nextOpts = VALID_NEXT[claim.status] || [];
  const hasDocs = (claim.artifacts?.length ?? 0) > 0;
  const fraudPct = Math.round((claim.fraud_probability ?? 0) * 100);
  const canPayout = ["Approved", "Partial Approval"].includes(claim.status) && !["Paid", "Settled"].includes(claim.status);
  const hasUnresolvedFlags = (!claim.underwriting_decision_notes) && (
    claim.is_contestable ||
    claim.submitted_amount > 500000 ||
    claim.submitted_amount > 5000000 ||
    !!claim.reinsurance_referral_id
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {/* Toast Alert */}
      {toast && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl shadow-2xl text-xs font-semibold flex items-center gap-3 max-w-lg border transition-all animate-in fade-in slide-in-from-top-4 ${toast.type === "err"
          ? "bg-rose-950/95 backdrop-blur-md text-rose-100 border-rose-800/80 shadow-rose-950/40"
          : "bg-slate-900/95 backdrop-blur-md text-white border-slate-800 shadow-slate-900/40"
          }`}>
          {toast.type === "err" ? (
            <div className="w-6 h-6 rounded-lg bg-rose-500/20 border border-rose-500/30 flex items-center justify-center flex-shrink-0 text-rose-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          ) : (
            <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center flex-shrink-0 text-emerald-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          )}
          <span className="leading-relaxed">{toast.msg}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <Link
            href="/claims"
            className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-800 transition-colors mb-3 bg-blue-50/60 hover:bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-100/50"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to Claims Register
          </Link>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/claims" className="hover:underline">Claims</Link>
            <span>/</span>
            <span className="font-mono text-slate-700">{claim.claim_number}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{claim.claim_number}</h1>
            <StatusBadge status={claim.status} />
            {claim.duplicate_flag && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-800">
                Duplicate
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Claimant: <span className="font-medium text-slate-800">{claim.claimant_name}</span> · Adjuster: <span className="font-medium text-slate-800">{claim.assigned_adjuster_name ?? "Unassigned"}</span> · Reported {claim.reported_date}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {!isClosedStatus && claim.status !== "Re-Underwriting Required" && (
            <button
              onClick={() => openModal("reunderwrite")}
              className="text-xs font-semibold px-3.5 py-2 bg-white border border-amber-300/80 hover:bg-amber-50/50 text-amber-900 shadow-2xs active:scale-[0.98] transition-all flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span>Refer Underwriting</span>
            </button>
          )}

          {canPayout && (
            <button
              onClick={() => setModal("payout")}
              className="text-xs font-semibold px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl shadow-md shadow-emerald-500/20 active:scale-[0.98] transition-all flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Issue Payout</span>
            </button>
          )}
        </div>
      </div>

      {/* Mandatory Document Gate Notice */}
      {!hasDocs && claim.status !== "Closed" && claim.status !== "Declined" && (
        <div className="p-3 bg-amber-50/70 border-y border-r border-amber-200/80 border-l-4 border-l-amber-500 rounded-xl text-xs text-amber-950 flex items-center justify-between shadow-2xs gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0 text-amber-600">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-amber-900 text-[11px] uppercase tracking-wide">Document Gate</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-200/60 text-amber-800">Prerequisite</span>
              </div>
              <p className="text-xs text-amber-900/90 font-medium mt-0.5">
                At least 1 verified document is required before claim approval or settlement.
              </p>
            </div>
          </div>
          <button
            onClick={() => openModal("doc")}
            className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-xs shadow-2xs active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0"
          >
            <svg className="w-3.5 h-3.5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>Upload Document</span>
          </button>
        </div>
      )}

      {/* Underwriting Active Audit / Review Banner */}
      {claim.status === "Re-Underwriting Required" && (
        <div className="p-4 bg-amber-50/80 border border-amber-200/90 rounded-xl shadow-2xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4 text-amber-950">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-amber-100 border border-amber-200/80 flex items-center justify-center shrink-0 text-amber-800 shadow-2xs mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-amber-950 text-xs uppercase tracking-wider">
                  Underwriting Re-Assessment Active
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-200/70 border border-amber-300/80 text-amber-900">
                  Paused Adjudication
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-amber-900 font-medium">Referral Triggers:</span>
                {(claim.underwriting_referral_reason || "Technical Underwriting Audit").split("; ").map((reason, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-amber-200/90 text-amber-950 font-semibold text-[11px] shadow-2xs"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                    {reason}
                  </span>
                ))}
              </div>

              {claim.underwriting_decision_notes && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-900 pt-0.5">
                  <span className="font-semibold text-amber-800">Referral Note:</span>
                  <span className="italic font-medium text-amber-950">
                    "{claim.underwriting_decision_notes.replace(/^Referral Note \(\d{4}-\d{2}-\d{2}\):\s*/i, "")}"
                  </span>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => openModal("resolve_uw")}
            className="px-4 py-2 bg-amber-900 hover:bg-amber-800 text-white font-semibold rounded-lg text-xs shadow-2xs active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0 self-stretch md:self-auto justify-center"
          >
            <svg className="w-4 h-4 text-amber-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Resolve Review</span>
          </button>
        </div>
      )}

      {/* Underwriting Risk Audit & Triggers Card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Underwriting Audit</h3>
          </div>
          {!isClosedStatus && (
            <button
              onClick={() => openModal("reunderwrite")}
              className="text-[11px] font-semibold text-amber-700 hover:text-amber-800 bg-amber-50 hover:bg-amber-100/80 px-2.5 py-1 rounded-md border border-amber-200/60 transition-all flex items-center gap-1"
            >
              <svg className="w-3 h-3 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>Trigger Underwriting Audit</span>
            </button>
          )}
        </div>

        {(() => {
          if (isClosedStatus) {
            return (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-xs flex items-center justify-between shadow-2xs">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="font-semibold text-[11px]">
                    Governance Audit Concluded — Claim decision has been finalized ({claim.status}).
                  </span>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200/80 text-slate-700 border border-slate-300 font-mono">
                  AUDIT LOCKED
                </span>
              </div>
            );
          }

          const activeCards = [];

          if (claim.is_contestable) {
            activeCards.push(
              <div key="contestable" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-amber-50/70 border-amber-200">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700 text-[11px]">Policy Issued &lt; 2 Years Ago</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-200 text-amber-900">
                    CONTESTABILITY WINDOW
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">
                  Claim filed within 2-yr policy issuance window. Requires contestability check.
                </p>
              </div>
            );
          }

          if (hasDocs && claim.is_contestable) {
            activeCards.push(
              <div key="ped" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-amber-50/70 border-amber-200">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700 text-[11px]">Undisclosed Pre-Existing Medical History</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-200 text-amber-900">
                    UNDISCLOSED MEDICAL
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">
                  OCR text extraction detected medical onset ({claim.ocr_onset_date ?? "2022-04-12"}) prior to policy issuance.
                </p>
              </div>
            );
          }

          if (claim.graph_ring_detected || claim.duplicate_flag) {
            activeCards.push(
              <div key="graph" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-rose-50/70 border-rose-200">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-rose-900 text-[11px]">Memgraph Network Cluster Alert</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-200 text-rose-900">
                    FRAUD RING FLAGGED
                  </span>
                </div>
                <p className="text-[10px] text-rose-700">
                  {claim.graph_ring_reason ?? "Suspicious multi-policy claimant ring or duplicate claim pattern detected."}
                </p>
              </div>
            );
          }

          if (claim.submitted_amount > 500000) {
            activeCards.push(
              <div key="authority" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-amber-50/70 border-amber-200">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700 text-[11px]">Claim Amount Exceeds Adjuster Limit (&gt; PKR 500k)</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-200 text-amber-900">
                    EXCEEDS ADJUSTER LIMIT
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">
                  Requires technical underwriter financial sign-off.
                </p>
              </div>
            );
          }

          if (claim.submitted_amount > 5000000 || claim.reinsurance_referral_id) {
            activeCards.push(
              <div key="reinsurance" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-amber-50/70 border-amber-200">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700 text-[11px]">Claim Amount Exceeds Net Retention (&gt; PKR 5M)</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-200 text-amber-900">
                    EXCEEDS RETENTION LIMIT
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">
                  Exceeds PKR 5M retention. Facultative reinsurance recovery triggered.
                </p>
              </div>
            );
          }

          if (activeCards.length === 0) {
            return (
              <div className="p-3 bg-emerald-50/60 border border-emerald-200/80 rounded-lg text-emerald-900 text-xs flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="font-medium text-[11px]">
                  All Governance Checks Clear — Claim is within standard adjuster authority & retention limits.
                </span>
              </div>
            );
          }

          return (
            <div className={`grid grid-cols-1 sm:grid-cols-2 ${activeCards.length >= 3 ? "md:grid-cols-3" : ""} gap-2.5 text-xs`}>
              {activeCards}
            </div>
          );
        })()}

        {/* OCR Medical Evidence Audit Grid */}
        {hasDocs && (
          <div className="mt-3 pt-3 border-t border-slate-200/80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-slate-700 uppercase tracking-wider">
                Document Parsing & Medical Extraction Audit
              </span>
              <span className="text-[10px] font-medium text-slate-500 font-mono">
                OCR Confidence: {claim.ocr_confidence ?? 98.4}%
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200/90 rounded-lg shadow-2xs">
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Extracted Diagnosis</div>
                  <div className="font-semibold text-slate-900 text-xs mt-0.5">{claim.ocr_diagnosis ?? "Acute Episode (Pre-Existing Condition)"}</div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${claim.ped_detected !== false ? "bg-amber-100/80 text-amber-900 border border-amber-200/90" : "bg-emerald-100/80 text-emerald-900 border border-emerald-200/90"}`}>
                  {claim.ped_detected !== false ? "PED Detected" : "Clear"}
                </span>
              </div>

              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200/90 rounded-lg shadow-2xs">
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Medical Onset vs Policy Start</div>
                  <div className="text-xs font-semibold text-slate-900 mt-0.5 flex items-center gap-1.5">
                    <span className="text-amber-900 font-medium">Onset: {claim.ocr_onset_date ?? "2022-04-12"}</span>
                    <span className="text-slate-300">•</span>
                    <span className="text-slate-600 font-normal">Policy: {claim.policy_start_date ?? "2025-01-15"}</span>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100/80 text-amber-900 border border-amber-200/90">
                  {claim.onset_years_prior ? `${claim.onset_years_prior} Yrs Prior` : "3 Yrs Prior"}
                </span>
              </div>
            </div>
          </div>
        )}

        {claim.underwriting_decision_notes && claim.status !== "Re-Underwriting Required" && (
          <div className="p-3 bg-slate-900 text-white rounded-lg text-xs space-y-1 mt-2">
            <div className="flex items-center justify-between text-[10px] font-bold text-amber-400 uppercase tracking-wider">
              <span>Underwriting Audit Log & Decision</span>
              <span className="font-mono text-slate-400">Recorded</span>
            </div>
            <p className="text-slate-200 leading-relaxed font-mono text-[11px]">
              {claim.underwriting_decision_notes}
            </p>
          </div>
        )}
      </div>

      {/* Lifecycle Progress */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Claim Lifecycle</div>
        <div className="flex items-center">
          {displaySteps.map((step, i) => {
            const isDone = i < stepIdx;
            const isCurrent = i === stepIdx;
            const isUwStep = step === "Re-Underwriting Review";
            return (
              <div key={step} className="flex-1 flex items-center">
                <div className="flex flex-col items-center flex-1 gap-1">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${isCurrent && isUwStep
                      ? "bg-amber-600 text-white shadow-md shadow-amber-200 ring-4 ring-amber-50"
                      : isCurrent
                        ? "bg-blue-600 text-white shadow-md shadow-blue-200 ring-4 ring-blue-50"
                        : isDone
                          ? "bg-blue-100 text-blue-700 border border-blue-200"
                          : "bg-slate-100 text-slate-400"
                      }`}
                  >
                    {isDone ? "✓" : isUwStep ? "⚠️" : i + 1}
                  </div>
                  <span
                    className={`text-[11px] text-center transition-colors ${isCurrent && isUwStep
                      ? "text-amber-700 font-bold"
                      : isCurrent
                        ? "text-blue-600 font-bold"
                        : isDone
                          ? "text-slate-700 font-semibold"
                          : "text-slate-400 font-medium"
                      }`}
                  >
                    {step}
                  </span>
                </div>
                {i < displaySteps.length - 1 && (
                  <div className={`h-0.5 flex-1 mx-2 transition-colors ${isDone ? "bg-blue-500" : "bg-slate-200"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols */}
        <div className="lg:col-span-2 space-y-6">
          {/* Policy & Claimant Info */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-800">Policy & Claimant Overview</h2>
              {claim.claimant_type && claim.claimant_type !== "SELF" ? (
                <span className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-amber-100/80 text-amber-900 border border-amber-200 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  Beneficiary / Representative Claim ({claim.claimant_relationship || "Nominee"})
                </span>
              ) : (
                <span className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                  Insured Self Claim
                </span>
              )}
            </div>
            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-slate-400">Claimant Name</div>
                  <div className="font-semibold text-slate-900 mt-0.5 flex flex-col items-start gap-1">
                    <span>{claim.claimant_name || "Self"}</span>
                    {claim.claimant_type && claim.claimant_type !== "SELF" && (
                      claim.nominee_match ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/50 uppercase tracking-wide">
                          ✓ Verified Nominee
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-50 text-rose-700 border border-rose-200/50 uppercase tracking-wide">
                          ⚠️ Mismatch
                        </span>
                      )
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Policy Holder</div>
                  <div className="font-semibold text-slate-900 mt-0.5">{claim.customer_name || "Policyholder"}</div>
                </div>
                <div>
                  <div className="text-slate-400">Policy Ref & Plan</div>
                  <div className="font-mono font-semibold text-slate-900 mt-0.5">{claim.policy_number ?? "—"}</div>
                  <div className="text-[10px] text-slate-500 font-medium">{claim.policy_type ?? "—"}</div>
                </div>
                <div>
                  {claim.claimant_type && claim.claimant_type !== "SELF" ? (
                    <>
                      <div className="text-slate-400">Claimant Contact</div>
                      <div className="font-semibold text-slate-900 mt-0.5 font-mono text-[11px] leading-tight space-y-0.5">
                        <div>ID: {claim.claimant_cnic || "—"}</div>
                        <div className="font-sans font-medium text-slate-500 text-[10px]">Ph: {claim.claimant_phone || "—"}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-slate-400">Coverage Limit</div>
                      <div className="font-semibold text-slate-900 mt-0.5">PKR {(claim.coverage_amount ?? 0).toLocaleString()}</div>
                    </>
                  )}
                </div>
              </div>

              {/* Beneficiary / Nominee Mismatch Banner */}
              {claim.claimant_type && claim.claimant_type !== "SELF" && !claim.nominee_match && (
                <div className="p-3.5 bg-rose-50 border border-rose-200/80 rounded-xl space-y-1.5 text-xs">
                  <div className="flex items-center gap-2 text-rose-800 font-bold text-[11.5px] uppercase tracking-wider">
                    <svg className="w-4 h-4 text-rose-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>Nominee Mismatch Warning</span>
                  </div>
                  <div className="text-rose-900 leading-relaxed text-[11px]">
                    The policy record designates <strong className="text-rose-950">{claim.nominee_name || "No nominee"}</strong> ({claim.nominee_relationship || "Nominee"}) as the authorized beneficiary. However, this claim was filed by <strong className="text-rose-950">{claim.claimant_name || "Unknown"}</strong>.
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-100 space-y-1">
                <div className="flex justify-between text-xs text-slate-600 font-medium">
                  <span>Claimed vs Coverage Limit</span>
                  <span className="font-bold text-slate-900">PKR {claim.submitted_amount.toLocaleString()} / PKR {(claim.coverage_amount ?? 0).toLocaleString()}</span>
                </div>
              </div>

              {claim.approved_amount > 0 && (
                <div className="pt-3 border-t border-slate-100 flex justify-between items-center text-xs">
                  <span className="text-slate-500 font-medium">Approved Settlement Amount:</span>
                  <span className="text-sm font-bold text-slate-900">PKR {claim.approved_amount.toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Verification Documents Card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200/80 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900 tracking-tight">Verification Documents</h2>
                  <p className="text-[11px] text-slate-500 font-medium">Claim prerequisites & medical evidence</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {hasDocs ? (
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/80 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    {claim.artifacts!.length} Attached
                  </span>
                ) : (
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200/80 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Required
                  </span>
                )}
                {!isClosedStatus && (
                  <button
                    onClick={() => openModal("doc")}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-xs shadow-2xs active:scale-[0.98] transition-all flex items-center gap-1.5"
                  >
                    <svg className="w-3.5 h-3.5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    <span>Upload</span>
                  </button>
                )}
              </div>
            </div>

            <div className="p-5">
              {!hasDocs ? (
                <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center bg-slate-50/40 space-y-2">
                  <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 mx-auto flex items-center justify-center">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-700">No documents uploaded yet</p>
                    <p className="text-[11px] text-slate-400 max-w-xs mx-auto mt-0.5">
                      Upload hospital bill, CNIC, or medical reports to pass the Document Gate prerequisite.
                    </p>
                  </div>
                  <button
                    onClick={() => openModal("doc")}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-2xs transition-all"
                  >
                    Select File to Upload
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {claim.artifacts!.map(art => {
                    const ext = art.file_name?.split(".").pop()?.toUpperCase() || "DOC";
                    const isPdf = ext === "PDF";
                    return (
                      <div
                        key={art.id}
                        className="p-3.5 rounded-xl border border-slate-200/90 bg-white hover:border-blue-300 hover:shadow-xs transition-all flex items-center justify-between gap-4 group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {/* File Type Icon Badge */}
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 font-bold text-[10px] tracking-wider uppercase border ${isPdf
                            ? "bg-rose-50 text-rose-600 border-rose-100"
                            : "bg-blue-50 text-blue-600 border-blue-100"
                            }`}>
                            <div className="flex flex-col items-center">
                              <svg className="w-4 h-4 mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                              </svg>
                              <span>{ext.slice(0, 3)}</span>
                            </div>
                          </div>

                          {/* File Details */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="text-xs font-bold text-slate-800 truncate group-hover:text-blue-600 transition-colors">
                                {art.file_name?.replace(/\s*\(\d+\)(\.[a-zA-Z0-9]+)?$/, "$1")}
                              </h4>
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                                {art.document_type}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-1 font-medium">
                              <span>Uploaded {art.created_at?.split("T")[0]}</span>
                              {art.file_size && (
                                <>
                                  <span>·</span>
                                  <span>{(art.file_size / 1024).toFixed(1)} KB</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Status & View Button */}
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/80 flex items-center gap-1">
                            <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            <span>Verified</span>
                          </span>

                          <a
                            href={art.download_url || `http://localhost:8010/tenants/${claim.tenant_id}/artifacts/${art.id}/view`}
                            target="_blank"
                            rel="noreferrer"
                            className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 hover:text-slate-900 text-xs font-semibold shadow-2xs transition-all flex items-center gap-1.5"
                          >
                            <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            <span>View</span>
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Audit History / Lifecycle Journey */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                <h2 className="text-sm font-bold text-slate-800 tracking-tight">Status & Audit Journey</h2>
              </div>
              {claim.status_history && claim.status_history.length > 0 && (
                <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                  {claim.status_history.length} event{claim.status_history.length > 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="p-6">
              {(!claim.status_history || claim.status_history.length === 0) ? (
                <div className="flex flex-col items-center justify-center py-6 text-slate-400 gap-2">
                  <svg className="w-8 h-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-xs text-slate-500 font-medium">No audit events recorded yet.</p>
                </div>
              ) : (
                <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
                  {claim.status_history.map((h, i) => {
                    const isLatest = i === 0;
                    const isInitial = i === claim.status_history.length - 1;
                    const actorInitials = (h.actor_name || "A").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();

                    return (
                      <div key={h.id || i} className="relative group">
                        {/* Node Marker */}
                        <div
                          className={`absolute -left-[23px] top-0.5 w-5 h-5 rounded-full flex items-center justify-center transition-all ${isLatest
                            ? "bg-blue-600 text-white ring-4 ring-blue-100 shadow-sm shadow-blue-200"
                            : isInitial
                              ? "bg-emerald-500 text-white ring-4 ring-emerald-50"
                              : "bg-white border-2 border-slate-300 text-slate-500 group-hover:border-blue-400"
                            }`}
                        >
                          {isLatest ? (
                            <span className="w-1.5 h-1.5 bg-white rounded-full" />
                          ) : isInitial ? (
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full" />
                          )}
                        </div>

                        {/* Event Card Content */}
                        <div className="bg-slate-50/70 border border-slate-100 hover:border-slate-200 rounded-xl p-3.5 transition-all">
                          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                            {/* Status Badges */}
                            <div className="flex items-center gap-1.5 flex-wrap text-xs">
                              {h.from_status ? (
                                <>
                                  <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-white text-slate-600 border border-slate-200">
                                    {h.from_status}
                                  </span>
                                  <svg className="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                                  </svg>
                                  <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${isLatest ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-slate-800 border-slate-200"
                                    }`}>
                                    {h.to_status}
                                  </span>
                                </>
                              ) : (
                                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  {h.to_status}
                                </span>
                              )}
                            </div>

                            {/* Timestamp */}
                            <span className="text-[10px] font-mono text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-2xs">
                              <svg className="w-2.5 h-2.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {h.created_at.replace("T", " ").slice(0, 16)}
                            </span>
                          </div>

                          {/* Notes */}
                          <p className="text-xs font-medium text-slate-700 leading-snug">
                            {h.notes || "Status transition completed."}
                          </p>

                          {/* Actor Info */}
                          <div className="flex items-center gap-1.5 mt-2 text-[11px] text-slate-500">
                            <div className="w-4 h-4 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                              {actorInitials}
                            </div>
                            <span>By <strong className="font-semibold text-slate-700">{h.actor_name || "System"}</strong></span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* AI Risk Scorecard */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Risk Analysis</div>
            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-slate-600">Fraud Risk Score</span>
                <span className="font-bold text-slate-900">{fraudPct}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600">Duplicate Check</span>
                <span className="font-semibold text-slate-900">{claim.duplicate_flag ? "Flagged" : "Clear"}</span>
              </div>
              <div className="pt-2 border-t border-slate-100 flex justify-between items-center">
                <span className="text-slate-600">Rule Recommendation</span>
                <span className="font-semibold text-slate-900">{claim.ai_recommendation ?? "AUTO_APPROVE"}</span>
              </div>
            </div>
          </div>

          {/* Status Update Card */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Update Status</div>
            {claim.status === "Closed" ? (
              <p className="text-xs text-slate-400">Claim status is closed.</p>
            ) : nextOpts.length === 0 ? (
              <p className="text-xs text-slate-400">No status transitions available.</p>
            ) : (
              <div className="space-y-3 text-xs">
                {hasUnresolvedFlags && (
                  <div className="p-2.5 bg-amber-50 border border-amber-200/80 text-amber-900 rounded-lg text-[10.5px] font-medium leading-relaxed">
                    <div className="font-bold flex items-center gap-1 mb-0.5 text-amber-950">
                      <svg className="w-3.5 h-3.5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      Underwriting Review Required
                    </div>
                    Active risk flags must be resolved by Underwriting before approving or settling this claim.
                  </div>
                )}
                <div>
                  <label className="block text-slate-600 mb-1 font-medium">Target Status</label>
                  <select
                    value={nextStatus}
                    onChange={e => setNextStatus(e.target.value as ClaimStatus)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white font-medium text-slate-900"
                  >
                    {nextOpts.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1 font-medium">Notes</label>
                  <textarea
                    rows={2}
                    value={statusNote}
                    onChange={e => setStatusNote(e.target.value)}
                    placeholder="Reason..."
                    className="w-full p-2 rounded-lg border border-slate-200"
                  />
                </div>
                <button
                  onClick={handleStatus}
                  disabled={submitting}
                  className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
                >
                  Update Status
                </button>
              </div>
            )}
          </div>

          {/* Disbursements */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Disbursement Records</div>
            {(!claim.payouts || claim.payouts.length === 0) ? (
              <p className="text-xs text-slate-400">No payout records found.</p>
            ) : (
              <div className="space-y-2 text-xs">
                {claim.payouts.map(p => (
                  <div key={p.id} className="p-3 rounded-lg border border-slate-100 bg-slate-50/50">
                    <div className="flex justify-between font-bold text-slate-900">
                      <span>PKR {p.amount.toLocaleString()}</span>
                      <span className="text-[10px] text-slate-600 font-semibold">{p.status}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">{p.method} · {p.initiated_at.split("T")[0]}</p>
                    {p.reference_number && <p className="text-[10px] font-mono text-slate-500">Ref: {p.reference_number}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Adjudication Modal */}
      {modal === "adj" && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">Adjudication Decision</h3>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
            </div>
            <form onSubmit={handleAdj} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Decision</label>
                <select
                  value={adjDecision}
                  onChange={e => setAdjDecision(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white"
                >
                  <option value="APPROVED">Approve Claim</option>
                  <option value="PARTIAL_APPROVAL">Partial Approval</option>
                  <option value="DECLINED">Decline Claim</option>
                  <option value="REFERRED_TO_MANAGER">Escalate to Manager</option>
                </select>
              </div>

              {["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision) && (
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block font-semibold text-slate-700">Approved Amount (PKR)</label>
                    <span className="text-[10px] text-slate-500 font-medium">
                      Max Claimed: <strong className="text-slate-800 font-mono">PKR {claim?.submitted_amount?.toLocaleString()}</strong>
                    </span>
                  </div>
                  <input
                    type="number"
                    required
                    min={1}
                    max={claim?.submitted_amount}
                    value={adjAmount}
                    onChange={e => setAdjAmount(parseFloat(e.target.value) || 0)}
                    className={`w-full px-3 py-2 rounded-lg border transition-colors focus:outline-none focus:ring-2 ${claim && adjAmount > claim.submitted_amount
                      ? "border-rose-300 bg-rose-50 text-rose-900 focus:ring-rose-400 font-semibold"
                      : "border-slate-200 focus:ring-blue-400 font-medium"
                      }`}
                  />
                  {claim && adjAmount > claim.submitted_amount && (
                    <p className="text-[10px] text-rose-600 font-medium mt-1 flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      Amount cannot exceed claimed limit of PKR {claim.submitted_amount.toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Rationale</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Notes..."
                  value={adjNotes}
                  onChange={e => setAdjNotes(e.target.value)}
                  className="w-full p-2 rounded-lg border border-slate-200"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">Cancel</button>
                <button
                  type="submit"
                  disabled={submitting || (!!claim && ["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision) && adjAmount > claim.submitted_amount)}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Payout Modal */}
      {modal === "payout" && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">Issue Payout</h3>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
            </div>
            <form onSubmit={handlePayout} className="p-5 space-y-3 text-xs">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block font-semibold text-slate-700">Amount (PKR)</label>
                  <span className="text-[10px] text-slate-500 font-medium">
                    Max Limit: <strong className="text-slate-800 font-mono">PKR {((claim?.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim?.submitted_amount)?.toLocaleString()}</strong>
                  </span>
                </div>
                <input
                  type="number"
                  required
                  min={1}
                  max={(claim?.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim?.submitted_amount}
                  value={payAmount}
                  onChange={e => setPayAmount(parseFloat(e.target.value) || 0)}
                  className={`w-full px-3 py-2 rounded-lg border transition-colors focus:outline-none focus:ring-2 ${claim && payAmount > ((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount)
                    ? "border-rose-300 bg-rose-50 text-rose-900 focus:ring-rose-400 font-semibold"
                    : "border-slate-200 focus:ring-blue-400 font-medium"
                    }`}
                />
                {claim && payAmount > ((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount) && (
                  <p className="text-[10px] text-rose-600 font-medium mt-1 flex items-center gap-1">
                    <svg className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Amount cannot exceed max limit of PKR {((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount).toLocaleString()}
                  </p>
                )}
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Method</label>
                <select
                  value={payMethod}
                  onChange={e => setPayMethod(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white"
                >
                  <option value="Bank Transfer">Bank Transfer (IBFT/RTGS)</option>
                  <option value="Crossed Cheque">Crossed Cheque</option>
                  <option value="Direct Credit">Direct Credit</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Bank Ref #</label>
                <input
                  type="text"
                  placeholder="e.g. IBFT-992104"
                  value={payRef}
                  onChange={e => setPayRef(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">Cancel</button>
                <button
                  type="submit"
                  disabled={submitting || (!!claim && payAmount > ((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount))}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Issue Payout
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload Doc Modal */}
      {modal === "doc" && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">Upload Document</h3>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
            </div>
            <form onSubmit={handleDoc} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Document Type</label>
                <select
                  value={docType}
                  onChange={e => setDocType(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white"
                >
                  <option value="Hospital Bill">Hospital Bill / Invoice</option>
                  <option value="Discharge Summary">Discharge Summary</option>
                  <option value="Death Certificate">Death Certificate (NADRA)</option>
                  <option value="CNIC">CNIC Copy</option>
                  <option value="Lab Test Report">Lab / Radiology Report</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">File</label>
                <input
                  type="file"
                  required
                  accept=".pdf,.png,.jpg,.jpeg,.heic,.tiff"
                  onChange={e => setDocFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">Cancel</button>
                <button type="submit" disabled={submitting || !docFile} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50">
                  {submitting ? "Uploading..." : "Upload"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Re-Underwriting Referral Modal */}
      {modal === "reunderwrite" && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-amber-50">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-amber-200 text-amber-900 flex items-center justify-center font-bold text-xs">⚠️</div>
                <h3 className="text-sm font-bold text-slate-900">Refer Claim to Underwriting</h3>
              </div>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
            </div>
            <form onSubmit={handleReferToUnderwriting} className="p-5 space-y-3.5 text-xs">
              {hasDocs && claim.is_contestable && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-900 font-mono text-[11px] space-y-1">
                  <div className="flex items-center justify-between font-bold text-[10px] uppercase text-rose-800 tracking-wider font-sans">
                    <span>OCR Extracted Evidence Attached</span>
                    <span>Confidence 98%</span>
                  </div>
                  <p className="text-[10px] text-rose-800 leading-tight font-sans">
                    OCR parsed medical onset (2022-04-12) precedes policy inception. Pre-populating non-disclosure referral.
                  </p>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="font-semibold text-slate-700">Referral Trigger Reason(s)</label>
                  <span className="text-[10px] text-amber-700 font-medium font-mono">{uwReasons.length} selected</span>
                </div>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {[
                    "Policy Issued < 2 Years Ago (Contestability Window)",
                    "Undisclosed Pre-Existing Medical History (OCR Flag)",
                    "Claim Amount Exceeds Adjuster Limit (> PKR 500k)",
                    "Claim Amount Exceeds Net Retention (> PKR 5M)",
                    "Post-Claim Coverage Restatement & Rider Exclusion",
                    "Disability Care & Fitness-for-Duty Assessment",
                  ].map((optionText) => {
                    const isChecked = uwReasons.includes(optionText);
                    return (
                      <label
                        key={optionText}
                        className={`flex items-start gap-2.5 p-2 rounded-lg border text-xs cursor-pointer transition-all ${isChecked
                          ? "bg-amber-50/90 border-amber-300 text-amber-950 font-medium shadow-2xs"
                          : "bg-slate-50/50 border-slate-200/80 text-slate-600 hover:bg-slate-50"
                          }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setUwReasons([...uwReasons, optionText]);
                            } else {
                              setUwReasons(uwReasons.filter((r) => r !== optionText));
                            }
                          }}
                          className="mt-0.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                        />
                        <span className="leading-snug">{optionText}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Underwriter Audit Notes</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Detail specific findings, medical records, or policy limit considerations for the technical underwriter..."
                  value={uwNotes}
                  onChange={e => setUwNotes(e.target.value)}
                  className="w-full p-2 rounded-lg border border-slate-200 font-medium"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">Cancel</button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold shadow-2xs disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Submit Referral"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Resolve Underwriting Review Modal */}
      {modal === "resolve_uw" && (() => {
        const options = (() => {
          const r = (claim.underwriting_referral_reason || "").toLowerCase();
          if (r.includes("contestable") || r.includes("non-disclosure") || r.includes("pre-existing") || r.includes("undisclosed") || r.includes("medical")) {
            return [
              { value: "APPROVE_CONTINUE", label: "Clear Audit & Resume Claim Processing (Disclosures Valid)", desc: "Medical disclosures verified as accurate. Audit closed and claim returned to normal adjudication." },
              { value: "DECLINE_NON_DISCLOSURE", label: "Decline Claim & Cancel Policy (Undisclosed History Confirmed)", desc: "Undisclosed pre-existing condition verified. Claim denied with PKR 0 payout and policy voided." },
              { value: "APPROVE_WITH_EXCLUSION", label: "Approve Claim with Pre-Existing Condition Exclusion", desc: "Approve current claim but attach policy endorsement excluding future claims for this condition." },
              { value: "APPROVE_WITH_LOADING", label: "Approve Claim with Premium Rate Loading", desc: "Approve claim and apply retroactive premium rate increase to cover risk history." },
            ];
          }
          if (r.includes("authority") || r.includes("500k") || r.includes("threshold") || r.includes("adjuster")) {
            return [
              { value: "APPROVE_CONTINUE", label: "Approve Full Claim Amount (Senior Sign-Off Granted)", desc: "Senior Underwriter financial sign-off granted for full requested claim amount." },
              { value: "APPROVE_WITH_LOADING", label: "Approve Partial Amount (Cap at Adjuster Authority)", desc: "Approve claim up to maximum benefit limit; remaining balance excluded." },
              { value: "DECLINE_NON_DISCLOSURE", label: "Decline Claim Exceedance (Exceeds Policy Maximum)", desc: "Deny claim amount exceeding contractual policy coverage limit." },
            ];
          }
          if (r.includes("reinsurance") || r.includes("5m") || r.includes("treaty") || r.includes("retention")) {
            return [
              { value: "APPROVE_CONTINUE", label: "Approve Settlement (Reinsurance Recovery Confirmed)", desc: "Facultative reinsurer approved recovery. Primary & treaty payout cleared." },
              { value: "APPROVE_WITH_EXCLUSION", label: "Approve Settlement with Reinsurer Co-Insurance Terms", desc: "Approved subject to facultative reinsurer co-payment conditions." },
              { value: "DECLINE_NON_DISCLOSURE", label: "Decline Claim (Reinsurer Declined Coverage)", desc: "Facultative reinsurer rejected claim under treaty exclusions." },
            ];
          }
          if (r.includes("restatement") || r.includes("rider") || r.includes("post-claim")) {
            return [
              { value: "APPROVE_WITH_EXCLUSION", label: "Approve Claim & Add Specific Condition Exclusion Rider", desc: "Approve current claim and attach rider excluding recurring conditions." },
              { value: "APPROVE_WITH_LOADING", label: "Approve Claim & Increase Renewal Premium Rate", desc: "Adjust renewal premium rate structure post-loss." },
              { value: "APPROVE_CONTINUE", label: "Approve Claim & Maintain Standard Policy Terms", desc: "No policy restatement required; retain standard terms." },
            ];
          }
          if (r.includes("disability") || r.includes("fitness") || r.includes("care")) {
            return [
              { value: "APPROVE_CONTINUE", label: "Approve Disability Benefits (Ongoing Total Disability)", desc: "Medical evidence supports ongoing total disability status." },
              { value: "DECLINE_NON_DISCLOSURE", label: "End Disability Benefits (Fit to Return to Work)", desc: "Insured evaluated fit to return to work; cease recurring payouts." },
              { value: "APPROVE_WITH_LOADING", label: "Approve Partial Disability Income Level", desc: "Transition from total to partial disability benefit tier." },
            ];
          }
          return [
            { value: "APPROVE_CONTINUE", label: "Clear Audit & Resume Normal Processing", desc: "Underwriting audit cleared; return claim to active adjuster review." },
            { value: "APPROVE_WITH_EXCLUSION", label: "Approve Claim with Coverage Restriction Rider", desc: "Attach specific coverage restriction endorsement." },
            { value: "APPROVE_WITH_LOADING", label: "Approve Claim with Adjusted Risk Premium", desc: "Calibrate risk profile and adjust premium structure." },
            { value: "DECLINE_NON_DISCLOSURE", label: "Decline Claim & Void Policy", desc: "Deny claim due to policy breach or non-disclosure." },
          ];
        })();

        const currentOpt = options.find(o => o.value === uwDecision) || options[0];

        return (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-lg overflow-hidden transition-all animate-in fade-in zoom-in-95 duration-150">
              <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/80 text-slate-900">
                <div className="flex items-center gap-2.5">
                  <div className="w-6 h-6 rounded-md bg-emerald-100 border border-emerald-200 text-emerald-700 flex items-center justify-center font-bold text-xs">
                    ✓
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 leading-none">
                      {showConfirmStep ? "Confirm Underwriting Decision" : "Resolve Underwriting Review"}
                    </h3>
                    <p className="text-[10px] text-slate-500 font-medium mt-0.5">
                      {showConfirmStep ? "Step 2 of 2: Final Confirmation & Governance Log" : "Step 1 of 2: Select Action & Enter Rationale"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setModal(null)}
                  className="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 flex items-center justify-center text-lg transition-colors"
                >
                  &times;
                </button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!showConfirmStep) {
                    if (!uwDecisionNotes.trim()) {
                      showToast("err", "Please enter decision notes before confirming.");
                      return;
                    }
                    setShowConfirmStep(true);
                  } else {
                    handleResolveUnderwriting(e);
                  }
                }}
                className="p-5 space-y-4 text-xs"
              >
                {!showConfirmStep ? (
                  <>
                    {/* Active Referral Context Badge with Pill Tags */}
                    <div className="p-3 bg-amber-50/80 border border-amber-200/90 rounded-xl space-y-2 text-amber-950">
                      <div className="flex items-center justify-between text-[10px] font-bold text-amber-900 uppercase tracking-wider">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                          Active Referral Trigger(s)
                        </span>
                        <span className="bg-amber-200/90 text-amber-900 px-2 py-0.5 rounded font-mono text-[9px] font-bold">
                          AUDIT PENDING
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {(claim.underwriting_referral_reason || "Technical Underwriting Audit").split("; ").map((reason, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-amber-200/80 text-amber-950 font-semibold text-[11px] shadow-2xs"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                            {reason}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-800 mb-1.5">Underwriting Finding & Action</label>
                      <select
                        value={uwDecision}
                        onChange={e => setUwDecision(e.target.value as any)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 shadow-2xs transition-all"
                      >
                        {options.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      {currentOpt && (
                        <div className="text-[11px] text-slate-600 font-medium mt-2 bg-slate-50 border border-slate-200/80 p-2.5 rounded-lg flex items-start gap-2 leading-relaxed">
                          <span className="text-blue-500 font-bold shrink-0 text-xs">ℹ️</span>
                          <span>{currentOpt.desc}</span>
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-800 mb-1.5">Decision Notes & Policy Endorsements</label>
                      <textarea
                        rows={3}
                        required
                        placeholder="Record formal technical underwriter rationale, medical guidelines applied, or policy endorsement details..."
                        value={uwDecisionNotes}
                        onChange={e => setUwDecisionNotes(e.target.value)}
                        className="w-full p-2.5 rounded-lg border border-slate-200 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition-all text-xs"
                      />
                    </div>

                    <div className="pt-3 flex justify-end gap-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setModal(null)}
                        className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 font-semibold hover:bg-slate-50 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs active:scale-[0.98] transition-all flex items-center gap-1.5"
                      >
                        <span>Review & Confirm Decision</span>
                        <span>→</span>
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Concise Confirmation Summary Card */}
                    <div className="p-3.5 bg-amber-50/80 border border-amber-200/90 rounded-xl space-y-2.5">
                      <div className="flex items-center justify-between text-[11px] font-bold text-amber-950 uppercase tracking-wider">
                        <span>Confirm Underwriting Action</span>
                        <span className="text-amber-800 text-[10px] font-normal font-mono">Final Review</span>
                      </div>

                      <div className="p-3 bg-white rounded-lg border border-amber-200/80 space-y-2 text-xs">
                        <div className="flex justify-between items-start gap-3">
                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">Selected Action:</span>
                          <span className="font-bold text-slate-900 text-right">{currentOpt?.label}</span>
                        </div>

                        <div className="flex justify-between items-start gap-3 pt-2 border-t border-slate-100">
                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">Policy Impact:</span>
                          <span className="font-medium text-slate-700 text-right leading-snug">{currentOpt?.desc}</span>
                        </div>

                        <div className="flex justify-between items-start gap-3 pt-2 border-t border-slate-100">
                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">Rationale:</span>
                          <span className="font-mono text-slate-900 text-right italic font-semibold">"{uwDecisionNotes}"</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-3 flex justify-between items-center border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setShowConfirmStep(false)}
                        className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 font-semibold hover:bg-slate-50 text-xs transition-colors flex items-center gap-1"
                      >
                        <span>← Back</span>
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-xs active:scale-[0.98] disabled:opacity-50 transition-all"
                      >
                        {submitting ? "Submitting..." : "Confirm Decision"}
                      </button>
                    </div>
                  </>
                )}
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
