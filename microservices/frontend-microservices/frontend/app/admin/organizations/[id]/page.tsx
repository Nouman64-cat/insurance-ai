"use client";

import { displayDate } from '../../../../lib/dateDisplay';
import { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import api from "@/app/services/api";
import SchemePanel from "@/components/group/SchemePanel";
import ClassesPanel from "@/components/group/ClassesPanel";
import MembersPanel from "@/components/group/MembersPanel";
import QuotePanel from "@/components/group/QuotePanel";
import EndorsementsPanel from "@/components/group/EndorsementsPanel";
import ClaimsPanel from "@/components/group/ClaimsPanel";
import RenewalsPanel from "@/components/group/RenewalsPanel";
import { tx } from "@/lib/i18n/tx";

import { keyedPost } from "@/lib/idempotency";
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
  policy_number?: string | null;
  expiry_date?: string | null;
  plan_code?: string | null;
  plan_label?: string | null;
  business_type?: string | null;
  created_at: string;
}

const GROUP_TABS = [
  { id: "overview", label: "Overview" },
  { id: "scheme", label: "Scheme" },
  { id: "classes", label: "Classes" },
  { id: "members", label: "Members" },
  { id: "quote", label: "Quote" },
  { id: "endorsements", label: "Endorsements" },
  { id: "claims", label: "Claims" },
  { id: "renewals", label: "Renewals" },
] as const;
type GroupTab = (typeof GROUP_TABS)[number]["id"];

const GROUP_PLANS = [
  { code: "GROUP_LIFE", label: "Group Life (Conventional)" },
  { code: "GROUP_LIFE_SME", label: "Group Life — SME (Conventional)" },
  { code: "GROUP_FAMILY_TAKAFUL", label: "Group Family Takaful" },
  { code: "GROUP_CREDIT_LIFE", label: "Group Credit Life (Conventional)" },
];

interface Employee {
  id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
  is_smoker?: boolean | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  details?: any;
}

interface EmployeeCaseInfo {
  customer_id: string;
  case_id: string;
  case_number: string;
  case_status: string;
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
  Active: "bg-blue-50 text-blue-700 border-blue-200",
  Proposed: "bg-blue-50 text-blue-700 border-blue-200",
  Pending: "bg-blue-50 text-blue-700 border-blue-200",
  Review: "bg-amber-50 text-amber-700 border-amber-200",
};

