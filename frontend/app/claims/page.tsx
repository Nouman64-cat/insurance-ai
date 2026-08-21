"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listClaims, createClaim, Claim, CreateClaimRequest } from "@/app/services/claims";
import { listPolicies, PolicyListItem } from "@/app/services/policies";

const STATUS_STYLE: Record<string, string> = {
  "New":                 "bg-slate-100 text-slate-700",
  "Triaged":             "bg-blue-50 text-blue-800",
  "Under Investigation": "bg-amber-50 text-amber-800",
  "Pending Documents":   "bg-orange-50 text-orange-800",
  "Approved":            "bg-emerald-50 text-emerald-800",
  "Partial Approval":    "bg-teal-50 text-teal-800",
  "Declined":            "bg-rose-50 text-rose-800",
  "Referred to Manager": "bg-purple-50 text-purple-800",
  "Settled":             "bg-slate-100 text-slate-800",
  "Closed":              "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium ${style}`}>
      {status}
    </span>
  );
}

function RiskBadge({ prob, flag }: { prob: number; flag: boolean }) {
  const pct = Math.round(prob * 100);
  if (flag) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700">Duplicate</span>;
  }
  if (pct >= 70) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700">High ({pct}%)</span>;
  }
  if (pct >= 30) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700">Medium ({pct}%)</span>;
  }
  return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700">Low ({pct}%)</span>;
}

