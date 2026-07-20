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
  free_cover_limit: number | null;
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
  // Optional — the backend defaults these to non-smoker/170cm/70kg when
  // omitted (guaranteed-issue members never need them), but supplying real
  // answers here means an above-Free-Cover-Limit member gets scored by
  // risk-engine's medical node against real data instead of that default.
  is_smoker: string;
  height_cm: string;
  weight_kg: string;
}

interface CensusValidationResult {
  is_valid: boolean;
  total: number;
  duplicate_cnics: string[];
  missing_fields: string[];
  errors: string[];
  computed_free_cover_limit: number | null;
}

interface CensusEmployeeOutcome {
  customer_id: string;
  policy_id: string;
  coverage_amount: number;
  status: string;
  premium_total: number;
  suggested_loading: number | null;
  risk_assessment_id: string | null;
}

interface CensusConfirmResult {
  free_cover_limit: number;
  employees: CensusEmployeeOutcome[];
}

const EMPTY_ROW: CensusRow = {
  cnic: "", name: "", dob: "", gender: "Male", occupation: "", declared_income: "",
  is_smoker: "", height_cm: "", weight_kg: "",
};

const STATUS_STYLE: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Pending: "bg-blue-50 text-blue-700 border-blue-200",
  Review: "bg-amber-50 text-amber-700 border-amber-200",
};

