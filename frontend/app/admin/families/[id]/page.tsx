"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import api from "@/app/services/api";
import { notifyParentPortal } from "@/lib/agent/portalMessage";
import FamilyMembersEditor, { FamilyRow, blankRow, buildMembersPayload, checkRows, startRows } from "@/components/family/FamilyMembersEditor";
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
  is_smoker?: boolean | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  details?: any;
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
  nominees?: NomineeShare[];
}

interface NomineeShare { name: string; relationship: string; share_pct: number; amount: number | null; is_minor: boolean; guardian_name: string | null }

const EMPTY_ROW: MemberFormRow = {
  cnic: "", name: "", dob: "", gender: "Male", occupation: "", declared_income: "", relationship: "Spouse",
  is_smoker: "", height_cm: "", weight_kg: "", coverage_amount: "", plan_code: "",
};

const FAMILY_POLICY_STATUS_STYLE: Record<string, string> = {
  Active: "bg-blue-50 text-blue-700 border-blue-200",
  Proposed: "bg-blue-50 text-blue-700 border-blue-200",
  Pending: "bg-blue-50 text-blue-700 border-blue-200",
  Review: "bg-amber-50 text-amber-700 border-amber-200",
};

const OUTCOME_STATUS_STYLE: Record<string, string> = {
  Approved: "bg-blue-50 text-blue-700 border-blue-200",
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

// Same shape as the individual Customer "Full Customer Entry" form
// (frontend/app/admin/customers/page.tsx `defaultDetails`) — keeping the two
// identical means underwriting's `customer.details?.x` rendering works the
// same for a family member as it does for an individual customer, with zero
// underwriting-side changes needed.
const defaultMemberDetails = {
  address: {
    address_type: "Residential",
    street_address: "",
    area: "",
    city: "",
    district: "",
    province: "",
    country: "Pakistan",
    postal_code: "",
  },
  contact: {
    mobile_number: "",
    phone: "",
    email: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
    emergency_contact_relation: "",
  },
  cnic_metadata: {
    issue_date: "",
    expiry_date: "",
  },
  occupation_details: {
    job_title: "",
    employer_name: "",
    industry: "",
    employment_type: "Salaried",
    years_of_experience: 0,
    occupation_hazard_level: "Low",
  },
  income_record: {
    monthly_income: 0,
    annual_income: 0,
    income_source: "Salary",
    currency: "PKR",
  },
  medical_history: {
    has_pre_existing_conditions: false,
    is_diabetic: false,
    has_hypertension: false,
    has_heart_disease: false,
    surgical_history: "",
    notes: "",
  },
  lifestyle: {
    smoking_status: "NonSmoker",
    alcohol_status: "None",
    exercise_frequency: "Sedentary",
    diet_type: "Regular",
    has_hazardous_hobby: false,
    hazardous_hobby_details: "",
  },
  habit_check: {
    alcohol_consumption_frequency: "None",
    recreational_drug_use_history: false,
    participates_in_extreme_sports: false,
    frequent_high_risk_travel: false,
    dui_dwi_history: false,
    criminal_record: false,
  },
  financial_records: {
    bank_statement: {
      bank_name: "",
      average_monthly_balance: 0,
    },
    credit_bureau: {
      credit_score: 750,
      risk_grade: "A",
    },
  },
  beneficiary: {
    first_name: "",
    last_name: "",
    cnic_number: "",
    relationship: "Spouse",
    share_percentage: 100,
    phone: "",
  },
};

function importMemberDetails(raw: any): typeof defaultMemberDetails {
  const base = JSON.parse(JSON.stringify(defaultMemberDetails));
  if (!raw || typeof raw !== "object") return base;
  const merged: any = { ...base };
  for (const key of Object.keys(base)) {
    merged[key] = { ...(base as any)[key], ...(raw[key] || {}) };
  }
  return merged;
}

// Rough completeness signal shown on the roster — mirrors the individual
// Customer directory's "Lead / Prospect / Ready" heuristic, adapted for a
// family member who already has the core enrollment fields by construction.
function memberHasFullDetails(m: FamilyMemberRow): boolean {
  const d = m.details;
  if (!d) return false;
  return !!(
    d.address?.city ||
    d.contact?.mobile_number ||
    d.medical_history?.has_pre_existing_conditions ||
    d.medical_history?.is_diabetic ||
    d.medical_history?.has_hypertension ||
    d.medical_history?.has_heart_disease ||
    d.beneficiary?.first_name ||
    d.financial_records?.bank_statement?.bank_name
  );
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
  const [editMemberTab, setEditMemberTab] = useState("core");
  const [editMemberDetails, setEditMemberDetails] = useState<typeof defaultMemberDetails>(defaultMemberDetails);

  const editMemberTabs = [
    { id: "core", label: "Core Info" },
    { id: "address", label: "Address & Contact" },
    { id: "cnic_metadata", label: "CNIC & Docs" },
    { id: "occupation_details", label: "Occupation & Income" },
    { id: "medical_history", label: "Medical & Lifestyle" },
    { id: "habit_check", label: "Habit Check" },
    { id: "financial_records", label: "Financial Profile" },
    { id: "beneficiary", label: "Nominee Details" },
  ];

  const updateMemberDetailField = (section: keyof typeof defaultMemberDetails, key: string, value: any) => {
    setEditMemberDetails((prev) => ({ ...prev, [section]: { ...prev[section], [key]: value } }));
  };

  const updateMemberDetailSubField = (section: keyof typeof defaultMemberDetails, sub: string, key: string, value: any) => {
    setEditMemberDetails((prev: any) => ({
      ...prev,
      [section]: { ...prev[section], [sub]: { ...prev[section][sub], [key]: value } },
    }));
  };

  // Member entry
  const [selectedPolicyId, setSelectedPolicyId] = useState("");
  const [memberRows, setMemberRows] = useState<FamilyRow[]>(startRows());
  // Nominees already saved for the selected policy: what is left to give, and what a share is a share of.
  const [nomineeInfo, setNomineeInfo] = useState<{ nominees: NomineeShare[]; total_share: number; base_amount: number | null }>({ nominees: [], total_share: 0, base_amount: null });
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

  // The head is enrolled once; later batches (a spouse, more nominees) have no head row.
  const hasHead = members.some((m) => m.relationship === "Self");
  const loadNominees = async (policyId: string) => {
    try {
      const r = await api.get(`/tenants/${tenantId}/families/${familyId}/family-policies/${policyId}/nominees`);
      setNomineeInfo(r.data);
    } catch { setNomineeInfo({ nominees: [], total_share: 0, base_amount: null }); }
  };
  useEffect(() => { if (selectedPolicyId) loadNominees(selectedPolicyId); }, [selectedPolicyId, familyId]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMemberRows(hasHead ? [blankRow("Nominee")] : startRows()); }, [hasHead, selectedPolicyId]);

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
        { members: buildMembersPayload(memberRows, isLifeBundle) }
      );
      setValidationResult(resp.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to validate members.");
    } finally {
      setMemberLoading(false);
    }
  };

  const submittingMembersRef = useRef(false);

  const handleConfirmMembers = async () => {
    if (!selectedPolicy || submittingMembersRef.current || memberLoading) return;
    submittingMembersRef.current = true;
    setError("");
    setSuccess("");
    setMemberLoading(true);
    try {
      const { problems } = checkRows(memberRows, isLifeBundle, nomineeInfo.total_share, hasHead);
      if (problems.length) { setError(problems.slice(0, 4).join("; ") + (problems.length > 4 ? `; …and ${problems.length - 4} more` : "")); return; }
      const sent = buildMembersPayload(memberRows, isLifeBundle);
      const insuredSent = sent.filter((m: any) => m.is_insured);
      const resp = await api.post<FamilyConfirmResult>(
        `/tenants/${tenantId}/families/${familyId}/${policyPathSegment}/${selectedPolicy.id}/members/confirm`,
        { members: sent }
      );
      // When this page is embedded in the Copilot, hand back to the chat so it carries on with the
      // proposal steps (and then pre-underwriting) — exactly as after "Add demo data". No-op standalone.
      notifyParentPortal("family_members_enrolled", {
        family_group_id: familyId,
        family_policy_id: selectedPolicy.id,
        name: family?.name ?? "The family",
        is_life_bundle: isLifeBundle,
        // Only the head and an insured spouse have underwriting cases, head first; they come back in the order sent.
        cases: resp.data.members
          .map((o: any, i: number) => ({ case_id: o.case_id, case_number: o.case_number, name: (insuredSent[i] as any)?.name ?? "Member", relationship: (insuredSent[i] as any)?.relationship ?? "" }))
          .filter((c: any) => c.case_id && c.case_number),
      });
      setSuccess(
        `${resp.data.members.length} insured member(s) and ${sent.length - resp.data.members.length} nominee(s) saved on the ${isLifeBundle ? "life bundle" : "floater"} policy.`
      );
      setConfirmResult(resp.data);
      setValidationResult(null);
      await fetchAll();
      await loadNominees(selectedPolicy.id);
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
      submittingMembersRef.current = false;
    }
  };

  const handleEditMember = (member: FamilyMemberRow) => {
    setEditingMember(member);
    setEditMemberForm({ ...member });
    setEditMemberDetails(importMemberDetails(member.details));
    setEditMemberTab("core");
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
      const payloadDetails = {
        ...editMemberDetails,
        income_record: {
          ...editMemberDetails.income_record,
          declared_income: editMemberForm.declared_income,
          annual_income: editMemberForm.declared_income,
        },
      };
      const payload = {
        cnic: editMemberForm.cnic,
        first_name: firstName,
        last_name: lastName || undefined,
        date_of_birth: editMemberForm.dob,
        gender: editMemberForm.gender,
        occupation: editMemberForm.occupation,
        declared_income: editMemberForm.declared_income,
        is_smoker: editMemberForm.is_smoker ?? false,
        height_cm: editMemberForm.height_cm || 170,
        weight_kg: editMemberForm.weight_kg || 70,
        details: payloadDetails,
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
      {success && <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-600 font-medium">{success}</div>}

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
                <FamilyMembersEditor
                  rows={memberRows} onChange={setMemberRows} isBundle={isLifeBundle} lifePlans={lifePlans} hasHead={hasHead}
                  existingShare={nomineeInfo.total_share}
                  baseAmount={isLifeBundle ? parseFloat(memberRows.find((r) => r.kind === "Self")?.coverage_amount || "0") || nomineeInfo.base_amount || 0 : selectedPolicy?.total_sum_insured || 0}
                />

                {validationResult && (
                  <div className={`rounded-lg border p-3 text-xs space-y-1 ${
                    validationResult.is_valid ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-amber-50 border-amber-200 text-amber-700"
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

          {/* Nominees & their shares of the head's death benefit */}
          {nomineeInfo.nominees.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">Nominees — share of the head&apos;s death benefit</p>
                <span className={`text-xs font-semibold tabular-nums ${Math.abs(nomineeInfo.total_share - 100) < 0.01 ? "text-emerald-700" : "text-amber-700"}`}>
                  {nomineeInfo.total_share}% allocated{nomineeInfo.base_amount ? ` of ${formatPKR(nomineeInfo.base_amount)}` : ""}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    <th className="px-5 py-3 text-left">Name</th><th className="px-5 py-3 text-left">Relationship</th>
                    <th className="px-5 py-3 text-right">Share</th><th className="px-5 py-3 text-right">Amount</th><th className="px-5 py-3 text-left">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {nomineeInfo.nominees.map((n, i) => (
                    <tr key={`${n.name}${i}`}>
                      <td className="px-5 py-3 font-medium text-slate-800">{n.name}</td>
                      <td className="px-5 py-3 text-slate-600">{n.relationship}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{n.share_pct}%</td>
                      <td className="px-5 py-3 text-right tabular-nums text-slate-700">{n.amount != null ? formatPKR(n.amount) : "—"}</td>
                      <td className="px-5 py-3 text-xs text-slate-500">{n.is_minor ? `Minor${n.guardian_name ? ` — paid to ${n.guardian_name}` : ""}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                      <th className="px-5 py-3 text-left">Profile</th>
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
                        <td className="px-5 py-3">
                          {memberHasFullDetails(m) ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                              Full Details
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                              Core Only
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right space-x-3">
                          <button onClick={() => handleEditMember(m)} className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors">Edit</button>
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

      {/* ── EDIT MEMBER MODAL (Full Details, same modules as an individual customer) ── */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden my-8">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
              <div>
                <h3 className="text-base font-bold text-slate-900">Edit Family Member — {editingMember.name}</h3>
                <p className="text-xs text-slate-500 mt-0.5">Same profile modules as an individual customer, feeds underwriting the same way.</p>
              </div>
              <button onClick={() => setEditingMember(null)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>

            <div className="px-6 border-b border-slate-100 bg-white flex flex-wrap gap-1 shrink-0">
              {editMemberTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setEditMemberTab(tab.id)}
                  className={`px-3.5 py-2.5 text-xs font-semibold border-b-2 transition-all ${editMemberTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-400 hover:text-slate-600"
                    }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <form id="edit-member-form" onSubmit={handleSaveMember} className="flex-1 overflow-y-auto p-6 space-y-4">

              {editMemberTab === "core" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">CNIC *</label>
                    <input type="text" required value={editMemberForm.cnic || ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, cnic: formatCNIC(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Full Name *</label>
                    <input type="text" required value={editMemberForm.name || ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, name: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">DOB *</label>
                      <input type="date" required value={editMemberForm.dob || ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, dob: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Gender *</label>
                      <select required value={editMemberForm.gender || "Male"} onChange={(e) => setEditMemberForm({ ...editMemberForm, gender: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Occupation *</label>
                    <input type="text" required value={editMemberForm.occupation || ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, occupation: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Declared Income (Annual) *</label>
                    <input type="number" required value={editMemberForm.declared_income || ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, declared_income: parseFloat(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Smoker?</label>
                      <select value={editMemberForm.is_smoker ? "true" : "false"} onChange={(e) => setEditMemberForm({ ...editMemberForm, is_smoker: e.target.value === "true" })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="false">No</option>
                        <option value="true">Yes</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Height (cm)</label>
                      <input type="number" value={editMemberForm.height_cm ?? ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, height_cm: parseFloat(e.target.value) || undefined })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Weight (kg)</label>
                      <input type="number" value={editMemberForm.weight_kg ?? ""} onChange={(e) => setEditMemberForm({ ...editMemberForm, weight_kg: parseFloat(e.target.value) || undefined })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                  </div>
                </div>
              )}

              {editMemberTab === "address" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Street Address</label>
                      <input type="text" value={editMemberDetails.address.street_address} onChange={(e) => updateMemberDetailField("address", "street_address", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Area</label>
                      <input type="text" value={editMemberDetails.address.area} onChange={(e) => updateMemberDetailField("address", "area", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">City</label>
                      <input type="text" value={editMemberDetails.address.city} onChange={(e) => updateMemberDetailField("address", "city", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Province</label>
                      <input type="text" value={editMemberDetails.address.province} onChange={(e) => updateMemberDetailField("address", "province", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Postal Code</label>
                      <input type="text" value={editMemberDetails.address.postal_code} onChange={(e) => updateMemberDetailField("address", "postal_code", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                  </div>
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Mobile Number</label>
                      <input type="text" value={editMemberDetails.contact.mobile_number} onChange={(e) => updateMemberDetailField("contact", "mobile_number", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Email</label>
                      <input type="email" value={editMemberDetails.contact.email} onChange={(e) => updateMemberDetailField("contact", "email", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Emergency Contact Name</label>
                      <input type="text" value={editMemberDetails.contact.emergency_contact_name} onChange={(e) => updateMemberDetailField("contact", "emergency_contact_name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Emergency Contact Phone</label>
                      <input type="text" value={editMemberDetails.contact.emergency_contact_phone} onChange={(e) => updateMemberDetailField("contact", "emergency_contact_phone", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                  </div>
                </div>
              )}

              {editMemberTab === "cnic_metadata" && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">CNIC Issue Date</label>
                    <input type="date" value={editMemberDetails.cnic_metadata.issue_date} onChange={(e) => updateMemberDetailField("cnic_metadata", "issue_date", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">CNIC Expiry Date</label>
                    <input type="date" value={editMemberDetails.cnic_metadata.expiry_date} onChange={(e) => updateMemberDetailField("cnic_metadata", "expiry_date", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                </div>
              )}

              {editMemberTab === "occupation_details" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Job Title</label>
                      <input type="text" value={editMemberDetails.occupation_details.job_title} onChange={(e) => updateMemberDetailField("occupation_details", "job_title", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Employer Name</label>
                      <input type="text" value={editMemberDetails.occupation_details.employer_name} onChange={(e) => updateMemberDetailField("occupation_details", "employer_name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Employment Type</label>
                      <select value={editMemberDetails.occupation_details.employment_type} onChange={(e) => updateMemberDetailField("occupation_details", "employment_type", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Salaried">Salaried</option>
                        <option value="Self-Employed">Self-Employed</option>
                        <option value="Business Owner">Business Owner</option>
                        <option value="Unemployed">Unemployed</option>
                        <option value="Retired">Retired</option>
                        <option value="Student">Student</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Occupation Hazard Level</label>
                      <select value={editMemberDetails.occupation_details.occupation_hazard_level} onChange={(e) => updateMemberDetailField("occupation_details", "occupation_hazard_level", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Low">Low</option>
                        <option value="Medium">Medium</option>
                        <option value="High">High</option>
                      </select>
                    </div>
                  </div>
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Monthly Income (PKR)</label>
                      <input type="number" value={editMemberDetails.income_record.monthly_income} onChange={(e) => updateMemberDetailField("income_record", "monthly_income", parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Income Source</label>
                      <select value={editMemberDetails.income_record.income_source} onChange={(e) => updateMemberDetailField("income_record", "income_source", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Salary">Salary</option>
                        <option value="Business">Business</option>
                        <option value="Investments">Investments</option>
                        <option value="Rental">Rental</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {editMemberTab === "medical_history" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    {(["has_pre_existing_conditions", "is_diabetic", "has_hypertension", "has_heart_disease"] as const).map((key) => (
                      <label key={key} className="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <input type="checkbox" checked={!!editMemberDetails.medical_history[key]} onChange={(e) => updateMemberDetailField("medical_history", key, e.target.checked)} />
                        {key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
                      </label>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Surgical History</label>
                    <textarea value={editMemberDetails.medical_history.surgical_history} onChange={(e) => updateMemberDetailField("medical_history", "surgical_history", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" rows={2} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Medical Notes</label>
                    <textarea value={editMemberDetails.medical_history.notes} onChange={(e) => updateMemberDetailField("medical_history", "notes", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" rows={2} />
                  </div>
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Smoking Status</label>
                      <select value={editMemberDetails.lifestyle.smoking_status} onChange={(e) => updateMemberDetailField("lifestyle", "smoking_status", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="NonSmoker">Non-Smoker</option>
                        <option value="Smoker">Smoker</option>
                        <option value="FormerSmoker">Former Smoker</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Alcohol Status</label>
                      <select value={editMemberDetails.lifestyle.alcohol_status} onChange={(e) => updateMemberDetailField("lifestyle", "alcohol_status", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="None">None</option>
                        <option value="Occasional">Occasional</option>
                        <option value="Regular">Regular</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Exercise Frequency</label>
                      <select value={editMemberDetails.lifestyle.exercise_frequency} onChange={(e) => updateMemberDetailField("lifestyle", "exercise_frequency", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Sedentary">Sedentary</option>
                        <option value="Light">Light</option>
                        <option value="Moderate">Moderate</option>
                        <option value="Active">Active</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Diet Type</label>
                      <select value={editMemberDetails.lifestyle.diet_type} onChange={(e) => updateMemberDetailField("lifestyle", "diet_type", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Regular">Regular</option>
                        <option value="Vegetarian">Vegetarian</option>
                        <option value="Vegan">Vegan</option>
                      </select>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                    <input type="checkbox" checked={!!editMemberDetails.lifestyle.has_hazardous_hobby} onChange={(e) => updateMemberDetailField("lifestyle", "has_hazardous_hobby", e.target.checked)} />
                    Has a hazardous hobby
                  </label>
                  {editMemberDetails.lifestyle.has_hazardous_hobby && (
                    <input type="text" value={editMemberDetails.lifestyle.hazardous_hobby_details} onChange={(e) => updateMemberDetailField("lifestyle", "hazardous_hobby_details", e.target.value)}
                      placeholder="e.g. Skydiving, scuba diving"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  )}
                </div>
              )}

              {editMemberTab === "habit_check" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Alcohol Consumption Frequency</label>
                    <select value={editMemberDetails.habit_check.alcohol_consumption_frequency} onChange={(e) => updateMemberDetailField("habit_check", "alcohol_consumption_frequency", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                      <option value="None">None</option>
                      <option value="Occasional">Occasional</option>
                      <option value="Regular">Regular</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(["recreational_drug_use_history", "participates_in_extreme_sports", "frequent_high_risk_travel", "dui_dwi_history", "criminal_record"] as const).map((key) => (
                      <label key={key} className="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <input type="checkbox" checked={!!editMemberDetails.habit_check[key]} onChange={(e) => updateMemberDetailField("habit_check", key, e.target.checked)} />
                        {key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {editMemberTab === "financial_records" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Bank Name</label>
                      <input type="text" value={editMemberDetails.financial_records.bank_statement.bank_name} onChange={(e) => updateMemberDetailSubField("financial_records", "bank_statement", "bank_name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Average Monthly Balance (PKR)</label>
                      <input type="number" value={editMemberDetails.financial_records.bank_statement.average_monthly_balance} onChange={(e) => updateMemberDetailSubField("financial_records", "bank_statement", "average_monthly_balance", parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Credit Score</label>
                      <input type="number" value={editMemberDetails.financial_records.credit_bureau.credit_score} onChange={(e) => updateMemberDetailSubField("financial_records", "credit_bureau", "credit_score", parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">Risk Grade</label>
                      <select value={editMemberDetails.financial_records.credit_bureau.risk_grade} onChange={(e) => updateMemberDetailSubField("financial_records", "credit_bureau", "risk_grade", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                        <option value="D">D</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {editMemberTab === "beneficiary" && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Nominee First Name</label>
                    <input type="text" value={editMemberDetails.beneficiary.first_name} onChange={(e) => updateMemberDetailField("beneficiary", "first_name", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Nominee Last Name</label>
                    <input type="text" value={editMemberDetails.beneficiary.last_name} onChange={(e) => updateMemberDetailField("beneficiary", "last_name", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Nominee CNIC</label>
                    <input type="text" value={editMemberDetails.beneficiary.cnic_number} onChange={(e) => updateMemberDetailField("beneficiary", "cnic_number", formatCNIC(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Relationship to Nominee</label>
                    <select value={editMemberDetails.beneficiary.relationship} onChange={(e) => updateMemberDetailField("beneficiary", "relationship", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                      <option value="Spouse">Spouse</option>
                      <option value="Child">Child</option>
                      <option value="Parent">Parent</option>
                      <option value="Sibling">Sibling</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Share Percentage</label>
                    <input type="number" min="0" max="100" value={editMemberDetails.beneficiary.share_percentage} onChange={(e) => updateMemberDetailField("beneficiary", "share_percentage", parseFloat(e.target.value) || 0)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">Nominee Phone</label>
                    <input type="text" value={editMemberDetails.beneficiary.phone} onChange={(e) => updateMemberDetailField("beneficiary", "phone", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                </div>
              )}
            </form>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100 bg-slate-50 shrink-0">
              <button type="button" onClick={() => setEditingMember(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-white transition-colors">
                Cancel
              </button>
              <button type="submit" form="edit-member-form" disabled={editMemberFormLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                {editMemberFormLoading ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
