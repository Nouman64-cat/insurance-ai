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
  WHOLE_LIFE: "bg-violet-50 text-violet-700 border-violet-200",
  ENDOWMENT: "bg-amber-50 text-amber-700 border-amber-200",
  CHILD_EDUCATION_MARRIAGE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  SAVINGS: "bg-amber-50 text-amber-700 border-amber-200",
  SINGLE_PREMIUM: "bg-violet-50 text-violet-700 border-violet-200",
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
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
