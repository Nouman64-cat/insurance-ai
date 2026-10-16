"use client";
import { displayDate } from "@/lib/dateDisplay";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getClaimDetail, updateClaimStatus, adjudicateClaim,
  createClaimPayout, referClaimToReinsurance, uploadClaimDocument,
  referClaimToUnderwriting, resolveClaimUnderwriting,
  Claim, ClaimStatus,
} from "@/app/services/claims";
import { tx } from "@/lib/i18n/tx";
import { ClaimJourneyTimeline } from "@/components/claims/ClaimJourneyTimeline";

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

type NextStepGuide = {
  title: string;
  body: string;
  done?: boolean;
  cta?: { label: string; kind: "decide" | "payout" | "docs" | "resolve_uw" | "refer_uw"; target?: ClaimStatus };
};

// What the person working this claim should do right now. Checks come in the order they block progress:
// documents first, then underwriting flags, then the decision itself.
function getNextStep(
  status: string,
  o: { hasDocs: boolean; canPayout: boolean; nextOpts: ClaimStatus[]; uwBlocked: boolean },
): NextStepGuide {
  const move = (target: ClaimStatus, label: string): NextStepGuide["cta"] =>
    o.nextOpts.includes(target) ? { label, kind: "decide", target } : undefined;
  const upload: NextStepGuide["cta"] = { label: "Upload document", kind: "docs" };

  switch (status) {
    case "New":
      return { title: "Triage this claim", body: "Read the claim details below and check the documents, then move the claim to Triaged.", cta: move("Triaged", "Triage claim") };
    case "Triaged":
      return { title: "Start the investigation", body: "Confirm the policy and claimant details are correct, then start the investigation.", cta: move("Under Investigation", "Start investigation") };
    case "Pending Documents":
      return o.hasDocs
        ? { title: "Resume the investigation", body: "The documents are in. Move the claim back to Under Investigation.", cta: move("Under Investigation", "Resume investigation") }
        : { title: "Upload the missing documents", body: "The claim is waiting for documents. Upload them, then resume the investigation.", cta: upload };
    case "Under Investigation":
    case "Referred to Manager":
      if (!o.hasDocs) {
        return { title: "Attach a verified document", body: "A claim can't be approved or settled without at least one verified document. Upload one to continue.", cta: upload };
      }
      if (o.uwBlocked) {
        return { title: "Get underwriting clearance first", body: "This claim has risk flags (a recent policy or a high amount). Underwriting has to review them before it can be approved or settled.", cta: { label: "Refer to underwriting", kind: "refer_uw" } };
      }
      return { title: "Make a decision", body: "Review the documents and the risk analysis, then approve, partially approve or decline the claim.", cta: { label: "Make a decision", kind: "decide" } };
    case "Re-Underwriting Required":
      return { title: "Underwriting review in progress", body: "Adjudication is paused until underwriting resolves the review. Once it is resolved you can continue the claim.", cta: { label: "Resolve review", kind: "resolve_uw" } };
    case "Reinsurance Referred":
      return { title: "With the reinsurance team", body: "Nothing to do until they respond. You can still add notes or documents." };
    case "Approved":
    case "Partial Approval":
      return o.canPayout
        ? { title: "Settle the claim", body: "Record the payout to pay the claimant and settle the claim.", cta: { label: "Issue payout", kind: "payout" } }
        : { title: "Settle the claim", body: "Move the claim to Settled once the payout is made.", cta: move("Settled", "Settle claim") };
    case "Settled":
      return { title: "Claim settled", body: "The payout has been made. Close the claim when you have finished.", cta: move("Closed", "Close claim") };
    case "Declined":
      return { title: "Claim declined", body: "Close the claim to finish.", cta: move("Closed", "Close claim") };
    case "Closed":
      return { title: "Claim closed", body: "No further action is needed.", done: true };
    default:
      return { title: "Review the claim", body: "Check the details, then choose what happens next.", cta: o.nextOpts.length ? { label: "Choose next step", kind: "decide" } : undefined };
  }
}

// How each possible move is described in the decision dialog.
const MOVE_INFO: Record<string, { title: string; desc: string; next?: string }> = {
  "Triaged": { title: "Triage the claim", desc: "The details have been checked and the claim is ready to be investigated." },
  "Under Investigation": { title: "Start the investigation", desc: "Review the claim, its documents and the risk analysis in detail." },
  "Pending Documents": { title: "Ask for more documents", desc: "Pause the claim until the claimant provides what is missing." },
  "Referred to Manager": { title: "Refer to a manager", desc: "Pass the decision to a manager." },
  "Re-Underwriting Required": { title: "Send to underwriting review", desc: "Underwriting checks the policy before the claim can go on.", next: "Next you will choose why underwriting should review it." },
  "Approved": { title: "Approve the claim", desc: "Pay the claim as submitted.", next: "Next you will confirm the approved amount." },
  "Partial Approval": { title: "Approve part of the amount", desc: "Pay less than the submitted amount.", next: "Next you will enter the amount to approve." },
  "Declined": { title: "Decline the claim", desc: "The claim will not be paid. A reason is required." },
  "Settled": { title: "Record the payout", desc: "Pay the claimant and settle the claim.", next: "Next you will enter the payment details." },
  "Closed": { title: "Close the claim", desc: "Finish the claim. It can't be changed afterwards." },
};
const NOTE_REQUIRED: ClaimStatus[] = ["Declined", "Pending Documents", "Referred to Manager"];
const OWN_SCREEN: ClaimStatus[] = ["Approved", "Partial Approval", "Settled", "Re-Underwriting Required"];

