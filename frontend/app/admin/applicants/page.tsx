"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";
import { listInsurancePlans, InsurancePlan } from "@/app/services/insurancePlans";
import { registerPendingQuote } from "@/lib/pendingQuotes";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

const applicantCoreSchema = z.object({
  cnic: z.string().trim().regex(/^\d{5}-\d{7}-\d{1}$/, "Format: XXXXX-XXXXXXX-X"),
  firstName: z.string().min(2, "Required").regex(/^[A-Za-z\s]+$/, "Only alphabets and spaces allowed"),
  lastName: z.string().min(2, "Required").regex(/^[A-Za-z\s]+$/, "Only alphabets and spaces allowed"),
  dob: z.string().min(1, "Required"),
  gender: z.enum(["Male", "Female", "Other"]),
  maritalStatus: z.enum(["Single", "Married", "Divorced", "Widowed"]),
  nationality: z.string().min(2, "Required"),
  occupation: z.string().min(2, "Required").regex(/^[A-Za-z\s]+$/, "Only alphabets and spaces allowed"),
  declaredIncome: z.coerce.number().min(0, "Must be positive"),
  selectedPlanId: z.string().optional(),
  policyCoverage: z.coerce.number().optional(),
  policyTerm: z.coerce.number().optional(),
  policyDependentName: z.string().regex(/^[A-Za-z\s]*$/, "Only alphabets and spaces allowed").optional(),
  policyDependentDob: z.string().optional(),
});

interface Applicant {
  id: string;
  tenant_id: string;
  cnic: string;
  name: string;
  dob: string;
  gender: string;
  occupation: string;
  declared_income: number;
  created_at: string;
  details?: any;
}

