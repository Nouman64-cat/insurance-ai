"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import api from "@/app/services/api";
import { listInsurancePlans, InsurancePlan } from "@/app/services/insurancePlans";

interface FamilyGroup {
  id: string;
  name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  household_declared_income: number | null;
  primary_member_customer_id: string | null;
}

interface FamilyPolicy {
  id: string;
  family_group_id: string;
  plan_type: "Floater" | "LifeBundle";
  insurance_type: string | null;
  total_sum_insured: number | null;
  discount_percentage: number | null;
  term_years: number;
  effective_date: string;
  status: string;
  created_at: string;
}

interface FamilyMemberRow {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
  relationship: string | null;
}

interface MemberFormRow {
  cnic: string; name: string; dob: string; gender: string; occupation: string;
  declared_income: string; relationship: string;
  is_smoker: string; height_cm: string; weight_kg: string;
  coverage_amount: string; plan_code: string;
}

interface FamilyValidationResult {
  is_valid: boolean;
  total: number;
  duplicate_cnics: string[];
  missing_fields: string[];
  errors: string[];
}

interface FamilyMemberOutcome {
  customer_id: string;
  policy_id: string;
  relationship: string;
  status: string;
  premium_total: number | null;
  suggested_loading: number | null;
  risk_assessment_id: string | null;
}

interface FamilyConfirmResult {
  family_policy_id: string;
  total_sum_insured: number | null;
  members: FamilyMemberOutcome[];
}

const EMPTY_ROW: MemberFormRow = {
  cnic: "", name: "", dob: "", gender: "Male", occupation: "", declared_income: "", relationship: "Spouse",
  is_smoker: "", height_cm: "", weight_kg: "", coverage_amount: "", plan_code: "",
};

const FAMILY_POLICY_STATUS_STYLE: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Pending: "bg-blue-50 text-blue-700 border-blue-200",
  Review: "bg-amber-50 text-amber-700 border-amber-200",
};