export default function ClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [step, setStep] = useState(1);

  const [form, setForm] = useState<CreateClaimRequest>({
    policy_id: "",
    claim_type: "Hospitalization",
    submitted_amount: 50000,
    incident_date: new Date().toISOString().split("T")[0],
    notes: "",
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listClaims({
        status: statusFilter !== "ALL" ? statusFilter : undefined,
        claim_type: typeFilter !== "ALL" ? typeFilter : undefined,
        search: search.trim() || undefined,
      });
      setClaims(data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [statusFilter, typeFilter]);
  useEffect(() => { listPolicies().then(setPolicies).catch(() => {}); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.policy_id) { setErrorMsg("Please select an active policy."); return; }
    setSubmitting(true); setErrorMsg("");
    try {
      await createClaim(form);
      setShowModal(false); setStep(1);
      setForm({ policy_id: "", claim_type: "Hospitalization", submitted_amount: 50000, incident_date: new Date().toISOString().split("T")[0], notes: "" });
      fetchData();
    } catch (err: any) {
      setErrorMsg(err.response?.data?.detail || "Failed to submit claim FNOL.");
    } finally { setSubmitting(false); }
  };

  const openModal = () => { setShowModal(true); setStep(1); setErrorMsg(""); };

  // KPIs
  const total = claims.length;
  const inProgress = claims.filter(c => ["New","Triaged","Under Investigation","Pending Documents"].includes(c.status)).length;
  const totalApproved = claims.filter(c => ["Approved","Partial Approval","Settled"].includes(c.status)).reduce((s,c) => s+(c.approved_amount||0), 0);
  const highRisk = claims.filter(c => c.fraud_probability >= 0.5 || c.duplicate_flag).length;

  const selectedPolicy = policies.find(p => p.id === form.policy_id);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Claims Management</h1>
          <p className="text-xs text-slate-500 mt-1">
            FNOL intake, rules-engine adjudication, document verification, and settlement payouts.
          </p>
        </div>
        <button
          onClick={openModal}
          className="text-xs font-semibold px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg shadow-sm transition-colors"
        >
          + File New Claim
        </button>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Total Claims</div>
          <div className="text-2xl font-bold text-slate-900">{total}</div>
          <div className="text-xs text-slate-400 mt-1">All time records</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">In Progress</div>
          <div className="text-2xl font-bold text-slate-900">{inProgress}</div>
          <div className="text-xs text-slate-400 mt-1">Awaiting action</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Approved Value</div>
          <div className="text-2xl font-bold text-slate-900">PKR {(totalApproved / 1000000).toFixed(2)}M</div>
          <div className="text-xs text-slate-400 mt-1">Disbursed & approved</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Risk Flagged</div>
          <div className="text-2xl font-bold text-slate-900">{highRisk}</div>
          <div className="text-xs text-slate-400 mt-1">Fraud or duplicate</div>
        </div>
      </div>

      {/* Register & Filters Card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <input
              type="text"
              placeholder="Search Claim #, Policy #, or Claimant..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === "Enter" && fetchData()}
              className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:border-slate-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none"
            >
              <option value="ALL">All Statuses</option>
              <option value="New">New</option>
              <option value="Triaged">Triaged</option>
              <option value="Under Investigation">Under Investigation</option>
              <option value="Pending Documents">Pending Documents</option>
              <option value="Approved">Approved</option>
              <option value="Partial Approval">Partial Approval</option>
              <option value="Declined">Declined</option>
              <option value="Referred to Manager">Referred to Manager</option>
              <option value="Settled">Settled</option>
              <option value="Closed">Closed</option>
            </select>

            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none"
            >
              <option value="ALL">All Types</option>
              <option value="Hospitalization">Hospitalization</option>
              <option value="Surgery">Surgery</option>
              <option value="Death Claim">Death Claim</option>
              <option value="Reimbursement">Reimbursement</option>
            </select>

            <button
              onClick={fetchData}
              className="text-xs font-semibold px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
            >
              Search
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-100 text-xs">
              <tr>
                <th className="px-5 py-3 font-semibold">Claim Ref</th>
                <th className="px-5 py-3 font-semibold">Claimant</th>
                <th className="px-5 py-3 font-semibold">Policy #</th>
                <th className="px-5 py-3 font-semibold">Type</th>
                <th className="px-5 py-3 font-semibold text-right">Claimed</th>
                <th className="px-5 py-3 font-semibold text-right">Approved</th>
                <th className="px-5 py-3 font-semibold">Risk Flag</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-5 py-8 text-center text-slate-400 text-xs">
                    Loading claims register...
                  </td>
                </tr>
              ) : claims.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-5 py-8 text-center text-slate-400 text-xs">
                    No claims found.
                  </td>
                </tr>
              ) : (
                claims.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{c.claim_number}</div>
                    </td>
                    <td className="px-5 py-3 text-xs font-medium text-slate-800">{c.claimant_name}</td>
                    <td className="px-5 py-3 text-xs font-mono text-slate-500">{c.policy_number ?? "—"}</td>
                    <td className="px-5 py-3 text-xs text-slate-600">{c.claim_type}</td>
                    <td className="px-5 py-3 text-right font-medium text-slate-900">
                      PKR {c.submitted_amount.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-slate-900">
                      {c.approved_amount ? `PKR ${c.approved_amount.toLocaleString()}` : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <RiskBadge prob={c.fraud_probability} flag={c.duplicate_flag} />
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-5 py-3 text-center">
                      <Link
                        href={`/claims/${c.id}`}
                        className="text-xs font-semibold text-slate-700 hover:text-slate-900 underline"
                      >
                        Workbench
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">File First Notice of Loss (FNOL)</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-4 text-xs">
              {errorMsg && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-xs">
                  {errorMsg}
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Select Policy</label>
                    <select
                      required
                      value={form.policy_id}
                      onChange={e => setForm({ ...form, policy_id: e.target.value })}
                      className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white"
                    >
                      <option value="">-- Choose Policy --</option>
                      {policies.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.policy_number ?? p.id.slice(0, 8)} - {p.customer_name} ({p.product_name})
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedPolicy && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                      <span className="font-semibold">Selected:</span> {selectedPolicy.customer_name} ({selectedPolicy.product_name})
                    </div>
                  )}

                  <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!form.policy_id) { setErrorMsg("Please select a policy first."); return; }
                        setErrorMsg(""); setStep(2);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800"
                    >
                      Next Step
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Claim Type</label>
                      <select
                        value={form.claim_type}
                        onChange={e => setForm({ ...form, claim_type: e.target.value })}
                        className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white"
                      >
                        <option value="Hospitalization">Hospitalization</option>
                        <option value="Surgery">Surgery</option>
                        <option value="Death Claim">Death Claim</option>
                        <option value="Reimbursement">Reimbursement</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Submitted Amount (PKR)</label>
                      <input
                        type="number"
                        min="1000"
                        step="1000"
                        required
                        value={form.submitted_amount}
                        onChange={e => setForm({ ...form, submitted_amount: parseFloat(e.target.value) || 0 })}
                        className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Incident Date</label>
                    <input
                      type="date"
                      value={form.incident_date}
                      onChange={e => setForm({ ...form, incident_date: e.target.value })}
                      className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Description / Notes</label>
                    <textarea
                      rows={3}
                      placeholder="Describe the claim event..."
                      value={form.notes}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full text-xs p-2 rounded-lg border border-slate-200"
                    />
                  </div>

                  <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 font-medium"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50"
                    >
                      {submitting ? "Submitting..." : "Submit Claim"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
