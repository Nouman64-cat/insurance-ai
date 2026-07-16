"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import api from "@/app/services/api";

interface Organization {
  id: string;
  name: string;
  registration_number: string | null;
  industry: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

interface MasterPolicy {
  id: string;
  organization_id: string;
  insurance_type: string;
  sum_assured_multiple: number;
  term_years: number;
  effective_date: string;
  status: string;
  created_at: string;
}

interface Employee {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
}

interface CensusRow {
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: string;
}

interface CensusValidationResult {
  is_valid: boolean;
  total: number;
  duplicate_cnics: string[];
  missing_fields: string[];
  errors: string[];
}

const EMPTY_ROW: CensusRow = { cnic: "", name: "", dob: "", gender: "Male", occupation: "", declared_income: "" };

const STATUS_STYLE: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Pending: "bg-blue-50 text-blue-700 border-blue-200",
  Review: "bg-amber-50 text-amber-700 border-amber-200",
};

export default function OrganizationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.id as string;
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [masterPolicies, setMasterPolicies] = useState<MasterPolicy[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Create master policy form
  const [showCreateMP, setShowCreateMP] = useState(false);
  const [sumAssuredMultiple, setSumAssuredMultiple] = useState("24");
  const [termYears, setTermYears] = useState("10");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [mpFormLoading, setMpFormLoading] = useState(false);

  // Census
  const [selectedMpId, setSelectedMpId] = useState("");
  const [censusRows, setCensusRows] = useState<CensusRow[]>([{ ...EMPTY_ROW }]);
  const [censusResult, setCensusResult] = useState<CensusValidationResult | null>(null);
  const [censusLoading, setCensusLoading] = useState(false);

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const fetchAll = async () => {
    setLoading(true);
    setError("");
    try {
      const [orgResp, mpResp, empResp] = await Promise.all([
        api.get<Organization>(`/tenants/${tenantId}/organizations/${orgId}`),
        api.get<MasterPolicy[]>(`/tenants/${tenantId}/organizations/${orgId}/master-policies`),
        api.get<Employee[]>(`/tenants/${tenantId}/organizations/${orgId}/employees`),
      ]);
      setOrganization(orgResp.data);
      setMasterPolicies(mpResp.data);
      setEmployees(empResp.data);
      if (mpResp.data.length > 0) setSelectedMpId(mpResp.data[0].id);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to load organization.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMasterPolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setMpFormLoading(true);
    try {
      const resp = await api.post<MasterPolicy>(`/tenants/${tenantId}/organizations/${orgId}/master-policies`, {
        sum_assured_multiple: parseFloat(sumAssuredMultiple) || 0,
        term_years: parseInt(termYears) || 0,
        effective_date: effectiveDate,
      });
      setSuccess("Master policy created. Now add the employee census below.");
      setShowCreateMP(false);
      setMasterPolicies((prev) => [resp.data, ...prev]);
      setSelectedMpId(resp.data.id);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.join(", ") : detail ?? err.message ?? "Failed to create master policy.");
    } finally {
      setMpFormLoading(false);
    }
  };

  const updateCensusRow = (index: number, field: keyof CensusRow, value: string) => {
    setCensusRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const addCensusRow = () => setCensusRows((prev) => [...prev, { ...EMPTY_ROW }]);
  const removeCensusRow = (index: number) => setCensusRows((prev) => prev.filter((_, i) => i !== index));

  const buildEmployeesPayload = () =>
    censusRows.map((r) => ({
      cnic: r.cnic,
      name: r.name,
      dob: r.dob,
      gender: r.gender,
      occupation: r.occupation,
      declared_income: parseFloat(r.declared_income) || 0,
    }));

  const handleValidateCensus = async () => {
    setError("");
    setSuccess("");
    setCensusResult(null);
    setCensusLoading(true);
    try {
      const resp = await api.post<CensusValidationResult>(
        `/tenants/${tenantId}/organizations/${orgId}/master-policies/${selectedMpId}/census/validate`,
        { employees: buildEmployeesPayload() }
      );
      setCensusResult(resp.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to validate census.");
    } finally {
      setCensusLoading(false);
    }
  };

  const handleConfirmCensus = async () => {
    setError("");
    setSuccess("");
    setCensusLoading(true);
    try {
      const resp = await api.post(
        `/tenants/${tenantId}/organizations/${orgId}/master-policies/${selectedMpId}/census/confirm`,
        { employees: buildEmployeesPayload() }
      );
      setSuccess(`${resp.data.created_count} employee(s) enrolled successfully.`);
      setCensusRows([{ ...EMPTY_ROW }]);
      setCensusResult(null);
      fetchAll();
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === "object" ? JSON.stringify(detail) : detail ?? err.message ?? "Failed to confirm census.");
    } finally {
      setCensusLoading(false);
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
          onClick={() => router.push("/admin/organizations")}
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors flex-shrink-0"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-600">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{organization?.name ?? "Loading..."}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {organization?.industry ?? "—"} {organization?.contact_person ? `· ${organization.contact_person}` : ""}
          </p>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-2">
          <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
          <span className="text-xs text-slate-400">Loading...</span>
        </div>
      ) : (
        <>
          {/* Master Policies */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">Master Policies (Group Life)</p>
              <button
                onClick={() => setShowCreateMP(true)}
                className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
              >
                + New Master Policy
              </button>
            </div>

            {masterPolicies.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">
                No master policy yet — create one to start enrolling employees.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">Sum Assured Formula</th>
                      <th className="px-5 py-3 text-left">Term</th>
                      <th className="px-5 py-3 text-left">Effective Date</th>
                      <th className="px-5 py-3 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {masterPolicies.map((mp) => (
                      <tr key={mp.id} className={mp.id === selectedMpId ? "bg-blue-50/40" : ""}>
                        <td className="px-5 py-3 font-semibold text-slate-800">{mp.sum_assured_multiple}× monthly basic salary</td>
                        <td className="px-5 py-3 text-slate-600">{mp.term_years} years</td>
                        <td className="px-5 py-3 text-slate-600">{mp.effective_date}</td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_STYLE[mp.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                            {mp.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Employee Census */}
          {masterPolicies.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">Add Employee Census</p>
                <select
                  value={selectedMpId}
                  onChange={(e) => setSelectedMpId(e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white"
                >
                  {masterPolicies.map((mp) => (
                    <option key={mp.id} value={mp.id}>
                      {mp.sum_assured_multiple}× · {mp.effective_date} ({mp.status})
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-5 space-y-3">
                <p className="text-xs text-slate-400">Minimum group size: 10 employees. Coverage per employee = (annual income ÷ 12) × the master policy's sum-assured multiple.</p>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 uppercase tracking-wider">
                        <th className="pb-2 pr-2">CNIC</th>
                        <th className="pb-2 pr-2">Full Name</th>
                        <th className="pb-2 pr-2">DOB</th>
                        <th className="pb-2 pr-2">Gender</th>
                        <th className="pb-2 pr-2">Occupation</th>
                        <th className="pb-2 pr-2">Annual Income (PKR)</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {censusRows.map((row, i) => (
                        <tr key={i}>
                          <td className="pr-2 pb-2">
                            <input value={row.cnic} onChange={(e) => updateCensusRow(i, "cnic", e.target.value)} placeholder="35201-1234567-1"
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2">
                            <input value={row.name} onChange={(e) => updateCensusRow(i, "name", e.target.value)} placeholder="Full name"
                              className="w-36 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2">
                            <input type="date" value={row.dob} onChange={(e) => updateCensusRow(i, "dob", e.target.value)}
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2">
                            <select value={row.gender} onChange={(e) => updateCensusRow(i, "gender", e.target.value)}
                              className="w-24 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="Male">Male</option>
                              <option value="Female">Female</option>
                              <option value="Other">Other</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2">
                            <input value={row.occupation} onChange={(e) => updateCensusRow(i, "occupation", e.target.value)} placeholder="Job title"
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2">
                            <input type="number" value={row.declared_income} onChange={(e) => updateCensusRow(i, "declared_income", e.target.value)} placeholder="1200000"
                              className="w-28 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pb-2">
                            <button type="button" onClick={() => removeCensusRow(i)} className="text-red-500 hover:text-red-700 font-bold px-1">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button type="button" onClick={addCensusRow} className="text-xs font-semibold text-blue-600 hover:underline">
                  + Add Row
                </button>

                {censusResult && (
                  <div className={`rounded-lg border p-3 text-xs space-y-1 ${
                    censusResult.is_valid ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"
                  }`}>
                    <p className="font-bold">
                      {censusResult.is_valid ? "✓ Census Valid" : "⚠ Census has issues"} — {censusResult.total} row(s)
                    </p>
                    {censusResult.errors.map((e, i) => <p key={i}>{e}</p>)}
                    {censusResult.duplicate_cnics.length > 0 && <p>Duplicate CNICs: {censusResult.duplicate_cnics.join(", ")}</p>}
                    {censusResult.missing_fields.map((m, i) => <p key={i}>{m}</p>)}
                  </div>
                )}

                <div className="flex gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button" onClick={handleValidateCensus} disabled={censusLoading}
                    className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                  >
                    Validate Census
                  </button>
                  <button
                    type="button" onClick={handleConfirmCensus} disabled={censusLoading || !censusResult?.is_valid}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/40 rounded-lg transition-colors"
                  >
                    Confirm &amp; Enroll
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Employee Roster */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">Employee Roster</p>
              <span className="text-xs text-slate-400 font-medium">Total: {employees.length}</span>
            </div>
            {employees.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">No employees enrolled yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">CNIC</th>
                      <th className="px-5 py-3 text-left">Full Name</th>
                      <th className="px-5 py-3 text-left">Age / Gender</th>
                      <th className="px-5 py-3 text-left">Occupation</th>
                      <th className="px-5 py-3 text-right">Income</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {employees.map((emp) => (
                      <tr key={emp.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-3 font-medium text-slate-700">{emp.cnic}</td>
                        <td className="px-5 py-3 font-semibold text-slate-800">{emp.name}</td>
                        <td className="px-5 py-3 text-slate-600">
                          {new Date().getFullYear() - new Date(emp.dob).getFullYear()} yrs · {emp.gender}
                        </td>
                        <td className="px-5 py-3 text-slate-600">{emp.occupation}</td>
                        <td className="px-5 py-3 text-right font-semibold text-slate-700">PKR {emp.declared_income.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── CREATE MASTER POLICY MODAL ── */}
      {showCreateMP && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">New Master Policy</h3>
              <button onClick={() => setShowCreateMP(false)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <form onSubmit={handleCreateMasterPolicy} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Sum Assured Multiple (× monthly basic salary) *</label>
                <input
                  type="number" step="0.1" required value={sumAssuredMultiple} onChange={(e) => setSumAssuredMultiple(e.target.value)}
                  placeholder="24"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
                <p className="text-[11px] text-slate-400">Must be between 12x and 36x.</p>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Term (Years) *</label>
                <input type="number" required value={termYears} onChange={(e) => setTermYears(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Effective Date *</label>
                <input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setShowCreateMP(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={mpFormLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                  {mpFormLoading ? "Creating..." : "Create Master Policy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
