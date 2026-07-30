"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import api from "@/app/services/api";

interface Customer {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
}

interface Policy {
  id: string;
  tenant_id: string;
  customer_id: string;
  product_name: string;
  insurance_type: string;
  coverage_amount: number;
  term_years: number;
  dependent_name: string | null;
  dependent_dob: string | null;
  created_at: string;
}

const INSURANCE_TYPE_LABELS: Record<string, string> = {
  TERM_LIFE: "Term Life",
  WHOLE_LIFE: "Whole Life",
  ENDOWMENT: "Endowment / Savings Plan",
  CHILD_EDUCATION_MARRIAGE: "Child Education & Marriage Plan",
  SAVINGS: "Savings / Investment Plan",
  SINGLE_PREMIUM: "Single Premium Investment",
  HEALTH_CASH: "Hospital Cash / Health Plan",
};

const INSURANCE_TYPE_COLORS: Record<string, string> = {
  TERM_LIFE: "bg-blue-50 text-blue-700 border-blue-200",
  WHOLE_LIFE: "bg-blue-50 text-blue-700 border-blue-200",
  ENDOWMENT: "bg-amber-50 text-amber-700 border-amber-200",
  CHILD_EDUCATION_MARRIAGE: "bg-blue-50 text-blue-700 border-blue-200",
  SAVINGS: "bg-amber-50 text-amber-700 border-amber-200",
  SINGLE_PREMIUM: "bg-blue-50 text-blue-700 border-blue-200",
  HEALTH_CASH: "bg-rose-50 text-rose-700 border-rose-200",
};

export default function CustomerPlansPage() {
  const params = useParams();
  const router = useRouter();
  const customerId = params.id as string;

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");

  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [editCoverage, setEditCoverage] = useState("");
  const [editTerm, setEditTerm] = useState("");
  const [editDepName, setEditDepName] = useState("");
  const [editDepDob, setEditDepDob] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const [customerResp, policiesResp] = await Promise.all([
        api.get<Customer>(`/tenants/${tenantId}/customers/${customerId}`),
        api.get<Policy[]>(`/tenants/${tenantId}/customers/${customerId}/policies`),
      ]);
      setCustomer(customerResp.data);
      setPolicies(policiesResp.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to load plan details.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePolicy = async (policyId: string) => {
    if (!confirm("Are you sure you want to delete this policy?")) return;
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/customers/${customerId}/policies/${policyId}`);
      // Refresh list
      const res = await api.get<Policy[]>(`/tenants/${tenantId}/customers/${customerId}/policies`);
      setPolicies(res.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete policy.");
    }
  };

  const handleSaveEdit = async (policy: Policy) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setSubmitting(true);
    setError("");
    try {
      const payload: any = {
        coverage_amount: parseFloat(editCoverage),
        term_years: parseInt(editTerm),
      };
      if (policy.insurance_type === "CHILD_EDUCATION_MARRIAGE") {
        payload.dependent_name = editDepName || null;
        payload.dependent_dob = editDepDob || null;
      }
      await api.put(`/tenants/${tenantId}/customers/${customerId}/policies/${policy.id}`, payload);
      setEditingPolicyId(null);
      // Refresh list
      const res = await api.get<Policy[]>(`/tenants/${tenantId}/customers/${customerId}/policies`);
      setPolicies(res.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update policy.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authorized) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] font-sans">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-8 text-center space-y-4">
          <div className="text-red-500 font-bold">Unauthorized Access</div>
          <p className="text-slate-400 text-sm">Administrative privileges required.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">

      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push("/admin/customers")}
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors flex-shrink-0"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-600">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Plan Details {customer ? `— ${customer.name}` : ""}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {customer ? `CNIC ${customer.cnic}` : "Loading customer..."}
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>
      )}

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-2">
          <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
          <span className="text-xs text-slate-400">Loading plan details...</span>
        </div>
      ) : policies.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm py-20 text-center text-slate-400">
          <p className="text-sm">No plans have been evaluated for this customer yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {policies.map((policy, i) => (
            <div key={policy.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">{policy.product_name}</p>
                <div className="flex items-center gap-2">
                  {i === 0 && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-800 text-white">
                      LATEST
                    </span>
                  )}
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${INSURANCE_TYPE_COLORS[policy.insurance_type] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                    {INSURANCE_TYPE_LABELS[policy.insurance_type] ?? policy.insurance_type}
                  </span>
                </div>
              </div>

              {editingPolicyId === policy.id ? (
                <div className="p-5 space-y-4 bg-slate-50 border-t border-slate-100">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Coverage Amount (PKR)</label>
                      <input
                        type="number"
                        value={editCoverage}
                        onChange={(e) => setEditCoverage(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-800 font-medium"
                        placeholder="e.g. 500000"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Term (Years)</label>
                      <input
                        type="number"
                        value={editTerm}
                        onChange={(e) => setEditTerm(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-800 font-medium"
                        placeholder="e.g. 10"
                        required
                      />
                    </div>

                    {policy.insurance_type === "CHILD_EDUCATION_MARRIAGE" && (
                      <>
                        <div>
                          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Dependent Name</label>
                          <input
                            type="text"
                            value={editDepName}
                            onChange={(e) => setEditDepName(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-800 font-medium"
                            placeholder="Dependent Full Name"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Dependent Date of Birth</label>
                          <input
                            type="date"
                            value={editDepDob}
                            onChange={(e) => setEditDepDob(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-800 font-medium"
                          />
                        </div>
                      </>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setEditingPolicyId(null)}
                      className="px-3.5 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handleSaveEdit(policy)}
                      className="px-3.5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors"
                    >
                      {submitting ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="p-5 grid grid-cols-2 gap-y-4 gap-x-6">
                    <div>
                      <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Coverage Amount</span>
                      <span className="text-sm font-bold text-slate-800">PKR {policy.coverage_amount.toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Term</span>
                      <span className="text-sm font-medium text-slate-800">{policy.term_years} years</span>
                    </div>

                    {policy.insurance_type === "CHILD_EDUCATION_MARRIAGE" && (
                      <>
                        <div>
                          <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Dependent Name</span>
                          <span className="text-sm font-medium text-slate-800">{policy.dependent_name || "—"}</span>
                        </div>
                        <div>
                          <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Dependent Date of Birth</span>
                          <span className="text-sm font-medium text-slate-800">{policy.dependent_dob || "—"}</span>
                        </div>
                      </>
                    )}

                    <div className="col-span-2">
                      <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Evaluated On</span>
                      <span className="text-sm font-medium text-slate-600">
                        {new Date(policy.created_at).toLocaleString(undefined, {
                          year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        setEditingPolicyId(policy.id);
                        setEditCoverage(String(policy.coverage_amount));
                        setEditTerm(String(policy.term_years));
                        setEditDepName(policy.dependent_name || "");
                        setEditDepDob(policy.dependent_dob || "");
                      }}
                      className="px-3 py-1.5 text-xs font-bold text-blue-600 hover:bg-blue-50 border border-blue-200 rounded-lg transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeletePolicy(policy.id)}
                      className="px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 border border-red-200 rounded-lg transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