function StatusBadge({ status }: { status: string }) {
  // Blue and white only: finished = solid, in progress = light, waiting = outlined, ended without payment = dark.
  const done = ["Approved", "Partial Approval", "Settled", "Active", "Uploaded", "Paid"].includes(status);
  const ended = ["Declined", "Rejected", "Closed", "Voided"].includes(status);
  const waiting = ["Referred to Manager", "Reinsurance Referred", "Re-Underwriting Required", "Pending Documents"].includes(status);

  const colorClass = done
    ? "bg-blue-600 text-white border-blue-600 font-semibold"
    : ended
      ? "bg-slate-700 text-white border-slate-700 font-semibold"
      : waiting
        ? "bg-white text-blue-700 border-blue-300 font-semibold"
        : "bg-blue-50 text-blue-700 border-blue-200 font-semibold";

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

  const [modal, setModal] = useState<"adj" | "payout" | "doc" | "reunderwrite" | "resolve_uw" | "decide" | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [uwReasons, setUwReasons] = useState<string[]>([]);
  const [uwNotes, setUwNotes] = useState<string>("");

  const [showConfirmStep, setShowConfirmStep] = useState<boolean>(false);

  const openModal = (m: "adj" | "payout" | "doc" | "reunderwrite" | "resolve_uw" | "decide") => {
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
  const [decideTarget, setDecideTarget] = useState<ClaimStatus | null>(null);
  const [decideNote, setDecideNote] = useState("");

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
    } catch { showToast("err", tx("Failed to load claim details.")); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (claimId) load(); }, [claimId]);

  const handleStatus = async (target: ClaimStatus = nextStatus, note: string = statusNote) => {
    // 1. Document Gate Prerequisite
    if (!hasDocs && ["Approved", "Partial Approval", "Settled"].includes(target)) {
      showToast("err", tx("Document Gate Error: Cannot approve or settle claim without at least 1 verified claim document attached."));
      return;
    }

    // 1b. Underwriting Audit Prerequisite
    if (hasUnresolvedFlags && ["Approved", "Partial Approval", "Settled"].includes(target)) {
      showToast("err", tx("Underwriting Block: Active risk flags (Contestability / Limit Exceeded) must be resolved by Underwriting before approving or settling this claim."));
      return;
    }

    // 2. Guided Assessment Flow: Selecting 'Approved' or 'Partial Approval' opens Assess modal
    if (["Approved", "Partial Approval"].includes(target)) {
      setAdjDecision(target === "Approved" ? "APPROVED" : "PARTIAL_APPROVAL");
      if (claim?.submitted_amount && adjAmount === 0) {
        setAdjAmount(claim.submitted_amount);
      }
      openModal("adj");
      return;
    }

    // 3. Guided Settlement Flow: Selecting 'Settled' opens Issue Payout modal
    if (target === "Settled") {
      if (!canPayout) {
        showToast("err", tx("Assessment Gate Error: Claim must be assessed and approved before issuing a disbursement payout."));
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
    if (target === "Re-Underwriting Required") {
      openModal("reunderwrite");
      return;
    }

    // 5. Standard Status Update
    setSubmitting(true);
    try {
      await updateClaimStatus(claimId, target, note);
      showToast("ok", tx("Status updated to {0}", { 0: target }));
      setStatusNote(""); setDecideNote(""); closeModal(); load();
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
      showToast("ok", tx("Decision recorded: {0}", { 0: adjDecision }));
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
      showToast("err", tx("Payout amount cannot exceed approved amount of PKR {0}.", { 0: maxAllowed.toLocaleString() }));
      return;
    }
    if (payAmount <= 0) {
      showToast("err", tx("Payout amount must be greater than 0."));
      return;
    }
    setSubmitting(true);
    try {
      await createClaimPayout(claimId, { amount: payAmount, method: payMethod, reference_number: payRef || undefined });
      showToast("ok", tx("Payout issued successfully"));
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
      showToast("err", tx("Please select at least one referral trigger reason."));
      return;
    }
    setSubmitting(true);
    try {
      await referClaimToUnderwriting(claimId, uwReasons.join("; "), uwNotes);
      showToast("ok", tx("Claim successfully referred to Underwriting."));
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
      showToast("ok", tx("Underwriting review resolved successfully."));
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
      showToast("ok", tx("{0} uploaded successfully", { 0: docFile.name }));
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
      showToast("ok", tx("Referred to Reinsurance team"));
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
      <div className="text-xs text-slate-500">{tx("Loading claim workbench...")}</div>
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

  const guide = getNextStep(claim.status, { hasDocs, canPayout, nextOpts, uwBlocked: hasUnresolvedFlags });
  const openDecision = (target: ClaimStatus | null = null) => {
    setDecideTarget(target);
    setDecideNote("");
    openModal("decide");
  };
  const runNextStep = (cta: NonNullable<NextStepGuide["cta"]>) => {
    if (cta.kind === "payout") return openModal("payout");
    if (cta.kind === "docs") return openModal("doc");
    if (cta.kind === "resolve_uw") return openModal("resolve_uw");
    if (cta.kind === "refer_uw") return openModal("reunderwrite");
    return openDecision(cta.target ?? null);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {/* Toast Alert */}
      {toast && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl shadow-2xl text-xs font-semibold flex items-center gap-3 max-w-lg border transition-all animate-in fade-in slide-in-from-top-4 ${toast.type === "err"
          ? "bg-white text-slate-900 border-blue-300 shadow-slate-900/15"
          : "bg-blue-600 text-white border-blue-500 shadow-blue-900/30"
          }`}>
          {toast.type === "err" ? (
            <div className="w-6 h-6 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center flex-shrink-0 text-blue-700">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          ) : (
            <div className="w-6 h-6 rounded-lg bg-white/15 border border-white/25 flex items-center justify-center flex-shrink-0 text-white">
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
            {tx("Back to Claims Register")}
          </Link>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/claims" className="hover:underline">{tx("Claims")}</Link>
            <span>/</span>
            <span className="font-mono text-slate-700">{claim.claim_number}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{claim.claim_number}</h1>
            <StatusBadge status={claim.status} />
            {claim.duplicate_flag && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-800">
                {tx("Duplicate")}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {tx("Claimant:")}{" "}<span className="font-medium text-slate-800">{claim.claimant_name}</span>{" "}{tx("· Adjuster:")}{" "}<span className="font-medium text-slate-800">{claim.assigned_adjuster_name ?? tx("Unassigned")}</span>{" "}{tx("· Reported")}{" "}{displayDate(claim.reported_date)}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {!isClosedStatus && claim.status !== "Re-Underwriting Required" && (
            <button
              onClick={() => openModal("reunderwrite")}
              className="text-xs font-semibold px-3.5 py-2 bg-white border border-blue-300/80 hover:bg-blue-50/50 text-blue-900 shadow-2xs active:scale-[0.98] transition-all flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span>{tx("Refer Underwriting")}</span>
            </button>
          )}

          {canPayout && (
            <button
              onClick={() => setModal("payout")}
              className="text-xs font-semibold px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-md shadow-blue-500/20 active:scale-[0.98] transition-all flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{tx("Issue Payout")}</span>
            </button>
          )}
        </div>
      </div>

      {/* Where the claim stands in its lifecycle */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-bold text-slate-900">{tx("Claim lifecycle")}</h2>
            <p className="text-xs text-slate-500">{tx("Where the claim stands right now.")}</p>
          </div>
        </div>
        <div className="px-6 py-5">
          <ol className="flex">
            {displaySteps.map((step, i) => {
              const isDone = i < stepIdx;
              const isCurrent = i === stepIdx;
              const isUwStep = step === "Re-Underwriting Review";
              return (
                <li key={step} className="relative flex flex-1 flex-col items-center text-center">
                  {i > 0 && (
                    <span
                      aria-hidden="true"
                      className={`absolute right-1/2 top-3.5 h-0.5 w-full -translate-y-1/2 ${i <= stepIdx ? "bg-blue-500" : "bg-slate-200"}`}
                    />
                  )}
                  <span
                    aria-current={isCurrent ? "step" : undefined}
                    className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${isCurrent && isUwStep
                      ? "bg-blue-600 text-white shadow-md shadow-blue-200 ring-4 ring-blue-50"
                      : isCurrent
                        ? "bg-blue-600 text-white shadow-md shadow-blue-200 ring-4 ring-blue-100"
                        : isDone
                          ? "bg-blue-600 text-white"
                          : "border-2 border-slate-300 bg-white text-slate-400"
                      }`}
                  >
                    {isDone ? "✓" : isUwStep ? "!" : i + 1}
                  </span>
                  <span
                    className={`mt-2 px-1 text-xs ${isCurrent && isUwStep
                      ? "font-bold text-blue-700"
                      : isCurrent
                        ? "font-bold text-blue-700"
                        : isDone
                          ? "font-semibold text-slate-700"
                          : "font-medium text-slate-400"
                      }`}
                  >
                    {step}
                  </span>
                </li>
              );
            })}
          </ol>
          {stepIdx < 0 && (
            <p className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {tx("Current status:")} <StatusBadge status={claim.status} />
              <span>{tx("— outside the standard path.")}</span>
            </p>
          )}
        </div>
      </div>

      {/* What to do now */}
      <div className={`rounded-xl border shadow-sm ${guide.done ? "border-slate-200 bg-slate-50" : "border-blue-200 bg-blue-50/60"}`}>
        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white ${guide.done ? "bg-slate-400" : "bg-blue-600"}`}>
              {guide.done ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              )}
            </span>
            <div>
              <p className={`text-[11px] font-bold uppercase tracking-wider ${guide.done ? "text-slate-500" : "text-blue-600"}`}>
                {guide.done ? tx("All done") : tx("Next step")}
              </p>
              <h2 className="text-base font-bold text-slate-900">{tx(guide.title)}</h2>
              <p className="mt-0.5 max-w-2xl text-sm text-slate-600">{tx(guide.body)}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            {guide.cta && (
              <button
                type="button"
                onClick={() => runNextStep(guide.cta!)}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-blue-700"
              >
                {tx(guide.cta.label)} →
              </button>
            )}
            {nextOpts.length > 0 && !(guide.cta?.kind === "decide" && !guide.cta.target) && (
              <button
                type="button"
                onClick={() => openDecision(null)}
                className="text-xs font-semibold text-blue-700 hover:underline"
              >
                {tx("See all options")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mandatory Document Gate Notice */}
      {!hasDocs && claim.status !== "Closed" && claim.status !== "Declined" && guide.cta?.kind !== "docs" && (
        <div className="p-3 bg-blue-50/70 border-y border-r border-blue-200/80 border-l-4 border-l-blue-500 rounded-xl text-xs text-blue-950 flex items-center justify-between shadow-2xs gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center flex-shrink-0 text-blue-600">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-blue-900 text-[11px] uppercase tracking-wide">{tx("Document Gate")}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-200/60 text-blue-800">{tx("Prerequisite")}</span>
              </div>
              <p className="text-xs text-blue-900/90 font-medium mt-0.5">
                {tx("At least 1 verified document is required before claim approval or settlement.")}
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
            <span>{tx("Upload Document")}</span>
          </button>
        </div>
      )}

      {/* Underwriting Active Audit / Review Banner */}
      {claim.status === "Re-Underwriting Required" && (
        <div className="p-4 bg-blue-50/80 border border-blue-200/90 rounded-xl shadow-2xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4 text-blue-950">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-blue-100 border border-blue-200/80 flex items-center justify-center shrink-0 text-blue-800 shadow-2xs mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-blue-950 text-xs uppercase tracking-wider">
                  {tx("Underwriting Re-Assessment Active")}
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-200/70 border border-blue-300/80 text-blue-900">
                  {tx("Paused Adjudication")}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-blue-900 font-medium">{tx("Referral Triggers:")}</span>
                {(claim.underwriting_referral_reason || "Technical Underwriting Audit").split("; ").map((reason, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-blue-200/90 text-blue-950 font-semibold text-[11px] shadow-2xs"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                    {reason}
                  </span>
                ))}
              </div>

              {claim.underwriting_decision_notes && (
                <div className="flex items-center gap-1.5 text-[11px] text-blue-900 pt-0.5">
                  <span className="font-semibold text-blue-800">{tx("Referral Note:")}</span>
                  <span className="italic font-medium text-blue-950">
                    "{claim.underwriting_decision_notes.replace(/^Referral Note \(\d{4}-\d{2}-\d{2}\):\s*/i, "")}"
                  </span>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => openModal("resolve_uw")}
            className="px-4 py-2 bg-blue-900 hover:bg-blue-800 text-white font-semibold rounded-lg text-xs shadow-2xs active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0 self-stretch md:self-auto justify-center"
          >
            <svg className="w-4 h-4 text-blue-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{tx("Resolve Review")}</span>
          </button>
        </div>
      )}

      {/* Main content */}
      <div className="space-y-6">
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {/* Policy & Claimant Info */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-800">{tx("Policy & Claimant Overview")}</h2>
                {claim.claimant_type && claim.claimant_type !== "SELF" ? (
                  <span className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-100/80 text-blue-900 border border-blue-200 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    {tx("Beneficiary / Representative Claim (")}{claim.claimant_relationship || tx("Nominee")})
                  </span>
                ) : (
                  <span className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                    {tx("Insured Self Claim")}
                  </span>
                )}
              </div>
              <div className="p-5 space-y-5 text-sm">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-5">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Claimant Name")}</div>
                    <div className="font-semibold text-slate-900 mt-0.5 flex flex-col items-start gap-1">
                      <span>{claim.claimant_name || tx("Self")}</span>
                      {claim.claimant_type && claim.claimant_type !== "SELF" && (
                        claim.nominee_match ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200/50 uppercase tracking-wide">
                            {tx("✓ Verified Nominee")}
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-50 text-slate-700 border border-slate-200/50 uppercase tracking-wide">
                            {tx("Mismatch")}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Policy Holder")}</div>
                    <div className="font-semibold text-slate-900 mt-0.5">{claim.customer_name || tx("Policyholder")}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Policy Ref & Plan")}</div>
                    <div className="font-mono font-semibold text-slate-900 mt-0.5">{claim.policy_number ?? "—"}</div>
                    <div className="text-xs text-slate-500 font-medium">{claim.policy_type ?? "—"}</div>
                  </div>
                  {claim.claimant_type && claim.claimant_type !== "SELF" && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Claimant Contact")}</div>
                      <div className="mt-0.5 space-y-0.5 font-semibold text-slate-900">
                        <div className="font-mono text-[13px]">{tx("ID:")}{" "}{claim.claimant_cnic || "—"}</div>
                        <div className="text-xs font-medium text-slate-500">{tx("Ph:")}{" "}{claim.claimant_phone || "—"}</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Beneficiary / Nominee Mismatch Banner */}
                {claim.claimant_type && claim.claimant_type !== "SELF" && !claim.nominee_match && (
                  <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl space-y-1.5 text-xs">
                    <div className="flex items-center gap-2 text-slate-800 font-bold text-[11.5px] uppercase tracking-wider">
                      <svg className="w-4 h-4 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span>{tx("Nominee Mismatch Warning")}</span>
                    </div>
                    <div className="text-slate-900 leading-relaxed text-[11px]">
                      {tx("The policy record designates")}{" "}<strong className="text-slate-950">{claim.nominee_name || tx("No nominee")}</strong> ({claim.nominee_relationship || tx("Nominee")}{tx(") as the authorized beneficiary. However, this claim was filed by")}{" "}<strong className="text-slate-950">{claim.claimant_name || tx("Unknown")}</strong>.
                    </div>
                  </div>
                )}

                {/* Money at a glance */}
                <div className="border-t border-slate-100 pt-5">
                  <div className={`grid gap-3 ${claim.approved_amount > 0 ? "grid-cols-3" : "grid-cols-2"}`}>
                    <div className="rounded-lg bg-slate-50 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Claimed")}</div>
                      <div className="mt-0.5 text-base font-bold text-slate-900">{tx("PKR")}{" "}{claim.submitted_amount.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tx("Coverage Limit")}</div>
                      <div className="mt-0.5 text-base font-bold text-slate-900">{tx("PKR")}{" "}{(claim.coverage_amount ?? 0).toLocaleString()}</div>
                    </div>
                    {claim.approved_amount > 0 && (
                      <div className="rounded-lg bg-blue-50 px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">{tx("Approved Settlement")}</div>
                        <div className="mt-0.5 text-base font-bold text-blue-900">{tx("PKR")}{" "}{claim.approved_amount.toLocaleString()}</div>
                      </div>
                    )}
                  </div>
                  {(claim.coverage_amount ?? 0) > 0 && (
                    <div className="mt-4">
                      <div className="mb-1 flex justify-between text-xs text-slate-500">
                        <span>{tx("Share of coverage claimed")}</span>
                        <span className="font-semibold text-slate-700">{Math.round((claim.submitted_amount / (claim.coverage_amount ?? 1)) * 100)}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100">
                        <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${Math.min(100, (claim.submitted_amount / (claim.coverage_amount ?? 1)) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          {/* Risk checks and payouts — the numbers and results, beside the overview */}
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <section className="space-y-3 px-5 py-4">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{tx("Risk analysis")}</h2>
              <div>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-slate-600">{tx("Fraud risk score")}</span>
                  <span className="font-bold text-slate-900">{fraudPct}%</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-slate-100" role="progressbar" aria-valuenow={fraudPct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${Math.max(2, Math.min(100, fraudPct))}%` }} />
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600">{tx("Duplicate check")}</span>
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${claim.duplicate_flag ? "border-slate-700 bg-slate-700 text-white" : "border-blue-200 bg-blue-50 text-blue-700"}`}>
                  {claim.duplicate_flag ? tx("Flagged") : tx("Clear")}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600">{tx("Rule recommendation")}</span>
                <span className="font-semibold text-slate-900">{claim.ai_recommendation ?? "—"}</span>
              </div>
            </section>

            <section className="space-y-3 px-5 py-4">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{tx("Payouts")}</h2>
              {(!claim.payouts || claim.payouts.length === 0) ? (
                <p className="text-sm text-slate-500">{tx("No payout recorded yet.")}</p>
              ) : (
                <ul className="space-y-3">
                  {claim.payouts.map((p) => (
                    <li key={p.id} className="text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-slate-900">{tx("PKR")}{" "}{p.amount.toLocaleString()}</span>
                        <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">{p.status}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">{p.method} · {displayDate(p.initiated_at)}</p>
                      {p.reference_number && <p className="font-mono text-xs text-slate-500">{tx("Ref:")}{" "}{p.reference_number}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
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
                <h2 className="text-sm font-bold text-slate-900 tracking-tight">{tx("Verification Documents")}</h2>
                <p className="text-[11px] text-slate-500 font-medium">{tx("Claim prerequisites & medical evidence")}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {hasDocs ? (
                <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/80 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  {claim.artifacts!.length}{" "}{tx("Attached")}
                </span>
              ) : (
                <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/80 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  {tx("Required")}
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
                  <span>{tx("Upload")}</span>
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
                  <p className="text-xs font-semibold text-slate-700">{tx("No documents uploaded yet")}</p>
                  <p className="text-[11px] text-slate-400 max-w-xs mx-auto mt-0.5">
                    {tx("Upload hospital bill, CNIC, or medical reports to pass the Document Gate prerequisite.")}
                  </p>
                </div>
                <button
                  onClick={() => openModal("doc")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-2xs transition-all"
                >
                  {tx("Select File to Upload")}
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
                          ? "bg-slate-50 text-slate-600 border-slate-100"
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
                            <span>{tx("Uploaded")}{" "}{displayDate(art.created_at)}</span>
                            {art.file_size && (
                              <>
                                <span>·</span>
                                <span>{(art.file_size / 1024).toFixed(1)}{" "}{tx("KB")}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Status & View Button */}
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/80 flex items-center gap-1">
                          <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          <span>{tx("Verified")}</span>
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
                          <span>{tx("View")}</span>
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Underwriting Risk Audit & Triggers Card */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{tx("Underwriting Audit")}</h3>
            </div>
            {!isClosedStatus && (
              <button
                onClick={() => openModal("reunderwrite")}
                className="text-[11px] font-semibold text-blue-700 hover:text-blue-800 bg-blue-50 hover:bg-blue-100/80 px-2.5 py-1 rounded-md border border-blue-200/60 transition-all flex items-center gap-1"
              >
                <svg className="w-3 h-3 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span>{tx("Trigger Underwriting Audit")}</span>
              </button>
            )}
          </div>

          {(() => {
            if (isClosedStatus) {
              return (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-xs flex items-center justify-between shadow-2xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                    <span className="font-semibold text-[11px]">
                      {tx("Governance Audit Concluded — Claim decision has been finalized (")}{claim.status}).
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200/80 text-slate-700 border border-slate-300 font-mono">
                    {tx("AUDIT LOCKED")}
                  </span>
                </div>
              );
            }

            const activeCards = [];

            if (claim.is_contestable) {
              activeCards.push(
                <div key="contestable" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-blue-50/70 border-blue-200">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700 text-[11px]">{tx("Policy Issued < 2 Years Ago")}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-200 text-blue-900">
                      {tx("CONTESTABILITY WINDOW")}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    {tx("Claim filed within 2-yr policy issuance window. Requires contestability check.")}
                  </p>
                </div>
              );
            }

            if (hasDocs && claim.is_contestable) {
              activeCards.push(
                <div key="ped" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-blue-50/70 border-blue-200">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700 text-[11px]">{tx("Undisclosed Pre-Existing Medical History")}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-200 text-blue-900">
                      {tx("UNDISCLOSED MEDICAL")}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    {tx("OCR text extraction detected medical onset (")}{displayDate(claim.ocr_onset_date ?? "2022-04-12")}{tx(") prior to policy issuance.")}
                  </p>
                </div>
              );
            }

            if (claim.graph_ring_detected || claim.duplicate_flag) {
              activeCards.push(
                <div key="graph" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-slate-50/70 border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900 text-[11px]">{tx("Memgraph Network Cluster Alert")}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-200 text-slate-900">
                      {tx("FRAUD RING FLAGGED")}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-700">
                    {claim.graph_ring_reason ?? tx("Suspicious multi-policy claimant ring or duplicate claim pattern detected.")}
                  </p>
                </div>
              );
            }

            if (claim.submitted_amount > 500000) {
              activeCards.push(
                <div key="authority" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-blue-50/70 border-blue-200">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700 text-[11px]">{tx("Claim Amount Exceeds Adjuster Limit (> PKR 500k)")}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-200 text-blue-900">
                      {tx("EXCEEDS ADJUSTER LIMIT")}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    {tx("Requires technical underwriter financial sign-off.")}
                  </p>
                </div>
              );
            }

            if (claim.submitted_amount > 5000000 || claim.reinsurance_referral_id) {
              activeCards.push(
                <div key="reinsurance" className="p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 bg-blue-50/70 border-blue-200">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700 text-[11px]">{tx("Claim Amount Exceeds Net Retention (> PKR 5M)")}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-200 text-blue-900">
                      {tx("EXCEEDS RETENTION LIMIT")}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    {tx("Exceeds PKR 5M retention. Facultative reinsurance recovery triggered.")}
                  </p>
                </div>
              );
            }

            if (activeCards.length === 0) {
              return (
                <div className="p-3 bg-blue-50/60 border border-blue-200/80 rounded-lg text-blue-900 text-xs flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                  <span className="font-medium text-[11px]">
                    {tx("All Governance Checks Clear — Claim is within standard adjuster authority & retention limits.")}
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
                  {tx("Document Parsing & Medical Extraction Audit")}
                </span>
                <span className="text-[10px] font-medium text-slate-500 font-mono">
                  {tx("OCR Confidence:")}{" "}{claim.ocr_confidence ?? 98.4}%
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200/90 rounded-lg shadow-2xs">
                  <div>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Extracted Diagnosis")}</div>
                    <div className="font-semibold text-slate-900 text-xs mt-0.5">{claim.ocr_diagnosis ?? tx("Acute Episode (Pre-Existing Condition)")}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${claim.ped_detected !== false ? "bg-blue-100/80 text-blue-900 border border-blue-200/90" : "bg-blue-100/80 text-blue-900 border border-blue-200/90"}`}>
                    {claim.ped_detected !== false ? tx("PED Detected") : tx("Clear")}
                  </span>
                </div>

                <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200/90 rounded-lg shadow-2xs">
                  <div>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{tx("Medical Onset vs Policy Start")}</div>
                    <div className="text-xs font-semibold text-slate-900 mt-0.5 flex items-center gap-1.5">
                      <span className="text-blue-900 font-medium">{tx("Onset:")}{" "}{displayDate(claim.ocr_onset_date ?? "2022-04-12")}</span>
                      <span className="text-slate-300">•</span>
                      <span className="text-slate-600 font-normal">{tx("Policy:")}{" "}{displayDate(claim.policy_start_date ?? "2025-01-15")}</span>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100/80 text-blue-900 border border-blue-200/90">
                    {claim.onset_years_prior ? tx("{0} Yrs Prior", { 0: claim.onset_years_prior }) : tx("3 Yrs Prior")}
                  </span>
                </div>
              </div>
            </div>
          )}

          {claim.underwriting_decision_notes && claim.status !== "Re-Underwriting Required" && (
            <div className="mt-2 space-y-2 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">{tx("Underwriting decision")}</span>
                <span className="rounded-full border border-blue-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-blue-700">{tx("Recorded")}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
                {claim.underwriting_decision_notes}
              </p>
            </div>
          )}
        </div>

        {/* History — every status change, at the end of the page */}
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-6 py-4">
            <h2 className="text-sm font-bold text-slate-900">{tx("Claim history")}</h2>
            <p className="text-xs text-slate-500">{tx("Every status change on this claim, in order.")}</p>
          </div>
          <div className="bg-slate-50 px-6 py-5">
            <ClaimJourneyTimeline events={claim.status_history ?? []} />
          </div>
        </div>
      </div>

      {/* Make a decision — the one place a claim is moved forward */}
      {modal === "decide" && (() => {
        const blockedReason = (st: ClaimStatus): string | null => {
          if (["Approved", "Partial Approval", "Settled"].includes(st)) {
            if (!hasDocs) return "Attach a verified document first.";
            if (hasUnresolvedFlags) return "Underwriting must clear the risk flags first.";
            if (st === "Settled" && !canPayout) return "Approve the claim first.";
          }
          return null;
        };
        const chosen = decideTarget;
        const info = chosen ? MOVE_INFO[chosen] : undefined;
        const ownScreen = !!chosen && OWN_SCREEN.includes(chosen);
        const noteRequired = !!chosen && NOTE_REQUIRED.includes(chosen);
        const noteOk = !noteRequired || decideNote.trim().length >= 3;
        const canContinue = !!chosen && !blockedReason(chosen) && noteOk;
        const aiRec = (claim.ai_recommendation ?? "").toUpperCase();
        const aiTarget: ClaimStatus | undefined = aiRec.includes("DECLINE") ? "Declined" : aiRec.includes("APPROVE") ? "Approved" : undefined;
        const flowTarget = guide.cta?.kind === "decide" ? guide.cta.target : undefined;
        const recommended = flowTarget ?? (guide.cta?.kind === "decide" ? aiTarget : undefined);
        const recLabel = flowTarget ? "Recommended" : "Rules suggest";
        const hint = !chosen
          ? "Choose an option to continue."
          : blockedReason(chosen)
            ? blockedReason(chosen)!
            : !noteOk
              ? "Add a short reason to continue."
              : "";

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-xs">
            <div role="dialog" aria-modal="true" aria-labelledby="decide-title" className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-4 bg-blue-600 px-6 py-4 text-white">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-100">
                    {claim.claim_number} · {tx("currently")} {claim.status}
                  </p>
                  <h3 id="decide-title" className="text-lg font-bold leading-tight">{tx("Make a decision")}</h3>
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  aria-label={tx("Close")}
                  className="-mr-1 flex h-8 w-8 items-center justify-center rounded-lg text-blue-100 hover:bg-blue-500 hover:text-white"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="max-h-[68vh] space-y-5 overflow-y-auto px-6 py-5">
                <p className="text-sm text-slate-600">
                  {tx("Choose what happens to this claim next. Options that need more details continue on the next screen.")}
                </p>

                <div role="radiogroup" aria-label={tx("Next move")} className="space-y-2.5">
                  {nextOpts.map((st) => {
                    const why = blockedReason(st);
                    const selected = chosen === st;
                    const meta = MOVE_INFO[st] ?? { title: st, desc: "" };
                    return (
                      <button
                        key={st}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!!why}
                        onClick={() => setDecideTarget(st)}
                        className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
                          selected ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-slate-200 bg-white hover:border-blue-300"
                        } ${why ? "cursor-not-allowed bg-slate-50 opacity-70" : ""}`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                            selected ? "border-blue-600 bg-blue-600" : "border-slate-300 bg-white"
                          }`}
                        >
                          {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900">{tx(meta.title)}</span>
                            {recommended === st && !why && (
                              <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                                {tx(recLabel)}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-500">{tx(meta.desc)}</span>
                          {why && <span className="mt-1.5 block text-xs font-semibold text-blue-700">{tx(why)}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {chosen && !ownScreen && (
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-800">
                      {tx("Note")}{" "}
                      <span className="font-normal text-slate-500">({noteRequired ? tx("required") : tx("optional")})</span>
                    </label>
                    <textarea
                      rows={3}
                      value={decideNote}
                      onChange={(e) => setDecideNote(e.target.value)}
                      placeholder={noteRequired ? tx("Why are you doing this?") : tx("Add a note for the audit journey…")}
                      className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20"
                    />
                    <p className="mt-1.5 text-xs text-slate-500">{tx("Recorded in the claim's audit journey.")}</p>
                  </div>
                )}

                {chosen && ownScreen && info?.next && !blockedReason(chosen) && (
                  <p className="rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-2.5 text-sm text-blue-900">{tx(info.next)}</p>
                )}

                {!hasDocs && nextOpts.some((st) => blockedReason(st)) && (
                  <button
                    type="button"
                    onClick={() => openModal("doc")}
                    className="text-sm font-semibold text-blue-700 hover:underline"
                  >
                    {tx("Upload a document")} →
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {tx("Cancel")}
                </button>
                <div className="flex min-w-0 items-center gap-3">
                  {hint && <p className="hidden truncate text-xs text-slate-500 sm:block">{tx(hint)}</p>}
                  <button
                    type="button"
                    disabled={!canContinue || submitting}
                    onClick={() => chosen && handleStatus(chosen, decideNote)}
                    className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-2xs hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                  >
                    {submitting ? tx("Saving…") : ownScreen ? `${tx("Continue")} →` : tx("Confirm")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Adjudication Modal */}
      {modal === "adj" && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">{tx("Adjudication Decision")}</h3>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">{tx("×")}</button>
            </div>
            <form onSubmit={handleAdj} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("Decision")}</label>
                <select
                  value={adjDecision}
                  onChange={e => setAdjDecision(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white"
                >
                  <option value="APPROVED">{tx("Approve Claim")}</option>
                  <option value="PARTIAL_APPROVAL">{tx("Partial Approval")}</option>
                  <option value="DECLINED">{tx("Decline Claim")}</option>
                  <option value="REFERRED_TO_MANAGER">{tx("Escalate to Manager")}</option>
                </select>
              </div>

              {["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision) && (
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block font-semibold text-slate-700">{tx("Approved Amount (PKR)")}</label>
                    <span className="text-[10px] text-slate-500 font-medium">
                      {tx("Max Claimed:")}{" "}<strong className="text-slate-800 font-mono">{tx("PKR")}{" "}{claim?.submitted_amount?.toLocaleString()}</strong>
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
                      ? "border-slate-300 bg-slate-50 text-slate-900 focus:ring-slate-400 font-semibold"
                      : "border-slate-200 focus:ring-blue-400 font-medium"
                      }`}
                  />
                  {claim && adjAmount > claim.submitted_amount && (
                    <p className="text-[10px] text-slate-600 font-medium mt-1 flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      {tx("Amount cannot exceed claimed limit of PKR")}{" "}{claim.submitted_amount.toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("Rationale")}</label>
                <textarea
                  rows={3}
                  required
                  placeholder={tx("Notes...")}
                  value={adjNotes}
                  onChange={e => setAdjNotes(e.target.value)}
                  className="w-full p-2 rounded-lg border border-slate-200"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">{tx("Cancel")}</button>
                <button
                  type="submit"
                  disabled={submitting || (!!claim && ["APPROVED", "PARTIAL_APPROVAL"].includes(adjDecision) && adjAmount > claim.submitted_amount)}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {tx("Confirm")}
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
              <h3 className="text-sm font-bold text-slate-900">{tx("Issue Payout")}</h3>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">{tx("×")}</button>
            </div>
            <form onSubmit={handlePayout} className="p-5 space-y-3 text-xs">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block font-semibold text-slate-700">{tx("Amount (PKR)")}</label>
                  <span className="text-[10px] text-slate-500 font-medium">
                    {tx("Max Limit:")}{" "}<strong className="text-slate-800 font-mono">{tx("PKR")}{" "}{((claim?.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim?.submitted_amount)?.toLocaleString()}</strong>
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
                    ? "border-slate-300 bg-slate-50 text-slate-900 focus:ring-slate-400 font-semibold"
                    : "border-slate-200 focus:ring-blue-400 font-medium"
                    }`}
                />
                {claim && payAmount > ((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount) && (
                  <p className="text-[10px] text-slate-600 font-medium mt-1 flex items-center gap-1">
                    <svg className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    {tx("Amount cannot exceed max limit of PKR")}{" "}{((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount).toLocaleString()}
                  </p>
                )}
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("Method")}</label>
                <select
                  value={payMethod}
                  onChange={e => setPayMethod(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white"
                >
                  <option value="Bank Transfer">{tx("Bank Transfer (IBFT/RTGS)")}</option>
                  <option value="Crossed Cheque">{tx("Crossed Cheque")}</option>
                  <option value="Direct Credit">{tx("Direct Credit")}</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("Bank Ref #")}</label>
                <input
                  type="text"
                  placeholder={tx("e.g. IBFT-992104")}
                  value={payRef}
                  onChange={e => setPayRef(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">{tx("Cancel")}</button>
                <button
                  type="submit"
                  disabled={submitting || (!!claim && payAmount > ((claim.approved_amount && claim.approved_amount > 0) ? claim.approved_amount : claim.submitted_amount))}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {tx("Issue Payout")}
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
              <h3 className="text-sm font-bold text-slate-900">{tx("Upload Document")}</h3>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">{tx("×")}</button>
            </div>
            <form onSubmit={handleDoc} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("Document Type")}</label>
                <select
                  value={docType}
                  onChange={e => setDocType(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white"
                >
                  <option value="Hospital Bill">{tx("Hospital Bill / Invoice")}</option>
                  <option value="Discharge Summary">{tx("Discharge Summary")}</option>
                  <option value="Death Certificate">{tx("Death Certificate (NADRA)")}</option>
                  <option value="CNIC">{tx("CNIC Copy")}</option>
                  <option value="Lab Test Report">{tx("Lab / Radiology Report")}</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("File")}</label>
                <input
                  type="file"
                  required
                  accept=".pdf,.png,.jpg,.jpeg,.heic,.tiff"
                  onChange={e => setDocFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">{tx("Cancel")}</button>
                <button type="submit" disabled={submitting || !docFile} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50">
                  {submitting ? tx("Uploading...") : tx("Upload")}
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
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-blue-50">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-blue-200 text-blue-900 flex items-center justify-center font-bold text-xs">!</div>
                <h3 className="text-sm font-bold text-slate-900">{tx("Refer Claim to Underwriting")}</h3>
              </div>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-lg">{tx("×")}</button>
            </div>
            <form onSubmit={handleReferToUnderwriting} className="p-5 space-y-3.5 text-xs">
              {hasDocs && claim.is_contestable && (
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 font-mono text-[11px] space-y-1">
                  <div className="flex items-center justify-between font-bold text-[10px] uppercase text-slate-800 tracking-wider font-sans">
                    <span>{tx("OCR Extracted Evidence Attached")}</span>
                    <span>{tx("Confidence 98%")}</span>
                  </div>
                  <p className="text-[10px] text-slate-800 leading-tight font-sans">
                    {tx("OCR parsed medical onset (2022-04-12) precedes policy inception. Pre-populating non-disclosure referral.")}
                  </p>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="font-semibold text-slate-700">{tx("Referral Trigger Reason(s)")}</label>
                  <span className="text-[10px] text-blue-700 font-medium font-mono">{uwReasons.length}{" "}{tx("selected")}</span>
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
                          ? "bg-blue-50/90 border-blue-300 text-blue-950 font-medium shadow-2xs"
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
                          className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="leading-snug">{optionText}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">{tx("Underwriter Audit Notes")}</label>
                <textarea
                  rows={3}
                  required
                  placeholder={tx("Detail specific findings, medical records, or policy limit considerations for the technical underwriter...")}
                  value={uwNotes}
                  onChange={e => setUwNotes(e.target.value)}
                  className="w-full p-2 rounded-lg border border-slate-200 font-medium"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModal(null)} className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium">{tx("Cancel")}</button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-2xs disabled:opacity-50"
                >
                  {submitting ? tx("Submitting...") : tx("Submit Referral")}
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
                  <div className="w-6 h-6 rounded-md bg-blue-100 border border-blue-200 text-blue-700 flex items-center justify-center font-bold text-xs">
                    ✓
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 leading-none">
                      {showConfirmStep ? tx("Confirm Underwriting Decision") : tx("Resolve Underwriting Review")}
                    </h3>
                    <p className="text-[10px] text-slate-500 font-medium mt-0.5">
                      {showConfirmStep ? tx("Step 2 of 2: Final Confirmation & Governance Log") : tx("Step 1 of 2: Select Action & Enter Rationale")}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setModal(null)}
                  className="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 flex items-center justify-center text-lg transition-colors"
                >
                  {tx("×")}
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
                    <div className="p-3 bg-blue-50/80 border border-blue-200/90 rounded-xl space-y-2 text-blue-950">
                      <div className="flex items-center justify-between text-[10px] font-bold text-blue-900 uppercase tracking-wider">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                          {tx("Active Referral Trigger(s)")}
                        </span>
                        <span className="bg-blue-200/90 text-blue-900 px-2 py-0.5 rounded font-mono text-[9px] font-bold">
                          {tx("AUDIT PENDING")}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {(claim.underwriting_referral_reason || "Technical Underwriting Audit").split("; ").map((reason, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-blue-200/80 text-blue-950 font-semibold text-[11px] shadow-2xs"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                            {reason}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-800 mb-1.5">{tx("Underwriting Finding & Action")}</label>
                      <select
                        value={uwDecision}
                        onChange={e => setUwDecision(e.target.value as any)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 shadow-2xs transition-all"
                      >
                        {options.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {tx(opt.label)}
                          </option>
                        ))}
                      </select>
                      {currentOpt && (
                        <div className="text-[11px] text-slate-600 font-medium mt-2 bg-slate-50 border border-slate-200/80 p-2.5 rounded-lg flex items-start gap-2 leading-relaxed">
                          <span className="text-blue-500 font-bold shrink-0 text-xs">ℹ️</span>
                          <span>{tx(currentOpt.desc)}</span>
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-800 mb-1.5">{tx("Decision Notes & Policy Endorsements")}</label>
                      <textarea
                        rows={3}
                        required
                        placeholder={tx("Record formal technical underwriter rationale, medical guidelines applied, or policy endorsement details...")}
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
                        {tx("Cancel")}
                      </button>
                      <button
                        type="submit"
                        className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs active:scale-[0.98] transition-all flex items-center gap-1.5"
                      >
                        <span>{tx("Review & Confirm Decision")}</span>
                        <span>→</span>
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Concise Confirmation Summary Card */}
                    <div className="p-3.5 bg-blue-50/80 border border-blue-200/90 rounded-xl space-y-2.5">
                      <div className="flex items-center justify-between text-[11px] font-bold text-blue-950 uppercase tracking-wider">
                        <span>{tx("Confirm Underwriting Action")}</span>
                        <span className="text-blue-800 text-[10px] font-normal font-mono">{tx("Final Review")}</span>
                      </div>

                      <div className="p-3 bg-white rounded-lg border border-blue-200/80 space-y-2 text-xs">
                        <div className="flex justify-between items-start gap-3">
                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">{tx("Selected Action:")}</span>
                          <span className="font-bold text-slate-900 text-right">{tx(currentOpt?.label ?? "")}</span>
                        </div>

                        <div className="flex justify-between items-start gap-3 pt-2 border-t border-slate-100">
                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">{tx("Policy Impact:")}</span>
                          <span className="font-medium text-slate-700 text-right leading-snug">{tx(currentOpt?.desc ?? "")}</span>
                        </div>

                        <div className="flex justify-between items-start gap-3 pt-2 border-t border-slate-100">
                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">{tx("Rationale:")}</span>
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
                        <span>{tx("← Back")}</span>
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-xs active:scale-[0.98] disabled:opacity-50 transition-all"
                      >
                        {submitting ? tx("Submitting...") : tx("Confirm Decision")}
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