interface Policy {
  id: string;
  tenant_id: string;
  applicant_id: string;
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

const formatCNIC = (value: string): string => {
  const clean = value.replace(/\D/g, "");
  const trimmed = clean.slice(0, 13);
  if (trimmed.length <= 5) {
    return trimmed;
  } else if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 5)}-${trimmed.slice(5)}`;
  } else {
    return `${trimmed.slice(0, 5)}-${trimmed.slice(5, 12)}-${trimmed.slice(12)}`;
  }
};

export default function ApplicantsPage() {
  const router = useRouter();
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [latestPlans, setLatestPlans] = useState<Record<string, Policy | null>>({});
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedApplicant, setSelectedApplicant] = useState<Applicant | null>(null);

  // Tab State
  const [formTab, setFormTab] = useState("demographics");
  const [viewTab, setViewTab] = useState("demographics");

  const {
    register,
    handleSubmit: hookFormSubmit,
    formState: { errors },
    reset,
    watch,
    setValue,
  } = useForm<z.infer<typeof applicantCoreSchema>>({
    resolver: zodResolver(applicantCoreSchema),
    mode: "onChange",
    defaultValues: {
      gender: "Male",
      maritalStatus: "Single",
      nationality: "Pakistani",
      selectedPlanId: "",
    }
  });
  const formValues = watch();
  const { selectedPlanId, policyCoverage, policyTerm, policyDependentName, policyDependentDob } = formValues;

  const [formLoading, setFormLoading] = useState(false);

  // Insurance Plan Selection (create modal only)
  const [availablePlans, setAvailablePlans] = useState<InsurancePlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [isSuggestingPlan, setIsSuggestingPlan] = useState(false);
  const [suggestedReasoning, setSuggestedReasoning] = useState("");

  // Applicant policies (view + edit modals)
  const [applicantPolicies, setApplicantPolicies] = useState<Policy[]>([]);
  const [viewPoliciesLoading, setViewPoliciesLoading] = useState(false);
  // Edit modal — adding a new policy
  const [editSelectedPlanId, setEditSelectedPlanId] = useState<string>("");
  const [editPolicyCoverage, setEditPolicyCoverage] = useState("");
  const [editPolicyTerm, setEditPolicyTerm] = useState("");
  const [editPolicyDependentName, setEditPolicyDependentName] = useState("");
  const [editPolicyDependentDob, setEditPolicyDependentDob] = useState("");
  const [editAddingPolicy, setEditAddingPolicy] = useState(false);
  const [editPolicyLoading, setEditPolicyLoading] = useState(false);

  // Extended sections (18 sections matching PDF Spec)
  const defaultDetails = {
    cnic_metadata: {
      issue_date: "",
      expiry_date: "",
      is_valid: true,
      validation_status: "Valid",
      validated_at: "",
      front_image_url: "",
      back_image_url: "",
      ocr_extracted: false
    },
    address: {
      address_type: "Residential",
      street_address: "",
      area: "",
      city: "",
      district: "",
      province: "",
      country: "Pakistan",
      postal_code: "",
      is_primary: true,
      is_verified: false
    },
    contact: {
      mobile_number: "",
      phone_number: "",
      email: "",
      is_primary: true,
      is_verified: false,
      emergency_contact_name: "",
      emergency_contact_phone: "",
      emergency_contact_relation: ""
    },
    occupation_details: {
      job_title: "",
      employer_name: "",
      industry: "",
      employment_type: "Salaried",
      years_of_experience: 0,
      occupation_hazard_level: "Low",
      work_address: "",
      is_current: true,
      start_date: "",
      end_date: ""
    },
    income_record: {
      monthly_income: 0,
      annual_income: 0,
      declared_income: 0,
      verified_income: 0,
      income_source: "Salary",
      currency: "PKR",
      income_stability_score: 100,
      discrepancy_flag: false,
      is_verified: false
    },
    beneficiary: {
      first_name: "",
      last_name: "",
      cnic_number: "",
      date_of_birth: "",
      relationship: "Spouse",
      share_percentage: 100,
      phone: "",
      email: "",
      address: "",
      is_minor: false,
      guardian_name: "",
      guardian_cnic: "",
      is_active: true
    },
    medical_history: {
      has_pre_existing_conditions: false,
      is_smoker: false,
      is_diabetic: false,
      has_hypertension: false,
      has_heart_disease: false,
      surgical_history: "",
      notes: ""
    },
    conditions: [] as any[],
    family_history: [] as any[],
    lifestyle: {
      smoking_status: "NonSmoker",
      packs_per_day: 0,
      smoking_years: 0,
      quit_smoking_date: "",
      alcohol_status: "None",
      units_per_week: 0,
      height_cm: 0,
      weight_kg: 0,
      bmi: 0,
      exercise_frequency: "Sedentary",
      diet_type: "Regular",
      has_hazardous_hobby: false,
      hazardous_hobby_details: "",
      occupation_hazard_level: "Low"
    },
    financial_records: {
      tax_records: [] as any[],
      bank_statement: {
        bank_name: "",
        average_monthly_balance: 0,
        transaction_volume: 0,
        income_credits: 0,
        expense_debits: 0,
        cash_flow_score: 100,
        anomaly_flag: false
      },
      debts: [] as any[],
      credit_bureau: {
        credit_score: 750,
        credit_history_length: 0,
        delinquency_count: 0,
        default_history: false,
        inquiry_count: 0,
        risk_grade: "A",
        bureau_name: ""
      },
      external_policies: [] as any[],
      dependents: {
        dependent_type: "Child",
        number_of_dependents: 0,
        financial_burden_score: 0,
        dependency_ratio: 0
      }
    },
    habit_check: {
      smoking_status: "Non-smoker",
      alcohol_consumption_frequency: "None",
      recreational_drug_use_history: false,
      participates_in_extreme_sports: false,
      extreme_sports_details: [] as string[],
      private_aviation: false,
      frequent_high_risk_travel: false,
      travel_destinations: [] as string[],
      moving_violations_past_3_years: 0,
      dui_dwi_history: false,
      criminal_record: false
    }
  };

  const [details, setDetails] = useState<typeof defaultDetails>(defaultDetails);
  const [newDestination, setNewDestination] = useState("");

  // Sub-record helpers for lists
  const [newCondition, setNewCondition] = useState({ condition_name: "", severity: "Mild", diagnosis_date: "", is_chronic: false });
  const [newFamilyHistory, setNewFamilyHistory] = useState({ relation: "Father", age: "", is_alive: true, condition_name: "" });

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "Admin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    fetchApplicants();
  }, []);

  const fetchApplicants = async () => {
    setLoading(true);
    setError("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active organization tenant found.");
      setLoading(false);
      return;
    }
    try {
      const resp = await api.get<Applicant[]>(`/tenants/${tenantId}/applicants`);
      setApplicants(resp.data);
      fetchLatestPlans(tenantId, resp.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load applicants directory.");
    } finally {
      setLoading(false);
    }
  };

  const fetchLatestPlans = async (tenantId: string, forApplicants: Applicant[]) => {
    const results = await Promise.allSettled(
      forApplicants.map((a) => api.get<Policy[]>(`/tenants/${tenantId}/applicants/${a.id}/policies`))
    );
    const plans: Record<string, Policy | null> = {};
    results.forEach((result, i) => {
      plans[forApplicants[i].id] =
        result.status === "fulfilled" && result.value.data.length > 0 ? result.value.data[0] : null;
    });
    setLatestPlans(plans);
  };

  const handleOpenCreateModal = async () => {
    reset({
      cnic: "",
      firstName: "",
      lastName: "",
      dob: "",
      gender: "Male",
      maritalStatus: "Single",
      nationality: "Pakistani",
      occupation: "",
      declaredIncome: undefined,
      selectedPlanId: "",
      policyCoverage: undefined,
      policyTerm: undefined,
      policyDependentName: "",
      policyDependentDob: ""
    });
    setDetails(JSON.parse(JSON.stringify(defaultDetails)));
    setFormTab("demographics");
    setError("");
    setSuccess("");
    setSuggestedReasoning("");
    // Fetch available plans
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) {
      setPlansLoading(true);
      try {
        const plans = await listInsurancePlans(tenantId);
        setAvailablePlans(plans.filter((p) => p.is_active));
      } catch {
        setAvailablePlans([]);
      } finally {
        setPlansLoading(false);
      }
    }
    setShowCreateModal(true);
  };

  const handleSuggestPlan = async () => {
    if (availablePlans.length === 0) return;
    setIsSuggestingPlan(true);
    setSuggestedReasoning("");
    setError("");

    try {
      const applicantData = {
        ...formValues,
        ...details,
        // Calculate age for the LLM based on DOB
        age: formValues.dob ? new Date().getFullYear() - new Date(formValues.dob).getFullYear() : 30
      };
      
      const res = await api.post(`/suggest-plan`, {
        applicant: applicantData,
        plans: availablePlans
      });
      const data = res.data;
      
      setValue("selectedPlanId", data.suggested_plan_id);
      setValue("policyCoverage", data.suggested_coverage);
      setValue("policyTerm", data.suggested_term);
      setSuggestedReasoning(data.reasoning);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to suggest plan.");
    } finally {
      setIsSuggestingPlan(false);
    }
  };

  const handleCreateApplicant = async (data: z.infer<typeof applicantCoreSchema>) => {
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError("No active tenant found.");
      setFormLoading(false);
      return;
    }

    try {
      // Sync top-level fields into details structure
      const payloadDetails = {
        ...details,
        income_record: {
          ...details.income_record,
          declared_income: data.declaredIncome,
          annual_income: data.declaredIncome
        }
      };

      const applicantResp = await api.post<Applicant>(`/tenants/${tenantId}/applicants`, {
        cnic: data.cnic,
        first_name: data.firstName,
        last_name: data.lastName,
        date_of_birth: data.dob,
        gender: data.gender,
        marital_status: data.maritalStatus,
        nationality: data.nationality,
        occupation: data.occupation,
        declared_income: data.declaredIncome,
        is_smoker: !!payloadDetails.medical_history.is_smoker,
        height_cm: parseFloat(payloadDetails.lifestyle.height_cm as any) || 170.0,
        weight_kg: parseFloat(payloadDetails.lifestyle.weight_kg as any) || 70.0,
        details: payloadDetails
      });

      // If a plan was selected, create the policy for this applicant
      if (data.selectedPlanId && data.policyCoverage && data.policyTerm) {
        const selectedPlan = availablePlans.find((p) => p.id === data.selectedPlanId);
        if (selectedPlan) {
          const policyPayload: any = {
            product_name: selectedPlan.label,
            insurance_type: selectedPlan.insurance_type,
            coverage_amount: data.policyCoverage,
            term_years: data.policyTerm,
          };
          if (selectedPlan.insurance_type === "CHILD_EDUCATION_MARRIAGE") {
            policyPayload.dependent_name = data.policyDependentName || null;
            policyPayload.dependent_dob = data.policyDependentDob || null;
          }
          await api.post(
            `/tenants/${tenantId}/applicants/${applicantResp.data.id}/policies`,
            policyPayload
          );
        }
      }

      setSuccess("Applicant registered successfully with full diagnostic profile!");
      setShowCreateModal(false);
      registerPendingQuote(applicantResp.data.id, applicantResp.data.name);
      fetchApplicants();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to register applicant.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleOpenEditModal = async (applicant: Applicant) => {
    setSelectedApplicant(applicant);
    const parts = applicant.name.split(" ");
    reset({
      cnic: applicant.cnic,
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" ") || "",
      dob: applicant.dob,
      gender: applicant.gender as any,
      occupation: applicant.occupation,
      declaredIncome: applicant.declared_income,
      maritalStatus: applicant.details?.marital_status || "Single",
      nationality: applicant.details?.nationality || "Pakistani",
    });

    // Import existing details or fill defaults
    const importedDetails = applicant.details
      ? { 
          ...JSON.parse(JSON.stringify(defaultDetails)), 
          ...applicant.details,
          habit_check: {
            ...JSON.parse(JSON.stringify(defaultDetails)).habit_check,
            ...(applicant.details.habit_check || {})
          }
        }
      : JSON.parse(JSON.stringify(defaultDetails));

    setDetails(importedDetails);
    setFormTab("demographics");
    setError("");
    setSuccess("");

    // Reset edit-policy add form
    setEditSelectedPlanId("");
    setEditPolicyCoverage("");
    setEditPolicyTerm("");
    setEditPolicyDependentName("");
    setEditPolicyDependentDob("");
    setEditAddingPolicy(false);

    // Fetch existing policies
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) {
      setViewPoliciesLoading(true);
      try {
        const [polRes, plansRes] = await Promise.all([
          api.get(`/tenants/${tenantId}/applicants/${applicant.id}/policies`),
          listInsurancePlans(tenantId),
        ]);
        setApplicantPolicies(polRes.data ?? []);
        setAvailablePlans((plansRes ?? []).filter((p: InsurancePlan) => p.status === "Active"));
      } catch {
        setApplicantPolicies([]);
      } finally {
        setViewPoliciesLoading(false);
      }
    }

    setShowEditModal(true);
  };

  const handleEditApplicant = async (data: z.infer<typeof applicantCoreSchema>) => {
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || !selectedApplicant) {
      setError("No active context found.");
      setFormLoading(false);
      return;
    }

    try {
      const payloadDetails = {
        ...details,
        income_record: {
          ...details.income_record,
          declared_income: data.declaredIncome,
          annual_income: data.declaredIncome
        }
      };

      await api.put(`/tenants/${tenantId}/applicants/${selectedApplicant.id}`, {
        cnic: data.cnic,
        first_name: data.firstName,
        last_name: data.lastName,
        date_of_birth: data.dob,
        gender: data.gender,
        occupation: data.occupation,
        declared_income: data.declaredIncome,
        is_smoker: !!payloadDetails.medical_history.is_smoker,
        height_cm: parseFloat(payloadDetails.lifestyle.height_cm as any) || 170.0,
        weight_kg: parseFloat(payloadDetails.lifestyle.weight_kg as any) || 70.0,
        details: payloadDetails
      });

      setSuccess("Applicant updated successfully!");
      setShowEditModal(false);
      fetchApplicants();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update applicant.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteApplicant = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete applicant "${name}"?`)) return;
    setError("");
    setSuccess("");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/applicants/${id}`);
      setSuccess(`Applicant "${name}" deleted.`);
      fetchApplicants();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to delete applicant.");
    }
  };

  const handleOpenProfileModal = async (applicant: Applicant) => {
    setSelectedApplicant(applicant);
    const importedDetails = applicant.details
      ? { 
          ...JSON.parse(JSON.stringify(defaultDetails)), 
          ...applicant.details,
          habit_check: {
            ...JSON.parse(JSON.stringify(defaultDetails)).habit_check,
            ...(applicant.details.habit_check || {})
          }
        }
      : JSON.parse(JSON.stringify(defaultDetails));
    setDetails(importedDetails);
    setViewTab("demographics");
    setShowProfileModal(true);

    // Fetch this applicant's policies
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) {
      setViewPoliciesLoading(true);
      try {
        const res = await api.get(`/tenants/${tenantId}/applicants/${applicant.id}/policies`);
        setApplicantPolicies(res.data ?? []);
      } catch {
        setApplicantPolicies([]);
      } finally {
        setViewPoliciesLoading(false);
      }
    }
  };

  // BMI calculator
  const calculateBMI = (height: number, weight: number) => {
    if (!height || !weight) return 0;
    const hMeter = height / 100;
    return parseFloat((weight / (hMeter * hMeter)).toFixed(1));
  };

  // Nested property state mutation
  const updateField = (section: keyof typeof defaultDetails, key: string, value: any) => {
    setDetails((prev) => {
      const updatedSection = { ...prev[section], [key]: value };
      // Auto calculate BMI if lifestyle heights change
      if (section === "lifestyle" && (key === "height_cm" || key === "weight_kg")) {
        const h = key === "height_cm" ? parseFloat(value) : (prev.lifestyle as any).height_cm;
        const w = key === "weight_kg" ? parseFloat(value) : (prev.lifestyle as any).weight_kg;
        (updatedSection as any).bmi = calculateBMI(h, w);
      }
      return { ...prev, [section]: updatedSection };
    });
  };

  const updateSubField = (section: keyof typeof defaultDetails, sub: string, key: string, value: any) => {
    setDetails((prev: any) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [sub]: {
          ...prev[section][sub],
          [key]: value
        }
      }
    }));
  };

  // List pushers
  const addCondition = () => {
    if (!newCondition.condition_name) return;
    setDetails((prev) => ({
      ...prev,
      conditions: [...prev.conditions, newCondition]
    }));
    setNewCondition({ condition_name: "", severity: "Mild", diagnosis_date: "", is_chronic: false });
  };

  const addFamilyHistory = () => {
    setDetails((prev) => ({
      ...prev,
      family_history: [...prev.family_history, newFamilyHistory]
    }));
    setNewFamilyHistory({ relation: "Father", age: "", is_alive: true, condition_name: "" });
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

  const tabs = [
    { id: "demographics", label: "Identity & Contact" },
    { id: "cnic", label: "CNIC & Docs" },
    { id: "employment", label: "Occupation & Income" },
    { id: "medical", label: "Medical & Lifestyle" },
    { id: "habit_check", label: "Habit Check" },
    { id: "financial", label: "Financial Profile" },
    { id: "beneficiary", label: "Nominee Details" },
    { id: "insurance_plan", label: "Insurance Plans" }
  ];

  const createTabs = tabs;

  const PLAN_TYPE_COLORS: Record<string, string> = {
    TERM_LIFE: "border-blue-400 bg-blue-50",
    WHOLE_LIFE: "border-violet-400 bg-violet-50",
    ENDOWMENT: "border-amber-400 bg-amber-50",
    CHILD_EDUCATION_MARRIAGE: "border-emerald-400 bg-emerald-50",
    GROUP_LIFE: "border-indigo-400 bg-indigo-50",
    SAVINGS: "border-amber-400 bg-amber-50",
    SINGLE_PREMIUM: "border-violet-400 bg-violet-50",
    HEALTH_CASH: "border-rose-400 bg-rose-50",
  };
  const PLAN_TYPE_TEXT: Record<string, string> = {
    TERM_LIFE: "text-blue-700",
    WHOLE_LIFE: "text-violet-700",
    ENDOWMENT: "text-amber-700",
    CHILD_EDUCATION_MARRIAGE: "text-emerald-700",
    GROUP_LIFE: "text-indigo-700",
    SAVINGS: "text-amber-700",
    SINGLE_PREMIUM: "text-violet-700",
    HEALTH_CASH: "text-rose-700",
  };

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full font-sans">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Applicant Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Admin console to configure full multi-module diagnostic profile attributes for underwriting evaluation.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={() => router.push("/plans")}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-all shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="13" y2="17" />
            </svg>
            Insurance Plans
          </button>
          <button
            onClick={handleOpenCreateModal}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm hover:shadow active:scale-95"
          >
            Add Applicant
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">{error}</div>}
      {success && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-600 font-medium">{success}</div>}

      {/* Directory Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2">
            <div className="animate-spin h-7 w-7 text-blue-500 rounded-full border-2 border-slate-100 border-t-blue-500" />
            <span className="text-xs text-slate-400">Loading Directory...</span>
          </div>
        ) : applicants.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <p className="text-sm">No applicants registered in this tenant.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3 text-left">CNIC</th>
                  <th className="px-5 py-3 text-left">Full Name</th>
                  <th className="px-5 py-3 text-left">Age / Gender</th>
                  <th className="px-5 py-3 text-left">Occupation</th>
                  <th className="px-5 py-3 text-right">Income</th>
                  <th className="px-5 py-3 text-left">Plan</th>
                  <th className="px-5 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {applicants.map((applicant) => {
                  const plan = latestPlans[applicant.id];
                  return (
                  <tr key={applicant.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 font-medium text-slate-700">{applicant.cnic}</td>
                    <td className="px-5 py-3.5 font-semibold text-slate-800">{applicant.name}</td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {new Date().getFullYear() - new Date(applicant.dob).getFullYear()} yrs · {applicant.gender}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">{applicant.occupation}</td>
                    <td className="px-5 py-3.5 text-right font-semibold text-slate-700">
                      PKR {applicant.declared_income.toLocaleString()}
                    </td>
                    <td className="px-5 py-3.5">
                      {plan === undefined ? (
                        <span className="text-xs text-slate-300">…</span>
                      ) : plan ? (
                        <Link
                          href={`/admin/applicants/${applicant.id}/plans`}
                          className="inline-flex px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-100 hover:bg-blue-100 transition-colors"
                        >
                          {INSURANCE_TYPE_LABELS[plan.insurance_type] ?? plan.insurance_type}
                        </Link>
                      ) : (
                        <span className="text-xs text-slate-400">No plan yet</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center whitespace-nowrap">
                      <div className="inline-flex rounded-lg shadow-sm border border-slate-200 overflow-hidden divide-x divide-slate-200">
                        <button
                          onClick={() => handleOpenProfileModal(applicant)}
                          className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 transition-colors"
                        >
                          View
                        </button>
                        <button
                          onClick={() => handleOpenEditModal(applicant)}
                          className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteApplicant(applicant.id, applicant.name)}
                          className="px-3 py-1.5 text-xs font-semibold text-red-600 bg-white hover:bg-red-50 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CREATE / EDIT MODAL ── */}
      {(showCreateModal || showEditModal) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div>
                <h3 className="text-base font-bold text-slate-900">{showCreateModal ? "Add New Applicant Profile" : "Edit Applicant Profile"}</h3>
                <p className="text-xs text-slate-500 mt-0.5">Please populate the structured underwriting variables below.</p>
              </div>
              <button
                onClick={() => { setShowCreateModal(false); setShowEditModal(false); }}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            {/* Tab navigation */}
            <div className="px-6 border-b border-slate-100 bg-white flex flex-wrap gap-1">
              {(showCreateModal ? createTabs : tabs).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFormTab(tab.id)}
                  className={`px-4 py-3 text-xs font-semibold border-b-2 transition-all ${
                    formTab === tab.id
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  {tab.label}
                  {tab.id === "insurance_plan" && selectedPlanId && (
                    <span className="ml-1.5 inline-flex items-center justify-center w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  )}
                </button>
              ))}
            </div>

            {/* Scrollable Form Body */}
            <form onSubmit={hookFormSubmit(showCreateModal ? handleCreateApplicant : handleEditApplicant)} className="flex-1 overflow-y-auto p-6 space-y-6">
              
              {/* TAB 1: Demographics & Contact */}
              {formTab === "demographics" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Core Identity Parameters</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">First Name *</label>
                        <input
                          type="text"
                          {...register("firstName", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                          className={`w-full bg-slate-50 border ${errors.firstName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        />
                        {errors.firstName && <span className="text-[10px] text-red-500">{errors.firstName.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Last Name *</label>
                        <input
                          type="text"
                          {...register("lastName", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                          className={`w-full bg-slate-50 border ${errors.lastName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        />
                        {errors.lastName && <span className="text-[10px] text-red-500">{errors.lastName.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC *</label>
                        <input
                          type="text"
                          {...register("cnic", { 
                            onChange: (e) => {
                              const formatted = formatCNIC(e.target.value);
                              e.target.value = formatted;
                              setValue("cnic", formatted, { shouldValidate: true });
                            }
                          })}
                          placeholder="35201-XXXXXXX-X"
                          maxLength={15}
                          className={`w-full bg-slate-50 border ${errors.cnic ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        />
                        {errors.cnic && <span className="text-[10px] text-red-500">{errors.cnic.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Date of Birth *</label>
                        <input
                          type="date"
                          {...register("dob")}
                          className={`w-full bg-slate-50 border ${errors.dob ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        />
                        {errors.dob && <span className="text-[10px] text-red-500">{errors.dob.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Gender *</label>
                        <select
                          {...register("gender")}
                          className={`w-full bg-slate-50 border ${errors.gender ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        >
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                        </select>
                        {errors.gender && <span className="text-[10px] text-red-500">{errors.gender.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Marital Status</label>
                        <select
                          {...register("maritalStatus")}
                          className={`w-full bg-slate-50 border ${errors.maritalStatus ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        >
                          <option value="Single">Single</option>
                          <option value="Married">Married</option>
                          <option value="Divorced">Divorced</option>
                          <option value="Widowed">Widowed</option>
                        </select>
                        {errors.maritalStatus && <span className="text-[10px] text-red-500">{errors.maritalStatus.message}</span>}
                      </div>
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Contact Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Mobile Number</label>
                        <input
                          type="text"
                          value={details.contact.mobile_number}
                          onChange={(e) => updateField("contact", "mobile_number", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Email Address</label>
                        <input
                          type="email"
                          value={details.contact.email}
                          onChange={(e) => updateField("contact", "email", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Emergency Contact Name</label>
                        <input
                          type="text"
                          value={details.contact.emergency_contact_name}
                          onChange={(e) => updateField("contact", "emergency_contact_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Address Information</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1 md:col-span-3">
                        <label className="text-xs font-semibold text-slate-600">Street Address</label>
                        <input
                          type="text"
                          value={details.address.street_address}
                          onChange={(e) => updateField("address", "street_address", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">City</label>
                        <input
                          type="text"
                          value={details.address.city}
                          onChange={(e) => updateField("address", "city", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Province</label>
                        <input
                          type="text"
                          value={details.address.province}
                          onChange={(e) => updateField("address", "province", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Postal Code</label>
                        <input
                          type="text"
                          value={details.address.postal_code}
                          onChange={(e) => updateField("address", "postal_code", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: CNIC & Docs */}
              {formTab === "cnic" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">CNIC Metadata (Module 2)</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC Issue Date</label>
                        <input
                          type="date"
                          value={details.cnic_metadata.issue_date}
                          onChange={(e) => updateField("cnic_metadata", "issue_date", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC Expiry Date</label>
                        <input
                          type="date"
                          value={details.cnic_metadata.expiry_date}
                          onChange={(e) => updateField("cnic_metadata", "expiry_date", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Validation Status</label>
                        <select
                          value={details.cnic_metadata.validation_status}
                          onChange={(e) => updateField("cnic_metadata", "validation_status", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="Valid">Valid</option>
                          <option value="Invalid">Invalid</option>
                          <option value="Expired">Expired</option>
                          <option value="Unverifiable">Unverifiable</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Document Uploads</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC Front Image</label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) updateField("cnic_metadata", "front_image_url", URL.createObjectURL(file));
                          }}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 transition-all cursor-pointer"
                        />
                        {details.cnic_metadata.front_image_url && <p className="text-[10px] text-emerald-600 mt-1 font-semibold">Image selected for upload</p>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC Back Image</label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) updateField("cnic_metadata", "back_image_url", URL.createObjectURL(file));
                          }}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 transition-all cursor-pointer"
                        />
                        {details.cnic_metadata.back_image_url && <p className="text-[10px] text-emerald-600 mt-1 font-semibold">Image selected for upload</p>}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: Occupation & Income */}
              {formTab === "employment" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Employment Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Employment Type</label>
                        <select
                          value={details.occupation_details.employment_type}
                          onChange={(e) => updateField("occupation_details", "employment_type", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="Salaried">Salaried</option>
                          <option value="Self-Employed">Self-Employed</option>
                          <option value="Business">Business</option>
                          <option value="Unemployed">Unemployed</option>
                          <option value="Retired">Retired</option>
                          <option value="Student">Student</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Occupation *</label>
                        <input
                          type="text"
                          {...register("occupation", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                          className={`w-full bg-slate-50 border ${errors.occupation ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        />
                        {errors.occupation && <span className="text-[10px] text-red-500">{errors.occupation.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Employer Name</label>
                        <input
                          type="text"
                          value={details.occupation_details.employer_name}
                          onChange={(e) => updateField("occupation_details", "employer_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Industry Sector</label>
                        <input
                          type="text"
                          value={details.occupation_details.industry}
                          onChange={(e) => updateField("occupation_details", "industry", e.target.value)}
                          placeholder="e.g. IT, Healthcare"
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Years of Experience</label>
                        <input
                          type="number"
                          value={details.occupation_details.years_of_experience}
                          onChange={(e) => updateField("occupation_details", "years_of_experience", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Occupation Hazard Level</label>
                        <select
                          value={details.occupation_details.occupation_hazard_level}
                          onChange={(e) => updateField("occupation_details", "occupation_hazard_level", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="Low">Low</option>
                          <option value="Medium">Medium</option>
                          <option value="High">High</option>
                          <option value="VeryHigh">Very High</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Income & Financial Parameters</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Declared Annual Income (PKR) *</label>
                        <input
                          type="number"
                          {...register("declaredIncome")}
                          className={`w-full bg-slate-50 border ${errors.declaredIncome ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                        />
                        {errors.declaredIncome && <span className="text-[10px] text-red-500">{errors.declaredIncome.message}</span>}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Monthly Income Equivalent</label>
                        <input
                          type="number"
                          value={details.income_record.monthly_income}
                          onChange={(e) => updateField("income_record", "monthly_income", parseFloat(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Income Stability Score (1-100)</label>
                        <input
                          type="number"
                          min="1"
                          max="100"
                          value={details.income_record.income_stability_score}
                          onChange={(e) => updateField("income_record", "income_stability_score", parseInt(e.target.value) || 100)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 4: Medical & Lifestyle */}
              {formTab === "medical" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Medical History Indicators</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.medical_history.has_pre_existing_conditions}
                          onChange={(e) => updateField("medical_history", "has_pre_existing_conditions", e.target.checked)}
                          className="rounded text-blue-600"
                        />
                        Pre-Existing Conditions
                      </label>
                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.medical_history.is_smoker}
                          onChange={(e) => updateField("medical_history", "is_smoker", e.target.checked)}
                          className="rounded text-blue-600"
                        />
                        Active Smoker
                      </label>
                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.medical_history.is_diabetic}
                          onChange={(e) => updateField("medical_history", "is_diabetic", e.target.checked)}
                          className="rounded text-blue-600"
                        />
                        Diabetic Profile
                      </label>
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  {/* Add Conditions Sub-Form */}
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">Medical Conditions List</h4>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <input
                          type="text"
                          placeholder="Condition Name (e.g. Asthma)"
                          value={newCondition.condition_name}
                          onChange={(e) => setNewCondition({ ...newCondition, condition_name: e.target.value })}
                          className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs"
                        />
                        <select
                          value={newCondition.severity}
                          onChange={(e) => setNewCondition({ ...newCondition, severity: e.target.value })}
                          className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs"
                        >
                          <option value="Mild">Mild</option>
                          <option value="Moderate">Moderate</option>
                          <option value="Severe">Severe</option>
                        </select>
                        <button
                          type="button"
                          onClick={addCondition}
                          className="bg-blue-600 text-white font-semibold text-xs py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                          + Add Condition
                        </button>
                      </div>
                      {details.conditions.length > 0 && (
                        <div className="pt-2 divide-y divide-slate-200/60 max-h-40 overflow-y-auto">
                          {details.conditions.map((c, i) => (
                            <div key={i} className="py-2 text-xs flex justify-between items-center text-slate-700">
                              <span><strong>{c.condition_name}</strong> - Severity: {c.severity}</span>
                              <button
                                type="button"
                                onClick={() => setDetails(prev => ({ ...prev, conditions: prev.conditions.filter((_, idx) => idx !== i) }))}
                                className="text-red-500 font-bold hover:underline"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  {/* Lifestyle */}
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Lifestyle & BMI metrics</h4>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Height (cm)</label>
                        <input
                          type="number"
                          value={details.lifestyle.height_cm}
                          onChange={(e) => updateField("lifestyle", "height_cm", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Weight (kg)</label>
                        <input
                          type="number"
                          value={details.lifestyle.weight_kg}
                          onChange={(e) => updateField("lifestyle", "weight_kg", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Calculated BMI</label>
                        <input
                          type="number"
                          readOnly
                          value={details.lifestyle.bmi}
                          className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Exercise Frequency</label>
                        <select
                          value={details.lifestyle.exercise_frequency}
                          onChange={(e) => updateField("lifestyle", "exercise_frequency", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="Sedentary">Sedentary</option>
                          <option value="Light">Light</option>
                          <option value="Moderate">Moderate</option>
                          <option value="Active">Active</option>
                          <option value="VeryActive">Very Active</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 4.5: Habit Check */}
              {formTab === "habit_check" && (
                <div className="space-y-6">
                  {/* 1. Substance Consumption */}
                  <div className="bg-white border border-slate-200/80 rounded-xl p-5 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                      <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center text-red-500">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Substance Consumption</h4>
                        <p className="text-[11px] text-slate-400">Critical fields for mortality pricing & risk assessment.</p>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Smoking Status</label>
                        <select
                          value={details.habit_check.smoking_status}
                          onChange={(e) => updateField("habit_check", "smoking_status", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        >
                          <option value="Non-smoker">Non-smoker</option>
                          <option value="Occasional">Occasional</option>
                          <option value="Heavy Smoker">Heavy Smoker</option>
                          <option value="Vaper">Vaper</option>
                          <option value="Chewing Tobacco">Chewing Tobacco</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Alcohol Consumption Frequency</label>
                        <select
                          value={details.habit_check.alcohol_consumption_frequency}
                          onChange={(e) => updateField("habit_check", "alcohol_consumption_frequency", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        >
                          <option value="None">None</option>
                          <option value="Occasional">Occasional</option>
                          <option value="Moderate">Moderate</option>
                          <option value="Heavy">Heavy</option>
                        </select>
                      </div>
                    </div>

                    <div className="pt-2">
                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.habit_check.recreational_drug_use_history}
                          onChange={(e) => updateField("habit_check", "recreational_drug_use_history", e.target.checked)}
                          className="rounded text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <span>Recreational Drug Use History (Past 3-5 Years)</span>
                          <span className="block text-[10px] text-slate-400 font-normal">Check if the applicant has used illegal or non-prescribed substances.</span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* 2. High-Risk Hobbies */}
                  <div className="bg-white border border-slate-200/80 rounded-xl p-5 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                      <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center text-orange-500">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">High-Risk Hobbies (Avocations)</h4>
                        <p className="text-[11px] text-slate-400">Identifies activities with high fatality rates.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.habit_check.participates_in_extreme_sports}
                          onChange={(e) => {
                            const val = e.target.checked;
                            setDetails(prev => ({
                              ...prev,
                              habit_check: {
                                ...prev.habit_check,
                                participates_in_extreme_sports: val,
                                extreme_sports_details: val ? prev.habit_check.extreme_sports_details : []
                              }
                            }));
                          }}
                          className="rounded text-blue-600 focus:ring-blue-500 mt-0.5"
                        />
                        <div>
                          <span>Participates in Extreme Sports</span>
                          <span className="block text-[10px] text-slate-400 font-normal">Trigger flag for adventure/high-risk sports.</span>
                        </div>
                      </label>

                      <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.habit_check.private_aviation}
                          onChange={(e) => updateField("habit_check", "private_aviation", e.target.checked)}
                          className="rounded text-blue-600 focus:ring-blue-500 mt-0.5"
                        />
                        <div>
                          <span>Private Aviation</span>
                          <span className="block text-[10px] text-slate-400 font-normal">Flies private aircraft or experimental planes (commercial passengers exempt).</span>
                        </div>
                      </label>
                    </div>

                    {details.habit_check.participates_in_extreme_sports && (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2">
                        <span className="text-xs font-bold text-slate-700 block">Select Extreme Sports:</span>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                          {["Skydiving", "Scuba Diving (past 100ft)", "Bungee Jumping", "Rock/Ice Climbing", "Motorsports/Racing"].map((sport) => {
                            const isChecked = details.habit_check.extreme_sports_details.includes(sport);
                            return (
                              <label key={sport} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    const nextList = isChecked
                                      ? details.habit_check.extreme_sports_details.filter(s => s !== sport)
                                      : [...details.habit_check.extreme_sports_details, sport];
                                    updateField("habit_check", "extreme_sports_details", nextList);
                                  }}
                                  className="rounded text-blue-600 focus:ring-blue-500"
                                />
                                {sport}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 3. Travel & Location Risks */}
                  <div className="bg-white border border-slate-200/80 rounded-xl p-5 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-500">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 002 2h2m-4-3.5a2.5 2.5 0 014 2.828v1.172c0 .417-.18.823-.495 1.109l-2.091 1.909A2.5 2.5 0 0113.5 16h-.146A2 2 0 0111.854 15.1l-.854-.854A2 2 0 0110 12.854V11H8.5a1.5 1.5 0 00-1.5 1.5v3h-.5" />
                        </svg>
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Travel & Location Risks</h4>
                        <p className="text-[11px] text-slate-400">Underwriting travel to politically unstable or disease outbreak zones.</p>
                      </div>
                    </div>

                    <div>
                      <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.habit_check.frequent_high_risk_travel}
                          onChange={(e) => updateField("habit_check", "frequent_high_risk_travel", e.target.checked)}
                          className="rounded text-blue-600 focus:ring-blue-500 mt-0.5"
                        />
                        <div>
                          <span>Frequent High-Risk Travel</span>
                          <span className="block text-[10px] text-slate-400 font-normal">Travel planned or taken to politically unstable regions, active war zones, or severe outbreak areas.</span>
                        </div>
                      </label>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-slate-600 block">Travel Destinations (Past/Next 12 Months)</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="e.g. Iraq, Somalia, Ukraine"
                          value={newDestination}
                          onChange={(e) => setNewDestination(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (newDestination.trim()) {
                                const dest = newDestination.trim();
                                if (!details.habit_check.travel_destinations.includes(dest)) {
                                  updateField("habit_check", "travel_destinations", [...details.habit_check.travel_destinations, dest]);
                                }
                                setNewDestination("");
                              }
                            }
                          }}
                          className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (newDestination.trim()) {
                              const dest = newDestination.trim();
                              if (!details.habit_check.travel_destinations.includes(dest)) {
                                updateField("habit_check", "travel_destinations", [...details.habit_check.travel_destinations, dest]);
                              }
                              setNewDestination("");
                            }
                          }}
                          className="bg-blue-600 text-white font-bold text-xs px-4 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                          + Add
                        </button>
                      </div>

                      {details.habit_check.travel_destinations.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-2">
                          {details.habit_check.travel_destinations.map((dest, i) => (
                            <span key={i} className="inline-flex items-center gap-1 bg-blue-50 border border-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full">
                              {dest}
                              <button
                                type="button"
                                onClick={() => {
                                  updateField("habit_check", "travel_destinations", details.habit_check.travel_destinations.filter((_, idx) => idx !== i));
                                }}
                                className="text-blue-500 hover:text-blue-800 font-bold"
                              >
                                &times;
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 4. Behavioral & Legal History */}
                  <div className="bg-white border border-slate-200/80 rounded-xl p-5 shadow-sm space-y-4">
                    <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center text-purple-500">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Behavioral & Legal History</h4>
                        <p className="text-[11px] text-slate-400">Assessing general recklessness & legal risks.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Moving Violations (Past 3 Years)</label>
                        <input
                          type="number"
                          min="0"
                          value={details.habit_check.moving_violations_past_3_years}
                          onChange={(e) => updateField("habit_check", "moving_violations_past_3_years", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="flex flex-col justify-end space-y-2">
                        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={details.habit_check.dui_dwi_history}
                            onChange={(e) => updateField("habit_check", "dui_dwi_history", e.target.checked)}
                            className="rounded text-blue-600 focus:ring-blue-500"
                          />
                          DUI / DWI History
                        </label>
                      </div>
                    </div>

                    <div>
                      <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={details.habit_check.criminal_record}
                          onChange={(e) => updateField("habit_check", "criminal_record", e.target.checked)}
                          className="rounded text-blue-600 focus:ring-blue-500 mt-0.5"
                        />
                        <div>
                          <span>Criminal Record</span>
                          <span className="block text-[10px] text-slate-400 font-normal">Check if the applicant has felony convictions or pending criminal charges.</span>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 5: Financial Profile */}
              {formTab === "financial" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Credit Bureau & Bank details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Credit Score</label>
                        <input
                          type="number"
                          value={details.financial_records.credit_bureau.credit_score}
                          onChange={(e) => updateSubField("financial_records", "credit_bureau", "credit_score", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Delinquencies count</label>
                        <input
                          type="number"
                          value={details.financial_records.credit_bureau.delinquency_count}
                          onChange={(e) => updateSubField("financial_records", "credit_bureau", "delinquency_count", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Credit Bureau Risk Grade</label>
                        <select
                          value={details.financial_records.credit_bureau.risk_grade}
                          onChange={(e) => updateSubField("financial_records", "credit_bureau", "risk_grade", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="A">Grade A</option>
                          <option value="B">Grade B</option>
                          <option value="C">Grade C</option>
                          <option value="D">Grade D</option>
                          <option value="E">Grade E</option>
                          <option value="F">Grade F</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <hr className="border-slate-100" />

                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Dependents Info</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Number of Dependents</label>
                        <input
                          type="number"
                          value={details.financial_records.dependents.number_of_dependents}
                          onChange={(e) => updateSubField("financial_records", "dependents", "number_of_dependents", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Primary Dependent Type</label>
                        <select
                          value={details.financial_records.dependents.dependent_type}
                          onChange={(e) => updateSubField("financial_records", "dependents", "dependent_type", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="Spouse">Spouse</option>
                          <option value="Child">Child</option>
                          <option value="Parent">Parent</option>
                          <option value="Sibling">Sibling</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 6: Beneficiary / Nominee */}
              {formTab === "beneficiary" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Primary Beneficiary (Section 7)</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">First Name</label>
                        <input
                          type="text"
                          value={details.beneficiary.first_name}
                          onChange={(e) => updateField("beneficiary", "first_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Last Name</label>
                        <input
                          type="text"
                          value={details.beneficiary.last_name}
                          onChange={(e) => updateField("beneficiary", "last_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC Number</label>
                        <input
                          type="text"
                          value={details.beneficiary.cnic_number}
                          onChange={(e) => updateField("beneficiary", "cnic_number", formatCNIC(e.target.value))}
                          placeholder="35201-XXXXXXX-X"
                          maxLength={15}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Relationship</label>
                        <select
                          value={details.beneficiary.relationship}
                          onChange={(e) => updateField("beneficiary", "relationship", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        >
                          <option value="Spouse">Spouse</option>
                          <option value="Parent">Parent</option>
                          <option value="Child">Child</option>
                          <option value="Sibling">Sibling</option>
                          <option value="Guardian">Guardian</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Share Percentage (%)</label>
                        <input
                          type="number"
                          value={details.beneficiary.share_percentage}
                          onChange={(e) => updateField("beneficiary", "share_percentage", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 7: Insurance Plans (edit modal) */}
              {formTab === "insurance_plan" && showEditModal && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1">Insurance Plans</h4>
                    <p className="text-xs text-slate-400 mb-5">Existing policies for this applicant. You can assign an additional plan below.</p>

                    {/* Existing policies */}
                    {viewPoliciesLoading ? (
                      <div className="flex items-center gap-2 py-6 justify-center">
                        <div className="animate-spin h-5 w-5 rounded-full border-2 border-slate-100 border-t-blue-500" />
                        <span className="text-xs text-slate-400">Loading policies...</span>
                      </div>
                    ) : applicantPolicies.length === 0 ? (
                      <div className="text-center py-8 text-sm text-slate-400 italic">No policies assigned yet.</div>
                    ) : (
                      <div className="space-y-3 mb-6">
                        {applicantPolicies.map((pol) => {
                          const colorClass = PLAN_TYPE_COLORS[pol.insurance_type] ?? "border-slate-200 bg-slate-50";
                          const textClass  = PLAN_TYPE_TEXT[pol.insurance_type]  ?? "text-slate-700";
                          return (
                            <div key={pol.id} className={`border-l-4 rounded-xl p-4 ${colorClass}`}>
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className={`text-sm font-bold ${textClass}`}>{pol.product_name}</p>
                                  <p className="text-[10px] text-slate-400 mt-0.5 font-semibold uppercase tracking-wider">
                                    {INSURANCE_TYPE_LABELS[pol.insurance_type] ?? pol.insurance_type}
                                  </p>
                                </div>
                                <span className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${textClass} bg-white/70`}>{pol.term_years} yr</span>
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <span className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Coverage</span>
                                  <span className="font-bold text-slate-800">PKR {pol.coverage_amount.toLocaleString()}</span>
                                </div>
                                <div>
                                  <span className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Assigned</span>
                                  <span className="text-slate-600">{new Date(pol.created_at).toLocaleDateString()}</span>
                                </div>
                                {pol.dependent_name && (
                                  <div className="col-span-2">
                                    <span className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Dependent</span>
                                    <span className="text-slate-600">{pol.dependent_name} · {pol.dependent_dob}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Add new policy toggle */}
                    {!editAddingPolicy ? (
                      <button
                        type="button"
                        onClick={() => setEditAddingPolicy(true)}
                        className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-xs font-semibold text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
                      >
                        + Assign New Insurance Plan
                      </button>
                    ) : (
                      <div className="border border-slate-200 rounded-xl p-5 space-y-5 bg-slate-50">
                        <div className="flex items-center justify-between">
                          <h5 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Assign New Plan</h5>
                          <button type="button" onClick={() => { setEditAddingPolicy(false); setEditSelectedPlanId(""); }} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                        </div>

                        {availablePlans.length === 0 ? (
                          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700 font-medium">
                            No active plans found. Create plans from the Insurance Plans page first.
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {availablePlans.map((plan) => {
                              const isSelected = editSelectedPlanId === plan.id;
                              const colorClass = PLAN_TYPE_COLORS[plan.insurance_type] ?? "border-slate-200 bg-white";
                              const textClass  = PLAN_TYPE_TEXT[plan.insurance_type]  ?? "text-slate-700";
                              return (
                                <button
                                  key={plan.id}
                                  type="button"
                                  onClick={() => {
                                    setEditSelectedPlanId(isSelected ? "" : plan.id);
                                    if (!isSelected) {
                                      setEditPolicyCoverage("");
                                      setEditPolicyTerm(String(plan.term_min_years));
                                    }
                                  }}
                                  className={`relative w-full text-left p-4 rounded-xl border-2 transition-all ${
                                    isSelected
                                      ? `${colorClass} shadow-md ring-2 ring-offset-1 ${textClass.replace("text-", "ring-")}`
                                      : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
                                  }`}
                                >
                                  {isSelected && (
                                    <span className="absolute top-2 right-2 flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 text-white text-[9px] font-bold">✓</span>
                                  )}
                                  <p className={`text-sm font-bold ${isSelected ? textClass : "text-slate-800"}`}>{plan.label}</p>
                                  <p className="text-[10px] text-slate-400 mt-0.5 font-semibold uppercase tracking-wider">
                                    {INSURANCE_TYPE_LABELS[plan.insurance_type] ?? plan.insurance_type}
                                  </p>
                                  <div className="flex gap-3 mt-2 text-[10px] font-semibold text-slate-500">
                                    <span>Age {plan.entry_age_min}–{plan.entry_age_max}</span>
                                    <span>·</span>
                                    <span>Term {plan.term_min_years}–{plan.term_max_years} yrs</span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {editSelectedPlanId && (() => {
                          const plan = availablePlans.find((p) => p.id === editSelectedPlanId);
                          if (!plan) return null;
                          return (
                            <div className="space-y-4 pt-2">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-1">
                                  <label className="text-xs font-semibold text-slate-600">Coverage Amount (PKR) *</label>
                                  <input
                                    type="number" min={0}
                                    value={editPolicyCoverage}
                                    onChange={(e) => setEditPolicyCoverage(e.target.value)}
                                    placeholder="e.g. 5000000"
                                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                                  />
                                  <p className="text-[10px] text-slate-400">Max {plan.max_income_multiple}× declared income</p>
                                </div>
                                <div className="space-y-1">
                                  <label className="text-xs font-semibold text-slate-600">Policy Term (Years) *</label>
                                  <input
                                    type="number"
                                    min={plan.term_min_years} max={plan.term_max_years}
                                    value={editPolicyTerm}
                                    onChange={(e) => setEditPolicyTerm(e.target.value)}
                                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                                  />
                                  <p className="text-[10px] text-slate-400">Range: {plan.term_min_years}–{plan.term_max_years} yrs</p>
                                </div>
                              </div>
                              {plan.insurance_type === "CHILD_EDUCATION_MARRIAGE" && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  <div className="space-y-1">
                                    <label className="text-xs font-semibold text-slate-600">Dependent Name</label>
                                    <input
                                      type="text"
                                      value={editPolicyDependentName}
                                      onChange={(e) => setEditPolicyDependentName(e.target.value)}
                                      placeholder="Child's full name"
                                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-xs font-semibold text-slate-600">Dependent Date of Birth</label>
                                    <input
                                      type="date"
                                      value={editPolicyDependentDob}
                                      onChange={(e) => setEditPolicyDependentDob(e.target.value)}
                                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                                    />
                                  </div>
                                </div>
                              )}
                              <button
                                type="button"
                                disabled={editPolicyLoading || !editPolicyCoverage || !editPolicyTerm}
                                onClick={async () => {
                                  const tenantId = localStorage.getItem("tenant_id");
                                  if (!tenantId || !selectedApplicant) return;
                                  setEditPolicyLoading(true);
                                  try {
                                    const payload: any = {
                                      plan_id: editSelectedPlanId,
                                      product_name: plan.label,
                                      insurance_type: plan.insurance_type,
                                      coverage_amount: parseFloat(editPolicyCoverage),
                                      term_years: parseInt(editPolicyTerm),
                                    };
                                    if (plan.insurance_type === "CHILD_EDUCATION_MARRIAGE") {
                                      payload.dependent_name = editPolicyDependentName || null;
                                      payload.dependent_dob  = editPolicyDependentDob  || null;
                                    }
                                    await api.post(`/tenants/${tenantId}/applicants/${selectedApplicant.id}/policies`, payload);
                                    // Refresh list
                                    const res = await api.get(`/tenants/${tenantId}/applicants/${selectedApplicant.id}/policies`);
                                    setApplicantPolicies(res.data ?? []);
                                    setEditAddingPolicy(false);
                                    setEditSelectedPlanId("");
                                    setEditPolicyCoverage("");
                                    setEditPolicyTerm("");
                                    setEditPolicyDependentName("");
                                    setEditPolicyDependentDob("");
                                    setSuccess("Policy assigned successfully!");
                                  } catch (err: any) {
                                    setError(err.response?.data?.detail ?? "Failed to assign policy.");
                                  } finally {
                                    setEditPolicyLoading(false);
                                  }
                                }}
                                className="w-full py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors"
                              >
                                {editPolicyLoading ? "Assigning..." : "Confirm & Assign Policy"}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 7: Insurance Plan (create only) */}
              {formTab === "insurance_plan" && showCreateModal && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1">Select Insurance Plan</h4>
                    
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
                      <p className="text-xs text-slate-400">Choose a plan from your tenant catalog. Coverage and term are required.</p>
                      <button
                        type="button"
                        onClick={handleSuggestPlan}
                        disabled={isSuggestingPlan || availablePlans.length === 0}
                        className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:bg-indigo-300 transition-colors shadow-sm whitespace-nowrap"
                      >
                        {isSuggestingPlan ? (
                          <>
                            <div className="animate-spin h-3.5 w-3.5 rounded-full border-2 border-indigo-200 border-t-white" />
                            Analyzing Profile...
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                            Suggest Plan with AI
                          </>
                        )}
                      </button>
                    </div>

                    {suggestedReasoning && (
                      <div className="mb-6 p-4 rounded-xl bg-indigo-50 border border-indigo-200 shadow-sm animate-in fade-in slide-in-from-top-2">
                        <div className="flex gap-3">
                          <svg className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <div>
                            <h5 className="text-xs font-bold text-indigo-900 mb-1">AI Recommendation</h5>
                            <p className="text-xs text-indigo-800 leading-relaxed">{suggestedReasoning}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {plansLoading ? (
                      <div className="flex items-center gap-2 py-6 justify-center">
                        <div className="animate-spin h-5 w-5 rounded-full border-2 border-slate-100 border-t-blue-500" />
                        <span className="text-xs text-slate-400">Loading plans...</span>
                      </div>
                    ) : availablePlans.length === 0 ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700 font-medium">
                        No active insurance plans found for this tenant. Please create plans first from the Insurance Plans page.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                        {availablePlans.map((plan) => {
                          const isSelected = selectedPlanId === plan.id;
                          const colorClass = PLAN_TYPE_COLORS[plan.insurance_type] ?? "border-slate-200 bg-slate-50";
                          const textClass = PLAN_TYPE_TEXT[plan.insurance_type] ?? "text-slate-700";
                          return (
                            <button
                              key={plan.id}
                              type="button"
                              onClick={() => {
                                setValue("selectedPlanId", isSelected ? "" : plan.id);
                                if (!isSelected) {
                                  setValue("policyCoverage", undefined);
                                  setValue("policyTerm", plan.term_min_years);
                                }
                              }}
                              className={`relative w-full text-left p-4 rounded-xl border-2 transition-all ${
                                isSelected
                                  ? `${colorClass} shadow-md ring-2 ring-offset-1 ${textClass.replace("text-", "ring-")}`
                                  : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
                              }`}
                            >
                              {isSelected && (
                                <span className="absolute top-3 right-3 flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white text-[10px] font-bold">✓</span>
                              )}
                              <p className={`text-sm font-bold ${isSelected ? textClass : "text-slate-800"}`}>{plan.label}</p>
                              <p className="text-[10px] text-slate-400 mt-0.5 font-semibold uppercase tracking-wider">
                                {INSURANCE_TYPE_LABELS[plan.insurance_type] ?? plan.insurance_type}
                              </p>
                              <p className="text-xs text-slate-500 mt-2 line-clamp-2">{plan.description}</p>
                              <div className="flex gap-3 mt-3 text-[10px] font-semibold text-slate-500">
                                <span>Age {plan.entry_age_min}–{plan.entry_age_max}</span>
                                <span>·</span>
                                <span>Term {plan.term_min_years}–{plan.term_max_years} yrs</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {selectedPlanId && (() => {
                      const plan = availablePlans.find((p) => p.id === selectedPlanId);
                      if (!plan) return null;
                      return (
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Plan Configuration</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1">
                              <label className="text-xs font-semibold text-slate-600">
                                Coverage Amount (PKR) *
                              </label>
                              <input
                                type="number"
                                min={0}
                                {...register("policyCoverage")}
                                placeholder="e.g. 5000000"
                                className={`w-full bg-white border ${errors.policyCoverage ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                              />
                              {errors.policyCoverage && <span className="text-[10px] text-red-500">{errors.policyCoverage.message}</span>}
                              <p className="text-[10px] text-slate-400">
                                Max {plan.max_income_multiple}× declared income recommended
                              </p>
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-semibold text-slate-600">
                                Policy Term (Years) *
                              </label>
                              <input
                                type="number"
                                min={plan.term_min_years}
                                max={plan.term_max_years}
                                {...register("policyTerm")}
                                className={`w-full bg-white border ${errors.policyTerm ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                              />
                              {errors.policyTerm && <span className="text-[10px] text-red-500">{errors.policyTerm.message}</span>}
                              <p className="text-[10px] text-slate-400">
                                Allowed range: {plan.term_min_years}–{plan.term_max_years} years
                              </p>
                            </div>
                          </div>

                          {plan.insurance_type === "CHILD_EDUCATION_MARRIAGE" && (
                            <>
                              <hr className="border-slate-200" />
                              <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Dependent / Child Details</h5>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-1">
                                  <label className="text-xs font-semibold text-slate-600">Dependent Name</label>
                                  <input
                                    type="text"
                                    {...register("policyDependentName", { onChange: (e) => e.target.value = e.target.value.replace(/[^A-Za-z\s]/g, '') })}
                                    placeholder="Child's full name"
                                    className={`w-full bg-white border ${errors.policyDependentName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                                  />
                                  {errors.policyDependentName && <span className="text-[10px] text-red-500">{errors.policyDependentName.message}</span>}
                                </div>
                                <div className="space-y-1">
                                  <label className="text-xs font-semibold text-slate-600">Dependent Date of Birth</label>
                                  <input
                                    type="date"
                                    {...register("policyDependentDob")}
                                    className={`w-full bg-white border ${errors.policyDependentDob ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                                  />
                                  {errors.policyDependentDob && <span className="text-[10px] text-red-500">{errors.policyDependentDob.message}</span>}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()}

                    {!selectedPlanId && availablePlans.length > 0 && (
                      <p className="text-xs text-slate-400 text-center mt-2 italic">No plan selected — you can skip this step and assign a plan later.</p>
                    )}
                  </div>
                </div>
              )}

            </form>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
              <div>
                <button
                  type="button"
                  onClick={() => { setShowCreateModal(false); setShowEditModal(false); }}
                  className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
              <div className="flex gap-3">
                {(() => {
                  const activeTabs = showCreateModal ? createTabs : tabs;
                  const currentIdx = activeTabs.findIndex(t => t.id === formTab);
                  return (
                    <>
                      {currentIdx > 0 && (
                        <button
                          type="button"
                          onClick={() => setFormTab(activeTabs[currentIdx - 1].id)}
                          className="px-5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
                        >
                          Previous
                        </button>
                      )}
                      {currentIdx < activeTabs.length - 1 ? (
                        <button
                          type="button"
                          onClick={() => setFormTab(activeTabs[currentIdx + 1].id)}
                          className="px-5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg"
                        >
                          Next Step
                        </button>
                      ) : (
                        <button
                          type="submit"
                          disabled={formLoading}
                          className="px-6 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg shadow-sm"
                        >
                          {formLoading ? "Saving Profile..." : showCreateModal ? "Register Applicant" : "Update Profile"}
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ── VIEW PROFILE MODAL ── */}
      {showProfileModal && selectedApplicant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-sm">
                  {selectedApplicant.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)}
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">{selectedApplicant.name}</h3>
                  <p className="text-xs text-slate-400">CNIC: {selectedApplicant.cnic}</p>
                </div>
              </div>
              <button onClick={() => setShowProfileModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            {/* Split View Layout */}
            <div className="flex flex-1 overflow-hidden h-[600px]">
              
              {/* Sidebar Navigation */}
              <div className="w-64 bg-slate-50 border-r border-slate-100 flex flex-col py-6 px-4 space-y-1.5 overflow-y-auto">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 px-2">Applicant Profile</p>
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setViewTab(tab.id)}
                    className={`text-left px-4 py-3 rounded-xl text-xs font-bold transition-all flex items-center gap-3 ${
                      viewTab === tab.id
                        ? "bg-white text-blue-600 shadow-sm border border-slate-200"
                        : "text-slate-500 hover:bg-slate-200/50 border border-transparent"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Main Content Pane */}
              <div className="flex-1 overflow-y-auto bg-white p-8">
                
                {viewTab === "demographics" && (
                  <div className="space-y-6 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Identity & Contact</h4>
                    <div className="grid grid-cols-2 gap-y-6 gap-x-8">
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">First Name</span><span className="text-sm font-medium text-slate-800">{selectedApplicant.name.split(" ")[0]}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Last Name</span><span className="text-sm font-medium text-slate-800">{selectedApplicant.name.split(" ").slice(1).join(" ") || "-"}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Date of Birth</span><span className="text-sm font-medium text-slate-800">{selectedApplicant.dob}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Gender</span><span className="text-sm font-medium text-slate-800">{selectedApplicant.gender}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Marital Status</span><span className="text-sm font-medium text-slate-800">{details.contact.emergency_contact_relation || "Single"}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Mobile Number</span><span className="text-sm font-medium text-slate-800">{details.contact.mobile_number || "-"}</span></div>
                      <div className="col-span-2"><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Email</span><span className="text-sm font-medium text-slate-800">{details.contact.email || "-"}</span></div>
                      <div className="col-span-2"><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Full Address</span><span className="text-sm font-medium text-slate-800">{details.address.street_address || "-"}, {details.address.city || "-"}, {details.address.country}</span></div>
                    </div>
                  </div>
                )}

                {viewTab === "cnic" && (
                  <div className="space-y-6 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">CNIC & Verification</h4>
                    <div className="grid grid-cols-2 gap-y-6 gap-x-8">
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">CNIC Number</span><span className="text-sm font-mono text-slate-800">{selectedApplicant.cnic}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Validation Status</span><span className="text-sm font-bold text-emerald-600">{details.cnic_metadata.validation_status}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Issue Date</span><span className="text-sm font-medium text-slate-800">{details.cnic_metadata.issue_date || "-"}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Expiry Date</span><span className="text-sm font-medium text-slate-800">{details.cnic_metadata.expiry_date || "-"}</span></div>
                    </div>
                    
                    <div className="mt-8">
                      <span className="block text-xs font-semibold text-slate-400 uppercase mb-4">Document Previews</span>
                      <div className="grid grid-cols-2 gap-6">
                        {details.cnic_metadata.front_image_url ? (
                          <div className="space-y-2">
                            <span className="text-xs font-semibold text-slate-500">Front Image</span>
                            <img src={details.cnic_metadata.front_image_url} alt="CNIC Front" className="w-full h-40 object-cover rounded-xl shadow-sm border border-slate-200" />
                          </div>
                        ) : (
                          <div className="h-40 bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl flex items-center justify-center text-xs font-semibold text-slate-400">Front image missing</div>
                        )}
                        {details.cnic_metadata.back_image_url ? (
                          <div className="space-y-2">
                            <span className="text-xs font-semibold text-slate-500">Back Image</span>
                            <img src={details.cnic_metadata.back_image_url} alt="CNIC Back" className="w-full h-40 object-cover rounded-xl shadow-sm border border-slate-200" />
                          </div>
                        ) : (
                          <div className="h-40 bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl flex items-center justify-center text-xs font-semibold text-slate-400">Back image missing</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {viewTab === "employment" && (
                  <div className="space-y-6 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Occupation & Income</h4>
                    <div className="grid grid-cols-2 gap-y-6 gap-x-8">
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Employment Type</span><span className="text-sm font-medium text-slate-800">{details.occupation_details.employment_type}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Designation</span><span className="text-sm font-medium text-slate-800">{selectedApplicant.occupation}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Employer Name</span><span className="text-sm font-medium text-slate-800">{details.occupation_details.employer_name || "-"}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Years of Experience</span><span className="text-sm font-medium text-slate-800">{details.occupation_details.years_of_experience} years</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Declared Annual Income</span><span className="text-sm font-bold text-emerald-600">PKR {selectedApplicant.declared_income.toLocaleString()}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Hazard Level</span><span className={`text-sm font-bold ${details.occupation_details.occupation_hazard_level === "Low" ? "text-emerald-600" : "text-amber-600"}`}>{details.occupation_details.occupation_hazard_level}</span></div>
                    </div>
                  </div>
                )}

                {viewTab === "medical" && (
                  <div className="space-y-8 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Medical & Lifestyle</h4>
                    
                    <div className="grid grid-cols-3 gap-4">
                      <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200 flex flex-col items-center justify-center text-center">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Pre-Existing</span>
                        <span className="text-lg font-bold text-slate-800">{details.medical_history.has_pre_existing_conditions ? "Yes" : "No"}</span>
                      </div>
                      <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200 flex flex-col items-center justify-center text-center">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Smoker</span>
                        <span className="text-lg font-bold text-slate-800">{details.medical_history.is_smoker ? "Yes" : "No"}</span>
                      </div>
                      <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200 flex flex-col items-center justify-center text-center">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Calculated BMI</span>
                        <span className="text-lg font-bold text-slate-800">{details.lifestyle.bmi || "-"}</span>
                      </div>
                    </div>

                    {details.conditions.length > 0 && (
                      <div className="pt-2">
                        <h5 className="text-sm font-bold text-slate-800 mb-4">Registered Diagnoses</h5>
                        <div className="space-y-3">
                          {details.conditions.map((c: any, i: number) => (
                            <div key={i} className="flex justify-between items-center p-4 rounded-xl bg-slate-50 border border-slate-100">
                              <span className="text-sm font-bold text-slate-700">{c.condition_name}</span>
                              <span className={`text-xs font-bold px-2.5 py-1 rounded-md ${c.severity === "Severe" ? "bg-red-100 text-red-700" : c.severity === "Moderate" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                                {c.severity}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {viewTab === "habit_check" && (
                  <div className="space-y-8 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Habit Check Summary</h4>
                    
                    {/* Substance Consumption */}
                    <div className="bg-slate-50 rounded-xl p-5 border border-slate-100 space-y-4">
                      <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Substance Consumption</h5>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-0.5">Smoking Status</span>
                          <span className="text-sm font-semibold text-slate-800">{details.habit_check.smoking_status}</span>
                        </div>
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-0.5">Alcohol Consumption</span>
                          <span className="text-sm font-semibold text-slate-800">{details.habit_check.alcohol_consumption_frequency}</span>
                        </div>
                      </div>
                      <div>
                        <span className="block text-xs font-semibold text-slate-500 mb-0.5">Recreational Drug Use History</span>
                        <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${details.habit_check.recreational_drug_use_history ? "bg-red-50 text-red-700 border border-red-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                          {details.habit_check.recreational_drug_use_history ? "Yes (Within last 3-5 years)" : "No history"}
                        </span>
                      </div>
                    </div>

                    {/* High-Risk Hobbies */}
                    <div className="bg-slate-50 rounded-xl p-5 border border-slate-100 space-y-4">
                      <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider">High-Risk Hobbies (Avocations)</h5>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-0.5">Participates in Extreme Sports</span>
                          <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${details.habit_check.participates_in_extreme_sports ? "bg-orange-50 text-orange-700 border border-orange-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                            {details.habit_check.participates_in_extreme_sports ? "Yes" : "No"}
                          </span>
                        </div>
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-0.5">Private Aviation</span>
                          <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${details.habit_check.private_aviation ? "bg-orange-50 text-orange-700 border border-orange-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                            {details.habit_check.private_aviation ? "Yes (Pilot/Crew)" : "No"}
                          </span>
                        </div>
                      </div>
                      {details.habit_check.participates_in_extreme_sports && details.habit_check.extreme_sports_details.length > 0 && (
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-1.5">Registered Extreme Sports</span>
                          <div className="flex flex-wrap gap-1.5">
                            {details.habit_check.extreme_sports_details.map((sport: string) => (
                              <span key={sport} className="bg-orange-50 border border-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full font-semibold">
                                {sport}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Travel & Location Risks */}
                    <div className="bg-slate-50 rounded-xl p-5 border border-slate-100 space-y-4">
                      <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Travel & Location Risks</h5>
                      <div>
                        <span className="block text-xs font-semibold text-slate-500 mb-0.5">Frequent High-Risk Travel</span>
                        <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${details.habit_check.frequent_high_risk_travel ? "bg-red-50 text-red-700 border border-red-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                          {details.habit_check.frequent_high_risk_travel ? "Yes (Active risk region)" : "No"}
                        </span>
                      </div>
                      {details.habit_check.travel_destinations.length > 0 && (
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-1.5">Travel Destinations (Past/Next 12 Months)</span>
                          <div className="flex flex-wrap gap-1.5">
                            {details.habit_check.travel_destinations.map((dest: string) => (
                              <span key={dest} className="bg-blue-50 border border-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-semibold">
                                {dest}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Behavioral & Legal History */}
                    <div className="bg-slate-50 rounded-xl p-5 border border-slate-100 space-y-4">
                      <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Behavioral & Legal History</h5>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-0.5">Moving Violations (Past 3 Years)</span>
                          <span className="text-sm font-semibold text-slate-800">{details.habit_check.moving_violations_past_3_years}</span>
                        </div>
                        <div>
                          <span className="block text-xs font-semibold text-slate-500 mb-0.5">DUI / DWI History</span>
                          <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${details.habit_check.dui_dwi_history ? "bg-red-50 text-red-700 border border-red-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                            {details.habit_check.dui_dwi_history ? "Yes" : "No"}
                          </span>
                        </div>
                      </div>
                      <div>
                        <span className="block text-xs font-semibold text-slate-500 mb-0.5">Criminal Record</span>
                        <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${details.habit_check.criminal_record ? "bg-red-50 text-red-700 border border-red-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                          {details.habit_check.criminal_record ? "Yes" : "No"}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {viewTab === "financial" && (
                  <div className="space-y-6 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Financial Profile</h4>
                    <div className="grid grid-cols-2 gap-y-6 gap-x-8">
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Credit Bureau Score</span><span className="text-sm font-medium text-slate-800">{details.financial_records.credit_bureau.credit_score}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Bureau Risk Grade</span><span className="text-sm font-bold text-blue-600">Grade {details.financial_records.credit_bureau.risk_grade}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Total Dependents</span><span className="text-sm font-medium text-slate-800">{details.financial_records.dependents.number_of_dependents} ({details.financial_records.dependents.dependent_type})</span></div>
                    </div>
                  </div>
                )}

                {viewTab === "beneficiary" && (
                  <div className="space-y-6 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Nominee Details</h4>
                    <div className="grid grid-cols-2 gap-y-6 gap-x-8">
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Nominee Name</span><span className="text-sm font-medium text-slate-800">{details.beneficiary.first_name} {details.beneficiary.last_name || "-"}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Relationship</span><span className="text-sm font-medium text-slate-800">{details.beneficiary.relationship}</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Share Percentage</span><span className="text-sm font-bold text-slate-800">{details.beneficiary.share_percentage}%</span></div>
                      <div><span className="block text-xs font-semibold text-slate-400 uppercase mb-1">CNIC</span><span className="text-sm font-mono text-slate-800">{details.beneficiary.cnic_number || "-"}</span></div>
                    </div>
                  </div>
                )}

                {viewTab === "insurance_plan" && (
                  <div className="space-y-5 max-w-2xl">
                    <h4 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-3">Insurance Plans</h4>
                    {viewPoliciesLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : applicantPolicies.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-14 text-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-2xl">📋</div>
                        <p className="text-sm font-semibold text-slate-500">No policies assigned yet.</p>
                        <p className="text-xs text-slate-400">Use the Edit Profile to add an insurance plan.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {applicantPolicies.map((pol) => {
                          const colorClass = PLAN_TYPE_COLORS[pol.insurance_type] ?? "border-slate-200 bg-slate-50";
                          const textClass  = PLAN_TYPE_TEXT[pol.insurance_type]  ?? "text-slate-700";
                          return (
                            <div key={pol.id} className={`border-l-4 rounded-xl p-5 ${colorClass}`}>
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className={`text-sm font-bold ${textClass}`}>{pol.product_name}</p>
                                  <p className="text-xs text-slate-400 mt-0.5 font-semibold uppercase tracking-wider">
                                    {INSURANCE_TYPE_LABELS[pol.insurance_type] ?? pol.insurance_type}
                                  </p>
                                </div>
                                <span className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${textClass} bg-white/70 border border-current/20`}>
                                  {pol.term_years} yr
                                </span>
                              </div>
                              <div className="mt-4 grid grid-cols-2 gap-3">
                                <div>
                                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Coverage</span>
                                  <span className="text-sm font-bold text-slate-800">PKR {pol.coverage_amount.toLocaleString()}</span>
                                </div>
                                <div>
                                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Since</span>
                                  <span className="text-sm font-medium text-slate-600">{new Date(pol.created_at).toLocaleDateString()}</span>
                                </div>
                                {pol.dependent_name && (
                                  <div className="col-span-2">
                                    <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Dependent</span>
                                    <span className="text-sm font-medium text-slate-600">{pol.dependent_name} · {pol.dependent_dob}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end">
              <button
                onClick={() => setShowProfileModal(false)}
                className="px-5 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Close Profile
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