const POLICY_STATUS_STYLE: Record<string, string> = {
  Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  UnderReview: "bg-amber-50 text-amber-700 border-amber-200",
  Declined: "bg-red-50 text-red-700 border-red-200",
  Quoted: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatPKR(n: number): string {
  return `PKR ${Math.round(n).toLocaleString()}`;
}

function formatCNIC(value: string): string {
  const v = value.replace(/\D/g, '');
  let res = '';
  if (v.length > 0) res += v.substring(0, 5);
  if (v.length > 5) res += '-' + v.substring(5, 12);
  if (v.length > 12) res += '-' + v.substring(12, 13);
  return res;
}

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

  // Employee CRUD
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editEmpForm, setEditEmpForm] = useState<Partial<Employee>>({});
  const [empFormLoading, setEmpFormLoading] = useState(false);

  // Census
  const [selectedMpId, setSelectedMpId] = useState("");
  const [censusRows, setCensusRows] = useState<CensusRow[]>([{ ...EMPTY_ROW }]);
  const [censusResult, setCensusResult] = useState<CensusValidationResult | null>(null);
  const [censusLoading, setCensusLoading] = useState(false);
  const [confirmResult, setConfirmResult] = useState<CensusConfirmResult | null>(null);

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
    let finalValue = value;
    if (field === "cnic") {
      finalValue = formatCNIC(value);
    }
    setCensusRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: finalValue } : row)));
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
      ...(r.is_smoker !== "" ? { is_smoker: r.is_smoker === "true" } : {}),
      ...(r.height_cm !== "" ? { height_cm: parseFloat(r.height_cm) || undefined } : {}),
      ...(r.weight_kg !== "" ? { weight_kg: parseFloat(r.weight_kg) || undefined } : {}),
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
      const resp = await api.post<CensusConfirmResult>(
        `/tenants/${tenantId}/organizations/${orgId}/master-policies/${selectedMpId}/census/confirm`,
        { employees: buildEmployeesPayload() }
      );
      const aboveFcl = resp.data.employees.filter((e) => e.coverage_amount > resp.data.free_cover_limit).length;
      setSuccess(
        `${resp.data.employees.length} employee(s) enrolled — Free Cover Limit ${formatPKR(resp.data.free_cover_limit)}` +
        (aboveFcl > 0 ? `, ${aboveFcl} above FCL routed to underwriting review.` : ", all guaranteed-issue.")
      );
      setConfirmResult(resp.data);
      setCensusRows([{ ...EMPTY_ROW }]);
      setCensusResult(null);
      fetchAll();
    } catch (err: any) {
      let detail = err.response?.data?.detail;
      if (typeof detail === "string") {
        try { detail = JSON.parse(detail); } catch (e) {}
      }
      if (err.response?.status === 422 && typeof detail === "object" && detail !== null && "is_valid" in detail) {
        setCensusResult(detail);
      } else {
        setError(typeof detail === "object" ? JSON.stringify(detail) : detail ?? err.message ?? "Failed to confirm census.");
      }
    } finally {
      setCensusLoading(false);
    }
  };

  const handleEditEmployee = (emp: Employee) => {
    setEditingEmployee(emp);
    setEditEmpForm({ ...emp });
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmployee) return;
    setEmpFormLoading(true);
    setError("");
    setSuccess("");
    try {
      const names = (editEmpForm.name || "").trim().split(" ");
      const firstName = names[0] || "";
      const lastName = names.slice(1).join(" ");
      const payload = {
        cnic: editEmpForm.cnic,
        first_name: firstName,
        last_name: lastName || undefined,
        date_of_birth: editEmpForm.dob,
        gender: editEmpForm.gender,
        occupation: editEmpForm.occupation,
        declared_income: editEmpForm.declared_income,
      };
      await api.put(`/tenants/${tenantId}/customers/${editingEmployee.id}`, payload);
      setSuccess("Employee updated successfully.");
      setEditingEmployee(null);
      fetchAll();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update employee.");
    } finally {
      setEmpFormLoading(false);
    }
  };

  const handleDeleteEmployee = async (empId: string, empName: string) => {
    if (!confirm(`Are you sure you want to delete ${empName}? This will also delete their policy, quotes, and AI assessments.`)) return;
    setError("");
    setSuccess("");
    try {
      await api.delete(`/tenants/${tenantId}/organizations/${orgId}/employees/${empId}`);
      setSuccess(`Employee ${empName} deleted successfully.`);
      fetchAll();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete employee.");
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

      {error && (() => {
        try {
          const parsed = JSON.parse(error);
          if (parsed && typeof parsed === "object") {
            const missing = parsed.missing_fields || [];
            const errs = parsed.errors || [];
            const dups = parsed.duplicate_cnics || [];
            
            // Handle Pydantic validation array fallback
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].loc) {
              return (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium space-y-1">
                  <p className="font-bold mb-2">Invalid Data Format:</p>
                  {parsed.map((e: any, i: number) => (
                    <p key={i}>• {e.loc.join(" -> ")}: {e.msg}</p>
                  ))}
                </div>
              );
            }
            
            if (missing.length > 0 || errs.length > 0 || dups.length > 0) {
              return (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium space-y-1">
                  <p className="font-bold mb-2">Please fix the following issues before enrolling:</p>
                  {missing.map((m: string, i: number) => <p key={`m-${i}`}>• {m}</p>)}
                  {errs.map((e: string, i: number) => <p key={`e-${i}`}>• {e}</p>)}
                  {dups.length > 0 && <p>• Duplicate CNICs: {dups.join(", ")}</p>}
                </div>
              );
            }
          }
        } catch (e) {}
        return <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>;
      })()}
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
                      <th className="px-5 py-3 text-left">Free Cover Limit</th>
                      <th className="px-5 py-3 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {masterPolicies.map((mp) => (
                      <tr key={mp.id} className={mp.id === selectedMpId ? "bg-blue-50/40" : ""}>
                        <td className="px-5 py-3 font-semibold text-slate-800">{mp.sum_assured_multiple}× monthly basic salary</td>
                        <td className="px-5 py-3 text-slate-600">{mp.term_years} years</td>
                        <td className="px-5 py-3 text-slate-600">{mp.effective_date}</td>
                        <td className="px-5 py-3 text-slate-600">
                          {mp.free_cover_limit != null ? formatPKR(mp.free_cover_limit) : "— (set on first census confirm)"}
                        </td>
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
                <p className="text-xs text-slate-400">
                  Minimum group size: 10 employees. Coverage per employee = (annual income ÷ 12) × the master policy's sum-assured multiple.
                  Employees at or under the computed Free Cover Limit are guaranteed-issue; above it, they're routed through AI underwriting —
                  Smoker/Height/Weight are optional but improve that scoring beyond the guaranteed-issue defaults (non-smoker, 170cm, 70kg) if left blank.
                </p>

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
                        <th className="pb-2 pr-2">Smoker?</th>
                        <th className="pb-2 pr-2">Height (cm)</th>
                        <th className="pb-2 pr-2">Weight (kg)</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {censusRows.map((row, i) => (
                        <tr key={i}>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.cnic} onChange={(e) => updateCensusRow(i, "cnic", e.target.value)} placeholder="35201-1234567-1"
                              className={`w-32 bg-slate-50 border rounded px-2 py-1 ${row.cnic && !/^\d{5}-\d{7}-\d$/.test(row.cnic) ? 'border-red-400 focus:outline-red-400' : 'border-slate-200'}`} />
                            {row.cnic && !/^\d{5}-\d{7}-\d$/.test(row.cnic) && (
                              <p className="text-[10px] text-red-500 mt-0.5 leading-tight">Invalid format</p>
                            )}
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.name} onChange={(e) => updateCensusRow(i, "name", e.target.value)} placeholder="Full name"
                              className="w-36 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="date" value={row.dob} onChange={(e) => updateCensusRow(i, "dob", e.target.value)}
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <select value={row.gender} onChange={(e) => updateCensusRow(i, "gender", e.target.value)}
                              className="w-24 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="Male">Male</option>
                              <option value="Female">Female</option>
                              <option value="Other">Other</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.occupation} onChange={(e) => updateCensusRow(i, "occupation", e.target.value)} placeholder="Job title"
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="number" value={row.declared_income} onChange={(e) => updateCensusRow(i, "declared_income", e.target.value)} placeholder="1200000"
                              className="w-28 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <select value={row.is_smoker} onChange={(e) => updateCensusRow(i, "is_smoker", e.target.value)}
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="">—</option>
                              <option value="false">No</option>
                              <option value="true">Yes</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="number" value={row.height_cm} onChange={(e) => updateCensusRow(i, "height_cm", e.target.value)} placeholder="170"
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="number" value={row.weight_kg} onChange={(e) => updateCensusRow(i, "weight_kg", e.target.value)} placeholder="70"
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pb-2 align-top">
                            <button type="button" onClick={() => removeCensusRow(i)} className="text-red-500 hover:text-red-700 font-bold px-1 mt-1">✕</button>
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
                    {censusResult.is_valid && censusResult.computed_free_cover_limit != null && (
                      <p>
                        Computed Free Cover Limit: <span className="font-semibold">{formatPKR(censusResult.computed_free_cover_limit)}</span> —
                        employees whose coverage exceeds this are routed to AI underwriting review instead of guaranteed issue.
                      </p>
                    )}
                    {censusResult.errors.map((e, i) => <p key={i}>{e}</p>)}
                    {censusResult.duplicate_cnics.length > 0 && <p>Duplicate CNICs: {censusResult.duplicate_cnics.join(", ")}</p>}
                    {censusResult.missing_fields.map((m, i) => <p key={i}>{m}</p>)}
                  </div>
                )}

                <div className="flex gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button" onClick={handleConfirmCensus} disabled={censusLoading}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/40 rounded-lg transition-colors"
                  >
                    Confirm &amp; Enroll
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Last Enrollment Result — per-employee outcome from the most recent confirm */}
          {confirmResult && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">Last Enrollment Result</p>
                <span className="text-xs text-slate-500 font-medium">
                  Free Cover Limit: {formatPKR(confirmResult.free_cover_limit)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">Coverage</th>
                      <th className="px-5 py-3 text-left">Outcome</th>
                      <th className="px-5 py-3 text-right">Premium (Annual)</th>
                      <th className="px-5 py-3 text-right">Suggested Loading</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {confirmResult.employees.map((emp) => (
                      <tr key={emp.policy_id}>
                        <td className="px-5 py-3 text-slate-700">{formatPKR(emp.coverage_amount)}</td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${POLICY_STATUS_STYLE[emp.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                            {emp.status}
                          </span>
                          {emp.risk_assessment_id && (
                            <span className="ml-2 text-[11px] text-slate-400">AI-assessed</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold text-slate-700">{formatPKR(emp.premium_total)}</td>
                        <td className="px-5 py-3 text-right text-slate-500">
                          {emp.suggested_loading != null ? `+${emp.suggested_loading}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                      <th className="px-5 py-3 text-right">Actions</th>
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
                        <td className="px-5 py-3 text-right space-x-3">
                          <button onClick={() => handleEditEmployee(emp)} className="text-xs font-bold text-emerald-600 hover:text-emerald-800 transition-colors">Edit</button>
                          <button onClick={() => handleDeleteEmployee(emp.id, emp.name)} className="text-xs font-bold text-red-600 hover:text-red-800 transition-colors">Delete</button>
                        </td>
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

      {/* ── EDIT EMPLOYEE MODAL ── */}
      {editingEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Edit Employee</h3>
              <button onClick={() => setEditingEmployee(null)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <form onSubmit={handleSaveEmployee} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">CNIC *</label>
                <input
                  type="text" required value={editEmpForm.cnic || ""} onChange={(e) => setEditEmpForm({...editEmpForm, cnic: formatCNIC(e.target.value)})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Full Name *</label>
                <input
                  type="text" required value={editEmpForm.name || ""} onChange={(e) => setEditEmpForm({...editEmpForm, name: e.target.value})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">DOB *</label>
                  <input
                    type="date" required value={editEmpForm.dob || ""} onChange={(e) => setEditEmpForm({...editEmpForm, dob: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Gender *</label>
                  <select
                    required value={editEmpForm.gender || "Male"} onChange={(e) => setEditEmpForm({...editEmpForm, gender: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Occupation *</label>
                  <input
                    type="text" required value={editEmpForm.occupation || ""} onChange={(e) => setEditEmpForm({...editEmpForm, occupation: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Annual Income *</label>
                  <input
                    type="number" required value={editEmpForm.declared_income || ""} onChange={(e) => setEditEmpForm({...editEmpForm, declared_income: parseFloat(e.target.value) || 0})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setEditingEmployee(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={empFormLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                  {empFormLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