const OUTCOME_STATUS_STYLE: Record<string, string> = {
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

export default function FamilyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const familyId = params.id as string;
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  const [family, setFamily] = useState<FamilyGroup | null>(null);
  const [familyPolicies, setFamilyPolicies] = useState<FamilyPolicy[]>([]);
  const [members, setMembers] = useState<FamilyMemberRow[]>([]);
  const [lifePlans, setLifePlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Create policy forms
  const [showCreateFloater, setShowCreateFloater] = useState(false);
  const [totalSumInsured, setTotalSumInsured] = useState("5000000");
  const [floaterTermYears, setFloaterTermYears] = useState("1");
  const [floaterEffectiveDate, setFloaterEffectiveDate] = useState("");
  const [floaterFormLoading, setFloaterFormLoading] = useState(false);

  const [showCreateLifeBundle, setShowCreateLifeBundle] = useState(false);
  const [lifeBundleTermYears, setLifeBundleTermYears] = useState("10");
  const [lifeBundleEffectiveDate, setLifeBundleEffectiveDate] = useState("");
  const [discountPercentage, setDiscountPercentage] = useState("10");
  const [lifeBundleFormLoading, setLifeBundleFormLoading] = useState(false);

  // Edit Member
  const [editingMember, setEditingMember] = useState<FamilyMemberRow | null>(null);
  const [editMemberForm, setEditMemberForm] = useState<Partial<FamilyMemberRow>>({});
  const [editMemberFormLoading, setEditMemberFormLoading] = useState(false);

  // Member entry
  const [selectedPolicyId, setSelectedPolicyId] = useState("");
  const [memberRows, setMemberRows] = useState<MemberFormRow[]>([{ ...EMPTY_ROW, relationship: "Self" }]);
  const [validationResult, setValidationResult] = useState<FamilyValidationResult | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);
  const [confirmResult, setConfirmResult] = useState<FamilyConfirmResult | null>(null);

  const selectedPolicy = familyPolicies.find((p) => p.id === selectedPolicyId) ?? null;
  const isLifeBundle = selectedPolicy?.plan_type === "LifeBundle";

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId]);

  const fetchAll = async () => {
    setLoading(true);
    setError("");
    try {
      const [famResp, fpResp, memResp, plansResp] = await Promise.all([
        api.get<FamilyGroup>(`/tenants/${tenantId}/families/${familyId}`),
        api.get<FamilyPolicy[]>(`/tenants/${tenantId}/families/${familyId}/family-policies`),
        api.get<FamilyMemberRow[]>(`/tenants/${tenantId}/families/${familyId}/members`),
        listInsurancePlans(tenantId),
      ]);
      setFamily(famResp.data);
      setFamilyPolicies(fpResp.data);
      setMembers(memResp.data);
      setLifePlans(plansResp.filter((p) => (p.insurance_type === "TERM_LIFE" || p.insurance_type === "WHOLE_LIFE") && p.is_active));
      if (fpResp.data.length > 0 && !selectedPolicyId) setSelectedPolicyId(fpResp.data[0].id);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to load family.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFloater = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFloaterFormLoading(true);
    try {
      const resp = await api.post<FamilyPolicy>(`/tenants/${tenantId}/families/${familyId}/floater-policies`, {
        total_sum_insured: parseFloat(totalSumInsured) || 0,
        term_years: parseInt(floaterTermYears) || 0,
        effective_date: floaterEffectiveDate,
      });
      setSuccess("Floater policy created. Add family members below.");
      setShowCreateFloater(false);
      setFamilyPolicies((prev) => [resp.data, ...prev]);
      setSelectedPolicyId(resp.data.id);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.join(", ") : detail ?? err.message ?? "Failed to create floater policy.");
    } finally {
      setFloaterFormLoading(false);
    }
  };

  const handleCreateLifeBundle = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLifeBundleFormLoading(true);
    try {
      const resp = await api.post<FamilyPolicy>(`/tenants/${tenantId}/families/${familyId}/life-bundle-policies`, {
        term_years: parseInt(lifeBundleTermYears) || 0,
        effective_date: lifeBundleEffectiveDate,
        discount_percentage: parseFloat(discountPercentage) || 0,
      });
      setSuccess("Life bundle policy created. Add family members below.");
      setShowCreateLifeBundle(false);
      setFamilyPolicies((prev) => [resp.data, ...prev]);
      setSelectedPolicyId(resp.data.id);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.join(", ") : detail ?? err.message ?? "Failed to create life bundle policy.");
    } finally {
      setLifeBundleFormLoading(false);
    }
  };

  const updateMemberRow = (index: number, field: keyof MemberFormRow, value: string) => {
    let finalValue = value;
    if (field === "cnic") {
      finalValue = formatCNIC(value);
    }
    setMemberRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: finalValue } : row)));
  };

  const addMemberRow = () => setMemberRows((prev) => [...prev, { ...EMPTY_ROW }]);
  const removeMemberRow = (index: number) => setMemberRows((prev) => prev.filter((_, i) => i !== index));

  const buildMembersPayload = () =>
    memberRows.map((r) => ({
      cnic: r.cnic,
      name: r.name,
      dob: r.dob,
      gender: r.gender,
      occupation: r.occupation,
      declared_income: parseFloat(r.declared_income) || 0,
      relationship: r.relationship,
      ...(r.is_smoker !== "" ? { is_smoker: r.is_smoker === "true" } : {}),
      ...(r.height_cm !== "" ? { height_cm: parseFloat(r.height_cm) || undefined } : {}),
      ...(r.weight_kg !== "" ? { weight_kg: parseFloat(r.weight_kg) || undefined } : {}),
      ...(isLifeBundle ? { coverage_amount: parseFloat(r.coverage_amount) || 0, plan_code: r.plan_code } : {}),
    }));

  const policyPathSegment = isLifeBundle ? "life-bundle-policies" : "floater-policies";

  const handleValidateMembers = async () => {
    if (!selectedPolicy) return;
    setError("");
    setSuccess("");
    setValidationResult(null);
    setMemberLoading(true);
    try {
      const resp = await api.post<FamilyValidationResult>(
        `/tenants/${tenantId}/families/${familyId}/${policyPathSegment}/${selectedPolicy.id}/members/validate`,
        { members: buildMembersPayload() }
      );
      setValidationResult(resp.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to validate members.");
    } finally {
      setMemberLoading(false);
    }
  };

  const handleConfirmMembers = async () => {
    if (!selectedPolicy) return;
    setError("");
    setSuccess("");
    setMemberLoading(true);
    try {
      const resp = await api.post<FamilyConfirmResult>(
        `/tenants/${tenantId}/families/${familyId}/${policyPathSegment}/${selectedPolicy.id}/members/confirm`,
        { members: buildMembersPayload() }
      );
      setSuccess(
        `${resp.data.members.length} member(s) enrolled on the ${isLifeBundle ? "life bundle" : "floater"} policy.`
      );
      setConfirmResult(resp.data);
      setMemberRows([{ ...EMPTY_ROW }]);
      setValidationResult(null);
      fetchAll();
    } catch (err: any) {
      let detail = err.response?.data?.detail;
      if (typeof detail === "string") {
        try { detail = JSON.parse(detail); } catch (e) {}
      }
      if (err.response?.status === 422 && typeof detail === "object" && detail !== null && "is_valid" in detail) {
        setValidationResult(detail);
      } else {
        setError(typeof detail === "object" ? JSON.stringify(detail) : detail ?? err.message ?? "Failed to confirm members.");
      }
    } finally {
      setMemberLoading(false);
    }
  };

  const handleEditMember = (member: FamilyMemberRow) => {
    setEditingMember(member);
    setEditMemberForm({ ...member });
  };

  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMember) return;
    setEditMemberFormLoading(true);
    setError("");
    setSuccess("");
    try {
      const names = (editMemberForm.name || "").trim().split(" ");
      const firstName = names[0] || "";
      const lastName = names.slice(1).join(" ");
      const payload = {
        cnic: editMemberForm.cnic,
        first_name: firstName,
        last_name: lastName || undefined,
        date_of_birth: editMemberForm.dob,
        gender: editMemberForm.gender,
        occupation: editMemberForm.occupation,
        declared_income: editMemberForm.declared_income,
      };
      await api.put(`/tenants/${tenantId}/customers/${editingMember.id}`, payload);
      setSuccess("Family member updated successfully.");
      setEditingMember(null);
      fetchAll();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update member.");
    } finally {
      setEditMemberFormLoading(false);
    }
  };

  const handleDeleteMember = async (memberId: string, memberName: string) => {
    if (!confirm(`Are you sure you want to delete ${memberName}? This will also delete their policy, quotes, and AI assessments.`)) return;
    setError("");
    setSuccess("");
    try {
      await api.delete(`/tenants/${tenantId}/families/${familyId}/members/${memberId}`);
      setSuccess(`Family member ${memberName} deleted successfully.`);
      fetchAll();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete member.");
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
          onClick={() => router.push("/admin/families")}
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors flex-shrink-0"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-slate-600">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{family?.name ?? "Loading..."}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {family?.contact_person ?? "—"}
            {family?.household_declared_income != null ? ` · Household income ${formatPKR(family.household_declared_income)}` : ""}
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
          {/* Family Policies */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-slate-700">Family Policies</p>
              <div className="flex gap-2">
                <button onClick={() => setShowCreateFloater(true)} className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors">
                  + New Floater Policy
                </button>
                <span className="text-slate-300">|</span>
                <button onClick={() => setShowCreateLifeBundle(true)} className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors">
                  + New Life Bundle Policy
                </button>
              </div>
            </div>

            {familyPolicies.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">
                No family policy yet — create a floater or life bundle to start enrolling members.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">Type</th>
                      <th className="px-5 py-3 text-left">Coverage / Discount</th>
                      <th className="px-5 py-3 text-left">Term</th>
                      <th className="px-5 py-3 text-left">Effective Date</th>
                      <th className="px-5 py-3 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {familyPolicies.map((fp) => (
                      <tr key={fp.id} className={fp.id === selectedPolicyId ? "bg-blue-50/40" : ""}>
                        <td className="px-5 py-3 font-semibold text-slate-800">
                          {fp.plan_type === "Floater" ? "Health Floater" : "Life Bundle"}
                        </td>
                        <td className="px-5 py-3 text-slate-600">
                          {fp.plan_type === "Floater"
                            ? fp.total_sum_insured != null ? formatPKR(fp.total_sum_insured) : "—"
                            : `${fp.discount_percentage ?? 0}% discount`}
                        </td>
                        <td className="px-5 py-3 text-slate-600">{fp.term_years} years</td>
                        <td className="px-5 py-3 text-slate-600">{fp.effective_date}</td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${FAMILY_POLICY_STATUS_STYLE[fp.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                            {fp.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Member entry */}
          {familyPolicies.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">Add Family Members</p>
                <select
                  value={selectedPolicyId}
                  onChange={(e) => { setSelectedPolicyId(e.target.value); setValidationResult(null); }}
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white"
                >
                  {familyPolicies.map((fp) => (
                    <option key={fp.id} value={fp.id}>
                      {fp.plan_type === "Floater" ? "Health Floater" : "Life Bundle"} · {fp.effective_date} ({fp.status})
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-5 space-y-3">
                <p className="text-xs text-slate-400">
                  Family size: 2-8 members, exactly one must be &quot;Self&quot;. A member already enrolled on this family&apos;s
                  other policy can be reused here — just reuse their CNIC. {isLifeBundle
                    ? "Each life-bundle member picks their own coverage amount and plan; the discount above is applied to their rate."
                    : "Floater members share one pool (set on the policy) — every member is individually AI-risk-scored, no guaranteed issue."}
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 uppercase tracking-wider">
                        <th className="pb-2 pr-2">CNIC</th>
                        <th className="pb-2 pr-2">Full Name</th>
                        <th className="pb-2 pr-2">DOB</th>
                        <th className="pb-2 pr-2">Gender</th>
                        <th className="pb-2 pr-2">Relationship</th>
                        <th className="pb-2 pr-2">Occupation</th>
                        <th className="pb-2 pr-2">Annual Income (PKR)</th>
                        {isLifeBundle && <th className="pb-2 pr-2">Coverage (PKR)</th>}
                        {isLifeBundle && <th className="pb-2 pr-2">Plan</th>}
                        <th className="pb-2 pr-2">Smoker?</th>
                        <th className="pb-2 pr-2">Height (cm)</th>
                        <th className="pb-2 pr-2">Weight (kg)</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {memberRows.map((row, i) => (
                        <tr key={i}>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.cnic} onChange={(e) => updateMemberRow(i, "cnic", e.target.value)} placeholder="61101-1234567-1"
                              className={`w-32 bg-slate-50 border rounded px-2 py-1 ${row.cnic && !/^\d{5}-\d{7}-\d$/.test(row.cnic) ? 'border-red-400 focus:outline-red-400' : 'border-slate-200'}`} />
                            {row.cnic && !/^\d{5}-\d{7}-\d$/.test(row.cnic) && (
                              <p className="text-[10px] text-red-500 mt-0.5 leading-tight">Invalid format</p>
                            )}
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.name} onChange={(e) => updateMemberRow(i, "name", e.target.value)} placeholder="Full name"
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="date" value={row.dob} onChange={(e) => updateMemberRow(i, "dob", e.target.value)}
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <select value={row.gender} onChange={(e) => updateMemberRow(i, "gender", e.target.value)}
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="Male">Male</option>
                              <option value="Female">Female</option>
                              <option value="Other">Other</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <select value={row.relationship} onChange={(e) => updateMemberRow(i, "relationship", e.target.value)}
                              className="w-24 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="Self">Self</option>
                              <option value="Spouse">Spouse</option>
                              <option value="Child">Child</option>
                              <option value="Parent">Parent</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.occupation} onChange={(e) => updateMemberRow(i, "occupation", e.target.value)} placeholder="Job title"
                              className="w-28 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="number" value={row.declared_income} onChange={(e) => updateMemberRow(i, "declared_income", e.target.value)} placeholder="0"
                              className="w-24 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          {isLifeBundle && (
                            <td className="pr-2 pb-2 align-top">
                              <input type="number" value={row.coverage_amount} onChange={(e) => updateMemberRow(i, "coverage_amount", e.target.value)} placeholder="5000000"
                                className="w-28 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                            </td>
                          )}
                          {isLifeBundle && (
                            <td className="pr-2 pb-2 align-top">
                              <select value={row.plan_code} onChange={(e) => updateMemberRow(i, "plan_code", e.target.value)}
                                className="w-36 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                                <option value="">— select plan —</option>
                                {lifePlans.map((p) => (
                                  <option key={p.code} value={p.code}>{p.label}</option>
                                ))}
                              </select>
                            </td>
                          )}
                          <td className="pr-2 pb-2 align-top">
                            <select value={row.is_smoker} onChange={(e) => updateMemberRow(i, "is_smoker", e.target.value)}
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="">—</option>
                              <option value="false">No</option>
                              <option value="true">Yes</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="number" value={row.height_cm} onChange={(e) => updateMemberRow(i, "height_cm", e.target.value)} placeholder="170"
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="number" value={row.weight_kg} onChange={(e) => updateMemberRow(i, "weight_kg", e.target.value)} placeholder="70"
                              className="w-20 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pb-2 align-top">
                            <button type="button" onClick={() => removeMemberRow(i)} className="text-red-500 hover:text-red-700 font-bold px-1 mt-1">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button type="button" onClick={addMemberRow} className="text-xs font-semibold text-blue-600 hover:underline">
                  + Add Row
                </button>

                {validationResult && (
                  <div className={`rounded-lg border p-3 text-xs space-y-1 ${
                    validationResult.is_valid ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"
                  }`}>
                    <p className="font-bold">
                      {validationResult.is_valid ? "✓ Members Valid" : "⚠ Members have issues"} — {validationResult.total} row(s)
                    </p>
                    {validationResult.errors.map((e, i) => <p key={i}>{e}</p>)}
                    {validationResult.duplicate_cnics.length > 0 && <p>Duplicate CNICs: {validationResult.duplicate_cnics.join(", ")}</p>}
                    {validationResult.missing_fields.map((m, i) => <p key={i}>{m}</p>)}
                  </div>
                )}

                <div className="flex gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button" onClick={handleConfirmMembers} disabled={memberLoading}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/40 rounded-lg transition-colors"
                  >
                    {memberLoading ? "Working..." : "Confirm & Enroll"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Last Enrollment Result */}
          {confirmResult && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">Last Enrollment Result</p>
                {confirmResult.total_sum_insured != null && (
                  <span className="text-xs text-slate-500 font-medium">
                    Shared Pool: {formatPKR(confirmResult.total_sum_insured)}
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">Relationship</th>
                      <th className="px-5 py-3 text-left">Outcome</th>
                      <th className="px-5 py-3 text-right">Premium (Annual)</th>
                      <th className="px-5 py-3 text-right">Suggested Loading</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {confirmResult.members.map((m) => (
                      <tr key={m.customer_id}>
                        <td className="px-5 py-3 text-slate-700">{m.relationship}</td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${OUTCOME_STATUS_STYLE[m.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                            {m.status}
                          </span>
                          {m.risk_assessment_id && (
                            <span className="ml-2 text-[11px] text-slate-400">AI-assessed</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold text-slate-700">
                          {m.premium_total != null ? formatPKR(m.premium_total) : "—"}
                        </td>
                        <td className="px-5 py-3 text-right text-slate-500">
                          {m.suggested_loading != null ? `+${m.suggested_loading}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Family Roster */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">Family Roster</p>
              <span className="text-xs text-slate-400 font-medium">Total: {members.length}</span>
            </div>
            {members.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">No family members enrolled yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">CNIC</th>
                      <th className="px-5 py-3 text-left">Full Name</th>
                      <th className="px-5 py-3 text-left">Relationship</th>
                      <th className="px-5 py-3 text-left">Age / Gender</th>
                      <th className="px-5 py-3 text-left">Occupation</th>
                      <th className="px-5 py-3 text-right">Income</th>
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {members.map((m) => (
                      <tr key={m.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-3 font-medium text-slate-700">{m.cnic}</td>
                        <td className="px-5 py-3 font-semibold text-slate-800">{m.name}</td>
                        <td className="px-5 py-3 text-slate-600">{m.relationship ?? "—"}</td>
                        <td className="px-5 py-3 text-slate-600">
                          {new Date().getFullYear() - new Date(m.dob).getFullYear()} yrs · {m.gender}
                        </td>
                        <td className="px-5 py-3 text-slate-600">{m.occupation}</td>
                        <td className="px-5 py-3 text-right font-semibold text-slate-700">PKR {m.declared_income.toLocaleString()}</td>
                        <td className="px-5 py-3 text-right space-x-3">
                          <button onClick={() => handleEditMember(m)} className="text-xs font-bold text-emerald-600 hover:text-emerald-800 transition-colors">Edit</button>
                          <button onClick={() => handleDeleteMember(m.id, m.name)} className="text-xs font-bold text-red-600 hover:text-red-800 transition-colors">Delete</button>
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

      {/* ── CREATE FLOATER POLICY MODAL ── */}
      {showCreateFloater && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">New Floater Policy</h3>
              <button onClick={() => setShowCreateFloater(false)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <form onSubmit={handleCreateFloater} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Total Sum Insured (Shared Pool, PKR) *</label>
                <input
                  type="number" required value={totalSumInsured} onChange={(e) => setTotalSumInsured(e.target.value)}
                  placeholder="5000000"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Term (Years) *</label>
                <input type="number" required value={floaterTermYears} onChange={(e) => setFloaterTermYears(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Effective Date *</label>
                <input type="date" required value={floaterEffectiveDate} onChange={(e) => setFloaterEffectiveDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setShowCreateFloater(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={floaterFormLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                  {floaterFormLoading ? "Creating..." : "Create Floater Policy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── CREATE LIFE BUNDLE POLICY MODAL ── */}
      {showCreateLifeBundle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">New Life Bundle Policy</h3>
              <button onClick={() => setShowCreateLifeBundle(false)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <form onSubmit={handleCreateLifeBundle} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Term (Years) *</label>
                <input type="number" required value={lifeBundleTermYears} onChange={(e) => setLifeBundleTermYears(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Effective Date *</label>
                <input type="date" required value={lifeBundleEffectiveDate} onChange={(e) => setLifeBundleEffectiveDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Family Bundling Discount (%)</label>
                <input type="number" step="0.1" min="0" max="50" value={discountPercentage} onChange={(e) => setDiscountPercentage(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                <p className="text-[11px] text-slate-400">Applied to each member&apos;s own plan rate. 0-50%.</p>
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setShowCreateLifeBundle(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={lifeBundleFormLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                  {lifeBundleFormLoading ? "Creating..." : "Create Life Bundle Policy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── EDIT MEMBER MODAL ── */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Edit Family Member</h3>
              <button onClick={() => setEditingMember(null)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <form onSubmit={handleSaveMember} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">CNIC *</label>
                <input
                  type="text" required value={editMemberForm.cnic || ""} onChange={(e) => setEditMemberForm({...editMemberForm, cnic: formatCNIC(e.target.value)})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Full Name *</label>
                <input
                  type="text" required value={editMemberForm.name || ""} onChange={(e) => setEditMemberForm({...editMemberForm, name: e.target.value})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">DOB *</label>
                  <input
                    type="date" required value={editMemberForm.dob || ""} onChange={(e) => setEditMemberForm({...editMemberForm, dob: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-600">Gender *</label>
                  <select
                    required value={editMemberForm.gender || "Male"} onChange={(e) => setEditMemberForm({...editMemberForm, gender: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Occupation *</label>
                <input
                  type="text" required value={editMemberForm.occupation || ""} onChange={(e) => setEditMemberForm({...editMemberForm, occupation: e.target.value})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">Declared Income (Annual) *</label>
                <input
                  type="number" required value={editMemberForm.declared_income || ""} onChange={(e) => setEditMemberForm({...editMemberForm, declared_income: parseFloat(e.target.value)})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setEditingMember(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={editMemberFormLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                  {editMemberFormLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