const POLICY_STATUS_STYLE: Record<string, string> = {
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
// (frontend/app/admin/customers/page.tsx `defaultDetails`) and the Family
// member editor (frontend/app/admin/families/[id]/page.tsx) — keeping all
// three identical means underwriting's `customer.details?.x` rendering works
// the same for a corporate employee as it does for an individual customer
// or family member, with zero underwriting-side changes needed.
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

// Rough completeness signal shown on the roster — mirrors the Family member
// editor's "Full Details / Core Only" badge.
function employeeHasFullDetails(e: Employee): boolean {
  const d = e.details;
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

export default function OrganizationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = params.id as string;
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [masterPolicies, setMasterPolicies] = useState<MasterPolicy[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeCases, setEmployeeCases] = useState<Record<string, EmployeeCaseInfo>>({});
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Which section of the scheme is showing. The chat links straight to one (?tab=quote).
  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<GroupTab>(GROUP_TABS.some((t) => t.id === initialTab) ? (initialTab as GroupTab) : "overview");
  const changeTab = (next: GroupTab) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab"); else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url.toString());
  };

  // Create master policy form
  const [planCode, setPlanCode] = useState("GROUP_LIFE");
  const [showCreateMP, setShowCreateMP] = useState(false);
  const [sumAssuredMultiple, setSumAssuredMultiple] = useState("24");
  const [termYears, setTermYears] = useState("10");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [mpFormLoading, setMpFormLoading] = useState(false);

  // Employee CRUD (Full Details, same modules as an individual customer / family member)
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editEmpForm, setEditEmpForm] = useState<Partial<Employee>>({});
  const [empFormLoading, setEmpFormLoading] = useState(false);
  const [editEmpTab, setEditEmpTab] = useState("core");
  const [editEmpDetails, setEditEmpDetails] = useState<typeof defaultMemberDetails>(defaultMemberDetails);

  const editEmpTabs = [
    { id: "core", label: "Core Info" },
    { id: "address", label: "Address & Contact" },
    { id: "cnic_metadata", label: "CNIC & Docs" },
    { id: "occupation_details", label: "Occupation & Income" },
    { id: "medical_history", label: "Medical & Lifestyle" },
    { id: "habit_check", label: "Habit Check" },
    { id: "financial_records", label: "Financial Profile" },
    { id: "beneficiary", label: "Nominee Details" },
  ];

  const updateEmpDetailField = (section: keyof typeof defaultMemberDetails, key: string, value: any) => {
    setEditEmpDetails((prev) => ({ ...prev, [section]: { ...prev[section], [key]: value } }));
  };

  const updateEmpDetailSubField = (section: keyof typeof defaultMemberDetails, sub: string, key: string, value: any) => {
    setEditEmpDetails((prev: any) => ({
      ...prev,
      [section]: { ...prev[section], [sub]: { ...prev[section][sub], [key]: value } },
    }));
  };

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

  const fetchAll = async (silent = false) => {
    // `silent` re-reads in place (after a change inside a tab) without the full-page
    // spinner, which would unmount the tab and lose its messages.
    if (!silent) setLoading(true);
    setError("");
    try {
      const [orgResp, mpResp, empResp, casesResp] = await Promise.all([
        api.get<Organization>(`/tenants/${tenantId}/organizations/${orgId}`),
        api.get<MasterPolicy[]>(`/tenants/${tenantId}/organizations/${orgId}/master-policies`),
        api.get<Employee[]>(`/tenants/${tenantId}/organizations/${orgId}/employees`),
        api.get<EmployeeCaseInfo[]>(`/tenants/${tenantId}/organizations/${orgId}/cases`).catch(() => ({ data: [] as EmployeeCaseInfo[] })),
      ]);
      setOrganization(orgResp.data);
      setMasterPolicies(mpResp.data);
      setEmployees(empResp.data);
      setEmployeeCases(Object.fromEntries(casesResp.data.map((c) => [c.customer_id, c])));
      setSelectedMpId((current) =>
        mpResp.data.some((m) => m.id === current) ? current : mpResp.data[0]?.id ?? "");
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to load organization."));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleCreateMasterPolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setMpFormLoading(true);
    try {
      const resp = { data: await keyedPost<MasterPolicy>(api, `master-policy-create:${orgId}`, `/tenants/${tenantId}/organizations/${orgId}/master-policies`, {
        sum_assured_multiple: parseFloat(sumAssuredMultiple) || 0,
        term_years: parseInt(termYears) || 0,
        effective_date: effectiveDate,
        plan_code: planCode,
      }) };
      setSuccess(tx("Master policy created. Now add the employee census below."));
      setShowCreateMP(false);
      setMasterPolicies((prev) => [resp.data, ...prev]);
      setSelectedMpId(resp.data.id);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.join(", ") : detail ?? err.message ?? tx("Failed to create master policy."));
    } finally {
      setMpFormLoading(false);
    }
  };

  // Edit / remove a master policy
  const [editingMP, setEditingMP] = useState<MasterPolicy | null>(null);
  const [mpForm, setMpForm] = useState({ plan: "GROUP_LIFE", multiple: "", term: "", date: "" });
  const [mpBusy, setMpBusy] = useState(false);

  const startEditMP = (mp: MasterPolicy) => {
    setError(""); setSuccess("");
    setEditingMP(mp);
    setMpForm({ plan: mp.plan_code ?? "GROUP_LIFE", multiple: String(mp.sum_assured_multiple), term: String(mp.term_years), date: mp.effective_date });
  };

  const handleSaveMP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMP) return;
    setMpBusy(true);
    setError("");
    try {
      const resp = await api.patch<MasterPolicy>(`/tenants/${tenantId}/organizations/${orgId}/master-policies/${editingMP.id}`, {
        plan_code: mpForm.plan,
        sum_assured_multiple: parseFloat(mpForm.multiple) || 0,
        term_years: parseInt(mpForm.term) || 0,
        effective_date: mpForm.date,
      });
      setMasterPolicies((prev) => prev.map((m) => (m.id === resp.data.id ? resp.data : m)));
      setEditingMP(null);
      setSuccess(tx("Master policy updated."));
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.map((d: any) => d.msg ?? d).join(", ") : detail ?? err.message ?? tx("Failed to update the master policy."));
    } finally {
      setMpBusy(false);
    }
  };

  const handleDeleteMP = async (mp: MasterPolicy) => {
    if (!window.confirm(tx("Remove this master policy ({0}× · {1})? The employees enrolled on it, their certificates and its benefit classes are removed too. This cannot be undone.", { 0: mp.sum_assured_multiple, 1: mp.effective_date }))) return;
    setError(""); setSuccess("");
    try {
      await api.delete(`/tenants/${tenantId}/organizations/${orgId}/master-policies/${mp.id}`);
      setSuccess(tx("Master policy removed."));
      await fetchAll(true);
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === "string" ? detail : err.message ?? tx("Failed to remove the master policy."));
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

  // A row nobody typed into is not part of the census.
  const filledCensusRows = censusRows.filter((r) =>
    [r.cnic, r.name, r.dob, r.occupation, r.declared_income, r.height_cm, r.weight_kg].some((v) => v.trim() !== ""));

  const buildEmployeesPayload = () =>
    filledCensusRows.map((r) => ({
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
    if (filledCensusRows.length === 0) { setError(tx("Add at least one employee to the census first.")); return; }
    setCensusLoading(true);
    try {
      const resp = await api.post<CensusValidationResult>(
        `/tenants/${tenantId}/organizations/${orgId}/master-policies/${selectedMpId}/census/validate`,
        { employees: buildEmployeesPayload() }
      );
      setCensusResult(resp.data);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to validate census."));
    } finally {
      setCensusLoading(false);
    }
  };

  const handleConfirmCensus = async () => {
    setError("");
    setSuccess("");
    if (filledCensusRows.length === 0) { setError(tx("Add at least one employee to the census first.")); return; }
    setCensusLoading(true);
    try {
      const resp = { data: await keyedPost<CensusConfirmResult>(api, `census-confirm:${selectedMpId}`, 
        `/tenants/${tenantId}/organizations/${orgId}/master-policies/${selectedMpId}/census/confirm`,
        { employees: buildEmployeesPayload() }
      ) };
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
        setError(typeof detail === "object" ? JSON.stringify(detail) : detail ?? err.message ?? tx("Failed to confirm census."));
      }
    } finally {
      setCensusLoading(false);
    }
  };

  const handleEditEmployee = (emp: Employee) => {
    setEditingEmployee(emp);
    setEditEmpForm({ ...emp });
    setEditEmpDetails(importMemberDetails(emp.details));
    setEditEmpTab("core");
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
      const payloadDetails = {
        ...editEmpDetails,
        income_record: {
          ...editEmpDetails.income_record,
          declared_income: editEmpForm.declared_income,
          annual_income: editEmpForm.declared_income,
        },
      };
      const payload = {
        cnic: editEmpForm.cnic,
        first_name: firstName,
        last_name: lastName || undefined,
        date_of_birth: editEmpForm.dob,
        gender: editEmpForm.gender,
        occupation: editEmpForm.occupation,
        declared_income: editEmpForm.declared_income,
        is_smoker: editEmpForm.is_smoker ?? false,
        height_cm: editEmpForm.height_cm || 170,
        weight_kg: editEmpForm.weight_kg || 70,
        details: payloadDetails,
      };
      await api.put(`/tenants/${tenantId}/customers/${editingEmployee.id}`, payload);
      setSuccess(tx("Employee updated successfully."));
      setEditingEmployee(null);
      fetchAll();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to update employee."));
    } finally {
      setEmpFormLoading(false);
    }
  };

  const handleDeleteEmployee = async (empId: string, empName: string) => {
    if (!confirm(tx("Are you sure you want to delete {0}? This will also delete their policy, quotes, and AI assessments.", { 0: empName }))) return;
    setError("");
    setSuccess("");
    try {
      await api.delete(`/tenants/${tenantId}/organizations/${orgId}/employees/${empId}`);
      setSuccess(tx("Employee {0} deleted successfully.", { 0: empName }));
      fetchAll();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? tx("Failed to delete employee."));
    }
  };

  if (!authorized) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] font-sans">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-8 text-center space-y-4">
          <div className="text-red-500 font-bold">{tx("Unauthorized Access")}</div>
          <p className="text-slate-400 text-sm">{tx("Administrative privileges required.")}</p>
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
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{organization?.name ?? tx("Loading...")}</h1>
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
                  <p className="font-bold mb-2">{tx("Invalid Data Format:")}</p>
                  {parsed.map((e: any, i: number) => (
                    <p key={i}>• {e.loc.join(" -> ")}: {e.msg}</p>
                  ))}
                </div>
              );
            }

            if (missing.length > 0 || errs.length > 0 || dups.length > 0) {
              return (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium space-y-1">
                  <p className="font-bold mb-2">{tx("Please fix the following issues before enrolling:")}</p>
                  {missing.map((m: string, i: number) => <p key={`m-${i}`}>• {m}</p>)}
                  {errs.map((e: string, i: number) => <p key={`e-${i}`}>• {e}</p>)}
                  {dups.length > 0 && <p>{tx("• Duplicate CNICs:")}{" "}{dups.join(", ")}</p>}
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
          <span className="text-xs text-slate-400">{tx("Loading...")}</span>
        </div>
      ) : (
        <>
          {/* Section tabs */}
          <div className="flex items-center gap-1 border-b border-slate-200">
            {GROUP_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => changeTab(t.id)}
                className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition-colors ${
                  tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {tx(t.label)}
              </button>
            ))}
          </div>

          {tab !== "overview" && (() => {
            const mp = masterPolicies.find((m) => m.id === selectedMpId) ?? masterPolicies[0];
            if (!mp) {
              return (
                <div className="bg-white rounded-xl border border-slate-200 py-12 text-center text-sm text-slate-400">
                  {tx("No group scheme yet — create a master policy from the Overview tab.")}
                </div>
              );
            }
            const panel = { tenantId, orgId, mp, reload: () => fetchAll(true) };
            return (
              <div className="space-y-4">
                {masterPolicies.length > 1 && (
                  <select value={mp.id} onChange={(e) => setSelectedMpId(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white">
                    {masterPolicies.map((m) => (
                      <option key={m.id} value={m.id}>{m.plan_label ?? tx("Group Life")} · {displayDate(m.effective_date)} ({m.status})</option>
                    ))}
                  </select>
                )}
                {tab === "scheme" && <SchemePanel {...panel} />}
                {tab === "classes" && <ClassesPanel {...panel} />}
                {tab === "members" && <MembersPanel {...panel} />}
                {tab === "quote" && <QuotePanel {...panel} />}
                {tab === "endorsements" && <EndorsementsPanel {...panel} />}
                {tab === "claims" && <ClaimsPanel {...panel} />}
                {tab === "renewals" && <RenewalsPanel {...panel} />}
              </div>
            );
          })()}

          {tab === "overview" && (<>
          {/* Master Policies */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">{tx("Master Policies (Group Life)")}</p>
              <button
                onClick={() => setShowCreateMP(true)}
                className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
              >
                {tx("+ New Master Policy")}
              </button>
            </div>

            {masterPolicies.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">
                {tx("No master policy yet — create one to start enrolling employees.")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">{tx("Product")}</th>
                      <th className="px-5 py-3 text-left">{tx("Sum Assured Formula")}</th>
                      <th className="px-5 py-3 text-left">{tx("Term")}</th>
                      <th className="px-5 py-3 text-left">{tx("Effective Date")}</th>
                      <th className="px-5 py-3 text-left">{tx("Free Cover Limit")}</th>
                      <th className="px-5 py-3 text-left">{tx("Status")}</th>
                      <th className="px-5 py-3 text-right">{tx("Actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {masterPolicies.map((mp) => (
                      <tr key={mp.id} className={mp.id === selectedMpId ? "bg-blue-50/40" : ""}>
                        <td className="px-5 py-3 text-slate-600">{mp.plan_label ?? tx("Group Life")}{mp.policy_number ? <span className="block text-[11px] font-mono text-slate-400">{mp.policy_number}</span> : null}</td>
                        <td className="px-5 py-3 font-semibold text-slate-800">{mp.sum_assured_multiple}{tx("× monthly basic salary")}</td>
                        <td className="px-5 py-3 text-slate-600">{mp.term_years}{" "}{tx("years")}</td>
                        <td className="px-5 py-3 text-slate-600">{displayDate(mp.effective_date)}</td>
                        <td className="px-5 py-3 text-slate-600">
                          {mp.free_cover_limit != null ? formatPKR(mp.free_cover_limit) : tx("— (set on first census confirm)")}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_STYLE[mp.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                            {mp.status}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right whitespace-nowrap">
                          <button onClick={() => startEditMP(mp)} className="text-xs font-semibold text-blue-600 hover:text-blue-800 mr-3">{tx("Edit")}</button>
                          <button
                            onClick={() => handleDeleteMP(mp)}
                            title={tx("Remove this master policy")}
                            aria-label={tx("Remove this master policy")}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 align-middle"
                          >
                            ✕
                          </button>
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
                <p className="text-sm font-semibold text-slate-700">{tx("Add Employee Census")}</p>
                <select
                  value={selectedMpId}
                  onChange={(e) => setSelectedMpId(e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white"
                >
                  {masterPolicies.map((mp) => (
                    <option key={mp.id} value={mp.id}>
                      {mp.sum_assured_multiple}× · {displayDate(mp.effective_date)} ({mp.status})
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-5 space-y-3">
                <p className="text-xs text-slate-400">
                  {tx("Minimum group size: 10 employees. Coverage per employee = (annual income ÷ 12) × the master policy's sum-assured multiple. Employees at or under the computed Free Cover Limit are guaranteed-issue; above it, they're routed through AI underwriting — Smoker/Height/Weight are optional but improve that scoring beyond the guaranteed-issue defaults (non-smoker, 170cm, 70kg) if left blank.")}
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 uppercase tracking-wider">
                        <th className="pb-2 pr-2">{tx("CNIC")}</th>
                        <th className="pb-2 pr-2">{tx("Full Name")}</th>
                        <th className="pb-2 pr-2">{tx("DOB")}</th>
                        <th className="pb-2 pr-2">{tx("Gender")}</th>
                        <th className="pb-2 pr-2">{tx("Occupation")}</th>
                        <th className="pb-2 pr-2">{tx("Annual Income (PKR)")}</th>
                        <th className="pb-2 pr-2">{tx("Smoker?")}</th>
                        <th className="pb-2 pr-2">{tx("Height (cm)")}</th>
                        <th className="pb-2 pr-2">{tx("Weight (kg)")}</th>
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
                              <p className="text-[10px] text-red-500 mt-0.5 leading-tight">{tx("Invalid format")}</p>
                            )}
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.name} onChange={(e) => updateCensusRow(i, "name", e.target.value)} placeholder={tx("Full name")}
                              className="w-36 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input type="date" value={row.dob} onChange={(e) => updateCensusRow(i, "dob", e.target.value)}
                              className="w-32 bg-slate-50 border border-slate-200 rounded px-2 py-1" />
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <select value={row.gender} onChange={(e) => updateCensusRow(i, "gender", e.target.value)}
                              className="w-24 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                              <option value="Male">{tx("Male")}</option>
                              <option value="Female">{tx("Female")}</option>
                              <option value="Other">{tx("Other")}</option>
                            </select>
                          </td>
                          <td className="pr-2 pb-2 align-top">
                            <input value={row.occupation} onChange={(e) => updateCensusRow(i, "occupation", e.target.value)} placeholder={tx("Job title")}
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
                              <option value="false">{tx("No")}</option>
                              <option value="true">{tx("Yes")}</option>
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
                  {tx("+ Add Row")}
                </button>

                {censusResult && (
                  <div className={`rounded-lg border p-3 text-xs space-y-1 ${
                    censusResult.is_valid ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-amber-50 border-amber-200 text-amber-700"
                  }`}>
                    <p className="font-bold">
                      {censusResult.is_valid ? tx("✓ Census Valid") : tx("⚠ Census has issues")} — {censusResult.total}{" "}{tx("row(s)")}
                    </p>
                    {censusResult.is_valid && censusResult.computed_free_cover_limit != null && (
                      <p>
                        {tx("Computed Free Cover Limit:")}{" "}<span className="font-semibold">{formatPKR(censusResult.computed_free_cover_limit)}</span>{" "}{tx("— employees whose coverage exceeds this are routed to AI underwriting review instead of guaranteed issue.")}
                      </p>
                    )}
                    {censusResult.errors.map((e, i) => <p key={i}>{e}</p>)}
                    {censusResult.duplicate_cnics.length > 0 && <p>{tx("Duplicate CNICs:")}{" "}{censusResult.duplicate_cnics.join(", ")}</p>}
                    {censusResult.missing_fields.map((m, i) => <p key={i}>{m}</p>)}
                  </div>
                )}

                <div className="flex gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button" onClick={handleConfirmCensus} disabled={censusLoading}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/40 rounded-lg transition-colors"
                  >
                    {tx("Confirm & Enroll")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Last Enrollment Result — per-employee outcome from the most recent confirm */}
          {confirmResult && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">{tx("Last Enrollment Result")}</p>
                <span className="text-xs text-slate-500 font-medium">
                  {tx("Free Cover Limit:")}{" "}{formatPKR(confirmResult.free_cover_limit)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">{tx("Coverage")}</th>
                      <th className="px-5 py-3 text-left">{tx("Outcome")}</th>
                      <th className="px-5 py-3 text-right">{tx("Premium (Annual)")}</th>
                      <th className="px-5 py-3 text-right">{tx("Suggested Loading")}</th>
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
                            <span className="ml-2 text-[11px] text-slate-400">{tx("AI-assessed")}</span>
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
              <p className="text-sm font-semibold text-slate-700">{tx("Employee Roster")}</p>
              <span className="text-xs text-slate-400 font-medium">{tx("Total:")}{" "}{employees.length}</span>
            </div>
            {employees.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">{tx("No employees enrolled yet.")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="px-5 py-3 text-left">{tx("CNIC")}</th>
                      <th className="px-5 py-3 text-left">{tx("Full Name")}</th>
                      <th className="px-5 py-3 text-left">{tx("Age / Gender")}</th>
                      <th className="px-5 py-3 text-left">{tx("Occupation")}</th>
                      <th className="px-5 py-3 text-right">{tx("Income")}</th>
                      <th className="px-5 py-3 text-left">{tx("Profile")}</th>
                      <th className="px-5 py-3 text-right">{tx("Actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {employees.map((emp) => {
                      const empCase = employeeCases[emp.id];
                      return (
                        <tr key={emp.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-3 font-medium text-slate-700">{emp.cnic}</td>
                          <td className="px-5 py-3 font-semibold text-slate-800">{emp.name}</td>
                          <td className="px-5 py-3 text-slate-600">
                            {new Date().getFullYear() - new Date(emp.dob).getFullYear()}{" "}{tx("yrs ·")}{" "}{emp.gender}
                          </td>
                          <td className="px-5 py-3 text-slate-600">{emp.occupation}</td>
                          <td className="px-5 py-3 text-right font-semibold text-slate-700">{tx("PKR")}{" "}{emp.declared_income.toLocaleString()}</td>
                          <td className="px-5 py-3">
                            {employeeHasFullDetails(emp) ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                                {tx("Full Details")}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                                {tx("Core Only")}
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-right space-x-3 whitespace-nowrap">
                            <button onClick={() => handleEditEmployee(emp)} className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors">{tx("Edit")}</button>
                            <button onClick={() => handleDeleteEmployee(emp.id, emp.name)} className="text-xs font-bold text-red-600 hover:text-red-800 transition-colors">{tx("Delete")}</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          </>)}
        </>
      )}

      {/* ── CREATE MASTER POLICY MODAL ── */}
      {editingMP && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setEditingMP(null)}>
          <form onSubmit={handleSaveMP} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-sm font-bold text-slate-800">{tx("Edit master policy")}</h3>
            <label className="block text-xs font-semibold text-slate-600">
              {tx("Product")}
              <select value={mpForm.plan} onChange={(e) => setMpForm((f) => ({ ...f, plan: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                {GROUP_PLANS.map((p) => <option key={p.code} value={p.code}>{tx(p.label)}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              {tx("Sum assured multiple (× monthly basic salary)")}
              <input type="number" step="0.1" required value={mpForm.multiple} onChange={(e) => setMpForm((f) => ({ ...f, multiple: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <span className="mt-1 block text-[11px] font-normal text-slate-400">{tx("Must be between 12x and 36x.")}</span>
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              {tx("Term (years)")}
              <input type="number" min="1" max="40" required value={mpForm.term} onChange={(e) => setMpForm((f) => ({ ...f, term: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              {tx("Effective date")}
              <input type="date" required value={mpForm.date} onChange={(e) => setMpForm((f) => ({ ...f, date: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </label>
            <p className="text-[11px] text-slate-400">{tx("Terms can only be edited before any employee is enrolled. Otherwise remove the policy and create it again.")}</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingMP(null)} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">{tx("Cancel")}</button>
              <button type="submit" disabled={mpBusy} className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {mpBusy ? tx("Saving…") : tx("Save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {showCreateMP && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-6 space-y-4 my-8">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">{tx("New Master Policy")}</h3>
              <button onClick={() => setShowCreateMP(false)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <form onSubmit={handleCreateMasterPolicy} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">{tx("Product *")}</label>
                <select value={planCode} onChange={(e) => setPlanCode(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                  {GROUP_PLANS.map((p) => <option key={p.code} value={p.code}>{tx(p.label)}</option>)}
                </select>
                {planCode === "GROUP_CREDIT_LIFE" && (
                  <p className="text-[11px] text-slate-400">{tx("Credit life: cover follows each borrower's outstanding loan — add a class with the “Outstanding loan balance” basis and give a loan_amount column in the census.")}</p>
                )}
                {planCode === "GROUP_FAMILY_TAKAFUL" && (
                  <p className="text-[11px] text-slate-400">{tx("Takaful: the employer pays a contribution, split between the Wakala fee and the Participants' Takaful Fund.")}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">{tx("Sum Assured Multiple (× monthly basic salary) *")}</label>
                <input
                  type="number" step="0.1" required value={sumAssuredMultiple} onChange={(e) => setSumAssuredMultiple(e.target.value)}
                  placeholder="24"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                />
                <p className="text-[11px] text-slate-400">{tx("Must be between 12x and 36x.")}</p>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">{tx("Term (Years) *")}</label>
                <input type="number" required value={termYears} onChange={(e) => setTermYears(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-600">{tx("Effective Date *")}</label>
                <input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
              </div>
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setShowCreateMP(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  {tx("Cancel")}
                </button>
                <button type="submit" disabled={mpFormLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                  {mpFormLoading ? tx("Creating...") : tx("Create Master Policy")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── EDIT EMPLOYEE MODAL (Full Details, same modules as an individual customer) ── */}
      {editingEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden my-8">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
              <div>
                <h3 className="text-base font-bold text-slate-900">{tx("Edit Employee —")}{" "}{editingEmployee.name}</h3>
                <p className="text-xs text-slate-500 mt-0.5">{tx("Same profile modules as an individual customer, feeds underwriting the same way.")}</p>
              </div>
              <button onClick={() => setEditingEmployee(null)} className="text-slate-400 hover:text-slate-600 transition-colors">✕</button>
            </div>

            <div className="px-6 border-b border-slate-100 bg-white flex flex-wrap gap-1 shrink-0">
              {editEmpTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setEditEmpTab(tab.id)}
                  className={`px-3.5 py-2.5 text-xs font-semibold border-b-2 transition-all ${editEmpTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-400 hover:text-slate-600"
                    }`}
                >
                  {tx(tab.label)}
                </button>
              ))}
            </div>

            <form id="edit-employee-form" onSubmit={handleSaveEmployee} className="flex-1 overflow-y-auto p-6 space-y-4">

              {editEmpTab === "core" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("CNIC *")}</label>
                    <input type="text" required value={editEmpForm.cnic || ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, cnic: formatCNIC(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Full Name *")}</label>
                    <input type="text" required value={editEmpForm.name || ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, name: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("DOB *")}</label>
                      <input type="date" required value={editEmpForm.dob || ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, dob: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Gender *")}</label>
                      <select required value={editEmpForm.gender || "Male"} onChange={(e) => setEditEmpForm({ ...editEmpForm, gender: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Male">{tx("Male")}</option>
                        <option value="Female">{tx("Female")}</option>
                        <option value="Other">{tx("Other")}</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Occupation *")}</label>
                    <input type="text" required value={editEmpForm.occupation || ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, occupation: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Annual Income *")}</label>
                    <input type="number" required value={editEmpForm.declared_income || ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, declared_income: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Smoker?")}</label>
                      <select value={editEmpForm.is_smoker ? "true" : "false"} onChange={(e) => setEditEmpForm({ ...editEmpForm, is_smoker: e.target.value === "true" })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="false">{tx("No")}</option>
                        <option value="true">{tx("Yes")}</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Height (cm)")}</label>
                      <input type="number" value={editEmpForm.height_cm ?? ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, height_cm: parseFloat(e.target.value) || undefined })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Weight (kg)")}</label>
                      <input type="number" value={editEmpForm.weight_kg ?? ""} onChange={(e) => setEditEmpForm({ ...editEmpForm, weight_kg: parseFloat(e.target.value) || undefined })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                  </div>
                </div>
              )}

              {editEmpTab === "address" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Street Address")}</label>
                      <input type="text" value={editEmpDetails.address.street_address} onChange={(e) => updateEmpDetailField("address", "street_address", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Area")}</label>
                      <input type="text" value={editEmpDetails.address.area} onChange={(e) => updateEmpDetailField("address", "area", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("City")}</label>
                      <input type="text" value={editEmpDetails.address.city} onChange={(e) => updateEmpDetailField("address", "city", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Province")}</label>
                      <input type="text" value={editEmpDetails.address.province} onChange={(e) => updateEmpDetailField("address", "province", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Postal Code")}</label>
                      <input type="text" value={editEmpDetails.address.postal_code} onChange={(e) => updateEmpDetailField("address", "postal_code", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                  </div>
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Mobile Number")}</label>
                      <input type="text" value={editEmpDetails.contact.mobile_number} onChange={(e) => updateEmpDetailField("contact", "mobile_number", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Email")}</label>
                      <input type="email" value={editEmpDetails.contact.email} onChange={(e) => updateEmpDetailField("contact", "email", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Emergency Contact Name")}</label>
                      <input type="text" value={editEmpDetails.contact.emergency_contact_name} onChange={(e) => updateEmpDetailField("contact", "emergency_contact_name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Emergency Contact Phone")}</label>
                      <input type="text" value={editEmpDetails.contact.emergency_contact_phone} onChange={(e) => updateEmpDetailField("contact", "emergency_contact_phone", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                  </div>
                </div>
              )}

              {editEmpTab === "cnic_metadata" && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("CNIC Issue Date")}</label>
                    <input type="date" value={editEmpDetails.cnic_metadata.issue_date} onChange={(e) => updateEmpDetailField("cnic_metadata", "issue_date", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("CNIC Expiry Date")}</label>
                    <input type="date" value={editEmpDetails.cnic_metadata.expiry_date} onChange={(e) => updateEmpDetailField("cnic_metadata", "expiry_date", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                </div>
              )}

              {editEmpTab === "occupation_details" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Job Title")}</label>
                      <input type="text" value={editEmpDetails.occupation_details.job_title} onChange={(e) => updateEmpDetailField("occupation_details", "job_title", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Employer Name")}</label>
                      <input type="text" value={editEmpDetails.occupation_details.employer_name} onChange={(e) => updateEmpDetailField("occupation_details", "employer_name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Employment Type")}</label>
                      <select value={editEmpDetails.occupation_details.employment_type} onChange={(e) => updateEmpDetailField("occupation_details", "employment_type", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Salaried">{tx("Salaried")}</option>
                        <option value="Self-Employed">{tx("Self-Employed")}</option>
                        <option value="Business Owner">{tx("Business Owner")}</option>
                        <option value="Unemployed">{tx("Unemployed")}</option>
                        <option value="Retired">{tx("Retired")}</option>
                        <option value="Student">{tx("Student")}</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Occupation Hazard Level")}</label>
                      <select value={editEmpDetails.occupation_details.occupation_hazard_level} onChange={(e) => updateEmpDetailField("occupation_details", "occupation_hazard_level", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Low">{tx("Low")}</option>
                        <option value="Medium">{tx("Medium")}</option>
                        <option value="High">{tx("High")}</option>
                      </select>
                    </div>
                  </div>
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Monthly Income (PKR)")}</label>
                      <input type="number" value={editEmpDetails.income_record.monthly_income} onChange={(e) => updateEmpDetailField("income_record", "monthly_income", parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Income Source")}</label>
                      <select value={editEmpDetails.income_record.income_source} onChange={(e) => updateEmpDetailField("income_record", "income_source", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Salary">{tx("Salary")}</option>
                        <option value="Business">{tx("Business")}</option>
                        <option value="Investments">{tx("Investments")}</option>
                        <option value="Rental">{tx("Rental")}</option>
                        <option value="Other">{tx("Other")}</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {editEmpTab === "medical_history" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    {(["has_pre_existing_conditions", "is_diabetic", "has_hypertension", "has_heart_disease"] as const).map((key) => (
                      <label key={key} className="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <input type="checkbox" checked={!!editEmpDetails.medical_history[key]} onChange={(e) => updateEmpDetailField("medical_history", key, e.target.checked)} />
                        {key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
                      </label>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Surgical History")}</label>
                    <textarea value={editEmpDetails.medical_history.surgical_history} onChange={(e) => updateEmpDetailField("medical_history", "surgical_history", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" rows={2} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Medical Notes")}</label>
                    <textarea value={editEmpDetails.medical_history.notes} onChange={(e) => updateEmpDetailField("medical_history", "notes", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" rows={2} />
                  </div>
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Smoking Status")}</label>
                      <select value={editEmpDetails.lifestyle.smoking_status} onChange={(e) => updateEmpDetailField("lifestyle", "smoking_status", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="NonSmoker">{tx("Non-Smoker")}</option>
                        <option value="Smoker">{tx("Smoker")}</option>
                        <option value="FormerSmoker">{tx("Former Smoker")}</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Alcohol Status")}</label>
                      <select value={editEmpDetails.lifestyle.alcohol_status} onChange={(e) => updateEmpDetailField("lifestyle", "alcohol_status", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="None">{tx("None")}</option>
                        <option value="Occasional">{tx("Occasional")}</option>
                        <option value="Regular">{tx("Regular")}</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Exercise Frequency")}</label>
                      <select value={editEmpDetails.lifestyle.exercise_frequency} onChange={(e) => updateEmpDetailField("lifestyle", "exercise_frequency", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Sedentary">{tx("Sedentary")}</option>
                        <option value="Light">{tx("Light")}</option>
                        <option value="Moderate">{tx("Moderate")}</option>
                        <option value="Active">{tx("Active")}</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Diet Type")}</label>
                      <select value={editEmpDetails.lifestyle.diet_type} onChange={(e) => updateEmpDetailField("lifestyle", "diet_type", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                        <option value="Regular">{tx("Regular")}</option>
                        <option value="Vegetarian">{tx("Vegetarian")}</option>
                        <option value="Vegan">{tx("Vegan")}</option>
                      </select>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                    <input type="checkbox" checked={!!editEmpDetails.lifestyle.has_hazardous_hobby} onChange={(e) => updateEmpDetailField("lifestyle", "has_hazardous_hobby", e.target.checked)} />
                    {tx("Has a hazardous hobby")}
                  </label>
                  {editEmpDetails.lifestyle.has_hazardous_hobby && (
                    <input type="text" value={editEmpDetails.lifestyle.hazardous_hobby_details} onChange={(e) => updateEmpDetailField("lifestyle", "hazardous_hobby_details", e.target.value)}
                      placeholder={tx("e.g. Skydiving, scuba diving")}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  )}
                </div>
              )}

              {editEmpTab === "habit_check" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Alcohol Consumption Frequency")}</label>
                    <select value={editEmpDetails.habit_check.alcohol_consumption_frequency} onChange={(e) => updateEmpDetailField("habit_check", "alcohol_consumption_frequency", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                      <option value="None">{tx("None")}</option>
                      <option value="Occasional">{tx("Occasional")}</option>
                      <option value="Regular">{tx("Regular")}</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(["recreational_drug_use_history", "participates_in_extreme_sports", "frequent_high_risk_travel", "dui_dwi_history", "criminal_record"] as const).map((key) => (
                      <label key={key} className="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <input type="checkbox" checked={!!editEmpDetails.habit_check[key]} onChange={(e) => updateEmpDetailField("habit_check", key, e.target.checked)} />
                        {key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {editEmpTab === "financial_records" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Bank Name")}</label>
                      <input type="text" value={editEmpDetails.financial_records.bank_statement.bank_name} onChange={(e) => updateEmpDetailSubField("financial_records", "bank_statement", "bank_name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Average Monthly Balance (PKR)")}</label>
                      <input type="number" value={editEmpDetails.financial_records.bank_statement.average_monthly_balance} onChange={(e) => updateEmpDetailSubField("financial_records", "bank_statement", "average_monthly_balance", parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Credit Score")}</label>
                      <input type="number" value={editEmpDetails.financial_records.credit_bureau.credit_score} onChange={(e) => updateEmpDetailSubField("financial_records", "credit_bureau", "credit_score", parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-600">{tx("Risk Grade")}</label>
                      <select value={editEmpDetails.financial_records.credit_bureau.risk_grade} onChange={(e) => updateEmpDetailSubField("financial_records", "credit_bureau", "risk_grade", e.target.value)}
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

              {editEmpTab === "beneficiary" && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Nominee First Name")}</label>
                    <input type="text" value={editEmpDetails.beneficiary.first_name} onChange={(e) => updateEmpDetailField("beneficiary", "first_name", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Nominee Last Name")}</label>
                    <input type="text" value={editEmpDetails.beneficiary.last_name} onChange={(e) => updateEmpDetailField("beneficiary", "last_name", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Nominee CNIC")}</label>
                    <input type="text" value={editEmpDetails.beneficiary.cnic_number} onChange={(e) => updateEmpDetailField("beneficiary", "cnic_number", formatCNIC(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Relationship to Nominee")}</label>
                    <select value={editEmpDetails.beneficiary.relationship} onChange={(e) => updateEmpDetailField("beneficiary", "relationship", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                      <option value="Spouse">{tx("Spouse")}</option>
                      <option value="Child">{tx("Child")}</option>
                      <option value="Parent">{tx("Parent")}</option>
                      <option value="Sibling">{tx("Sibling")}</option>
                      <option value="Other">{tx("Other")}</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Share Percentage")}</label>
                    <input type="number" min="0" max="100" value={editEmpDetails.beneficiary.share_percentage} onChange={(e) => updateEmpDetailField("beneficiary", "share_percentage", parseFloat(e.target.value) || 0)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-600">{tx("Nominee Phone")}</label>
                    <input type="text" value={editEmpDetails.beneficiary.phone} onChange={(e) => updateEmpDetailField("beneficiary", "phone", e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
                  </div>
                </div>
              )}
            </form>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100 bg-slate-50 shrink-0">
              <button type="button" onClick={() => setEditingEmployee(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-white transition-colors">
                {tx("Cancel")}
              </button>
              <button type="submit" form="edit-employee-form" disabled={empFormLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 rounded-lg transition-colors">
                {empFormLoading ? tx("Saving...") : tx("Save Changes")}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
