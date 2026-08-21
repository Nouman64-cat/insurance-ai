"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getClaimDetail, updateClaimStatus, adjudicateClaim,
  createClaimPayout, referClaimToReinsurance, uploadClaimDocument,
  Claim, ClaimStatus,
} from "@/app/services/claims";

const VALID_NEXT: Record<string, ClaimStatus[]> = {
  "New":                  ["Triaged", "Under Investigation", "Pending Documents"],
  "Triaged":              ["Under Investigation", "Pending Documents", "Referred to Manager", "Declined"],
  "Pending Documents":    ["Under Investigation", "Triaged", "Declined"],
  "Under Investigation":  ["Approved", "Partial Approval", "Declined", "Pending Documents", "Referred to Manager"],
  "Referred to Manager":  ["Approved", "Partial Approval", "Declined", "Under Investigation"],
  "Approved":             ["Settled", "Closed"],
  "Partial Approval":     ["Settled", "Closed"],
  "Declined":             ["Closed"],
  "Settled":              ["Closed"],
  "Closed":               [],
};

const WORKFLOW_STEPS: ClaimStatus[] = ["New", "Triaged", "Under Investigation", "Approved", "Settled"];

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="px-2.5 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-800 border border-slate-200">
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

  const [modal, setModal] = useState<"adj" | "payout" | "doc" | null>(null);

  const [nextStatus, setNextStatus] = useState<ClaimStatus>("Triaged");
  const [statusNote, setStatusNote] = useState("");

  const [adjDecision, setAdjDecision] = useState<"APPROVED"|"PARTIAL_APPROVAL"|"DECLINED"|"REFERRED_TO_MANAGER">("APPROVED");
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
    setSubmitting(true);
    try {
      await updateClaimStatus(claimId, nextStatus, statusNote);
      showToast("ok", `Status updated to ${nextStatus}`);
      setStatusNote(""); setModal(null); load();
    } catch (e: any) { showToast("err", e.response?.data?.detail || "Status update failed."); }
    finally { setSubmitting(false); }
  };

  const handleAdj = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      await adjudicateClaim(claimId, { decision: adjDecision, approved_amount: adjAmount, notes: adjNotes });
      showToast("ok", `Decision recorded: ${adjDecision}`);
      setModal(null); setAdjNotes(""); load();
    } catch (e: any) { showToast("err", e.response?.data?.detail || "Adjudication failed."); }
    finally { setSubmitting(false); }
  };

  const handlePayout = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      await createClaimPayout(claimId, { amount: payAmount, method: payMethod, reference_number: payRef || undefined });
      showToast("ok", `Payout issued successfully`);
      setModal(null); setPayRef(""); load();
    } catch (e: any) { showToast("err", e.response?.data?.detail || "Payout failed."); }
    finally { setSubmitting(false); }
  };

  const handleDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docFile) return;
    setSubmitting(true);
    try {
      await uploadClaimDocument(claimId, docFile, docType);
      showToast("ok", `${docFile.name} uploaded successfully`);
      setModal(null); setDocFile(null); load();
    } catch (e: any) { showToast("err", e.response?.data?.detail || "Document upload failed."); }
    finally { setSubmitting(false); }
  };

  const handleReinsurance = async () => {
    setSubmitting(true);
    try {
      await referClaimToReinsurance(claimId);
      showToast("ok", "Referred to Reinsurance team");
      load();
    } catch (e: any) { showToast("err", e.response?.data?.detail || "Referral failed."); }
    finally { setSubmitting(false); }
  };

  if (loading || !claim) return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6">
      <div className="text-xs text-slate-500">Loading claim workbench...</div>
    </div>
  );

  const stepIdx = WORKFLOW_STEPS.indexOf(claim.status as ClaimStatus);
  const nextOpts = VALID_NEXT[claim.status] || [];
  const hasDocs = (claim.artifacts?.length ?? 0) > 0;
  const fraudPct = Math.round((claim.fraud_probability ?? 0) * 100);
  const canPayout = ["Approved", "Partial Approval"].includes(claim.status);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {/* Toast Alert */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 px-4 py-2.5 rounded-lg shadow-sm text-xs font-medium bg-slate-900 text-white">
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
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

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setModal("doc")}
            className="text-xs font-semibold px-3 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700 shadow-sm"
          >
            Upload Doc
          </button>
          <button
            onClick={() => setModal("adj")}
            className="text-xs font-semibold px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg shadow-sm"
          >
            Adjudicate
          </button>
          {canPayout && (
            <button
              onClick={() => setModal("payout")}
              className="text-xs font-semibold px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg shadow-sm"
            >
              Issue Payout
            </button>
          )}
          <button
            onClick={handleReinsurance}
            disabled={submitting}
            className="text-xs font-semibold px-3 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700 shadow-sm disabled:opacity-50"
          >
            Reinsurance
          </button>
        </div>
      </div>

      {/* Mandatory Document Gate Notice */}
      {!hasDocs && claim.status !== "Closed" && claim.status !== "Declined" && (
        <div className="p-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 flex items-center justify-between shadow-sm">
          <div>
            <span className="font-semibold text-slate-900">Document Gate:</span> At least 1 verified document is required before approval or settlement.
          </div>
          <button
            onClick={() => setModal("doc")}
            className="px-3 py-1 bg-slate-900 text-white rounded text-xs font-medium ml-4 shrink-0"
          >
            Upload
          </button>
        </div>
      )}

      {/* Lifecycle Progress */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Claim Lifecycle</div>
        <div className="flex items-center">
          {WORKFLOW_STEPS.map((step, i) => {
            const isDone = i < stepIdx;
            const isCurrent = i === stepIdx;
            return (
              <div key={step} className="flex-1 flex items-center">
                <div className="flex flex-col items-center flex-1 gap-1">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      isCurrent
                        ? "bg-slate-900 text-white"
                        : isDone
                        ? "bg-slate-200 text-slate-700"
                        : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {isDone ? "✓" : i + 1}
                  </div>
                  <span className={`text-[11px] font-medium text-center ${isCurrent ? "text-slate-900 font-bold" : "text-slate-500"}`}>
                    {step}
                  </span>
                </div>
                {i < WORKFLOW_STEPS.length - 1 && (
                  <div className={`h-0.5 flex-1 mx-2 ${isDone ? "bg-slate-300" : "bg-slate-100"}`} />
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
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
              <h2 className="text-sm font-bold text-slate-800">Policy & Claimant Overview</h2>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-slate-400">Claimant</div>
                  <div className="font-semibold text-slate-900 mt-0.5">{claim.claimant_name}</div>
                </div>
                <div>
                  <div className="text-slate-400">Policy Ref</div>
                  <div className="font-mono font-semibold text-slate-900 mt-0.5">{claim.policy_number ?? "—"}</div>
                </div>
                <div>
                  <div className="text-slate-400">Plan</div>
                  <div className="font-semibold text-slate-900 mt-0.5">{claim.policy_type ?? "—"}</div>
                </div>
                <div>
                  <div className="text-slate-400">Coverage Limit</div>
                  <div className="font-semibold text-slate-900 mt-0.5">PKR {(claim.coverage_amount ?? 0).toLocaleString()}</div>
                </div>
              </div>

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

          {/* Documents Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-sm font-bold text-slate-800">Verification Documents</h2>
              <button onClick={() => setModal("doc")} className="text-xs font-semibold text-slate-700 hover:underline">
                + Upload
              </button>
            </div>
            <div className="p-5">
              {!hasDocs ? (
                <p className="text-xs text-slate-400 py-2">No verification documents attached.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {claim.artifacts!.map(art => (
                    <div key={art.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-medium text-slate-900">{art.file_name}</div>
                        <div className="text-[10px] text-slate-400">{art.document_type} · {art.created_at.split("T")[0]}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                          {art.status}
                        </span>
                        {art.storage_url && (
                          <a href={art.storage_url} target="_blank" rel="noreferrer" className="font-semibold text-slate-700 hover:underline">
                            View
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Audit History */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
              <h2 className="text-sm font-bold text-slate-800">Status & Audit History</h2>
            </div>
            <div className="p-5">
              {(!claim.status_history || claim.status_history.length === 0) ? (
                <p className="text-xs text-slate-400 py-2">No status history logged.</p>
              ) : (
                <div className="space-y-3 text-xs">
                  {claim.status_history.map((h, i) => (
                    <div key={h.id || i} className="pb-2 border-b border-slate-50 last:border-0 last:pb-0">
                      <div className="flex justify-between font-semibold text-slate-900">
                        <span>{h.from_status ? `${h.from_status} → ${h.to_status}` : h.to_status}</span>
                        <span className="text-[10px] text-slate-400 font-normal">{h.created_at.replace("T", " ").slice(0, 16)}</span>
                      </div>
                      <p className="text-slate-600 mt-0.5">{h.notes || "Status transition"}</p>
                      <p className="text-[10px] text-slate-400">By {h.actor_name}</p>
                    </div>
                  ))}
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
                  className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
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
                  <label className="block font-semibold text-slate-700 mb-1">Approved Amount (PKR)</label>
                  <input
                    type="number"
                    required
                    value={adjAmount}
                    onChange={e => setAdjAmount(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200"
                  />
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
                <button type="submit" disabled={submitting} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50">
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
                <label className="block font-semibold text-slate-700 mb-1">Amount (PKR)</label>
                <input
                  type="number"
                  required
                  value={payAmount}
                  onChange={e => setPayAmount(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200"
                />
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
                <button type="submit" disabled={submitting} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50">
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
                <button type="submit" disabled={submitting || !docFile} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50">
                  {submitting ? "Uploading..." : "Upload"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
