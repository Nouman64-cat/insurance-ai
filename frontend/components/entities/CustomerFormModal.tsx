"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import api from "@/app/services/api";
import { listInsurancePlans, InsurancePlan } from "@/app/services/insurancePlans";
import { listBranches, Branch } from "@/app/services/branches";
import { listAgents, Agent } from "@/app/services/agents";
import { PAKISTAN_PROVINCES } from "@/lib/pakistanProvinces";
import { registerPendingQuote } from "@/lib/pendingQuotes";
import {
  customerCoreSchema,
  CustomerCoreForm,
  getPlanValidationError,
  INSURANCE_TYPE_LABELS,
  PLAN_TYPE_COLORS,
  PLAN_TYPE_TEXT,
  customerTabs,
  formatCNIC,
  defaultDetails,
  cloneDefaultDetails,
  CustomerDetails,
  Customer,
  Policy,
} from "./customerShared";

interface Props {
  open: boolean;
  mode: "create" | "edit";
  /** Required in edit mode. */
  customer?: Customer | null;
  onClose: () => void;
  /** Called after a successful create/update with a success message. */
  onSaved: (message: string) => void;
}

export default function CustomerFormModal({ open, mode, customer, onClose, onSaved }: Props) {
  const isCreate = mode === "create";

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [formLoading, setFormLoading] = useState(false);
  const [formTab, setFormTab] = useState("demographics");

  const {
    register,
    handleSubmit: hookFormSubmit,
    formState: { errors },
    reset,
    watch,
    setValue,
  } = useForm<CustomerCoreForm>({
    resolver: zodResolver(customerCoreSchema) as any,
    mode: "onSubmit",
    defaultValues: {
      gender: "Male",
      maritalStatus: "Single",
      nationality: "Pakistani",
      selectedPlanId: "",
    },
  });
  const formValues = watch();
  const { selectedPlanId } = formValues;

  const [details, setDetails] = useState<CustomerDetails>(defaultDetails);
  const [newDestination, setNewDestination] = useState("");
  const [newCondition, setNewCondition] = useState({ condition_name: "", severity: "Mild", diagnosis_date: "", is_chronic: false });
  const [newFamilyHistory, setNewFamilyHistory] = useState({ relation: "Father", age: "", is_alive: true, condition_name: "" });

  const [availablePlans, setAvailablePlans] = useState<InsurancePlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [isSuggestingPlan, setIsSuggestingPlan] = useState(false);
  const [suggestedReasoning, setSuggestedReasoning] = useState("");

  const [customerPolicies, setCustomerPolicies] = useState<Policy[]>([]);
  const [viewPoliciesLoading, setViewPoliciesLoading] = useState(false);
  const [editSelectedPlanId, setEditSelectedPlanId] = useState<string>("");
  const [editPolicyCoverage, setEditPolicyCoverage] = useState("");
  const [editPolicyTerm, setEditPolicyTerm] = useState("");
  const [editPolicyDependentName, setEditPolicyDependentName] = useState("");
  const [editPolicyDependentDob, setEditPolicyDependentDob] = useState("");
  const [editAddingPolicy, setEditAddingPolicy] = useState(false);
  const [editPolicyLoading, setEditPolicyLoading] = useState(false);

  // Assignment/location — real top-level columns (Customer.city/province/branch_id/assigned_agent_id),
  // kept separate from the `details` JSON blob so they're filterable server-side.
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [branchId, setBranchId] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [agentOptions, setAgentOptions] = useState<Agent[]>([]);

  // Initialize whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setError("");
    setSuccess("");
    setFormTab("demographics");
    setSuggestedReasoning("");

    const tenantId = localStorage.getItem("tenant_id");

    if (tenantId) {
      listBranches(tenantId).then(setBranchOptions).catch(() => setBranchOptions([]));
      listAgents(tenantId).then(setAgentOptions).catch(() => setAgentOptions([]));
    }

    if (isCreate) {
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
        policyDependentDob: "",
      });
      setDetails(cloneDefaultDetails());
      setCity("");
      setProvince("");
      setBranchId("");
      setAssignedAgentId("");
      if (tenantId) {
        setPlansLoading(true);
        listInsurancePlans(tenantId)
          .then((plans) => setAvailablePlans(plans.filter((p) => p.is_active)))
          .catch(() => setAvailablePlans([]))
          .finally(() => setPlansLoading(false));
      }
    } else if (customer) {
      const parts = customer.name.split(" ");
      reset({
        cnic: customer.cnic || "",
        firstName: parts[0] || "",
        lastName: parts.slice(1).join(" ") || "",
        dob: customer.dob || "",
        gender: (customer.gender as any) || "",
        occupation: customer.occupation || "",
        declaredIncome: customer.declared_income ?? undefined,
        maritalStatus: customer.details?.marital_status || "Single",
        nationality: customer.details?.nationality || "Pakistani",
      });
      const importedDetails = customer.details
        ? {
            ...cloneDefaultDetails(),
            ...customer.details,
            habit_check: {
              ...cloneDefaultDetails().habit_check,
              ...(customer.details.habit_check || {}),
            },
          }
        : cloneDefaultDetails();
      setDetails(importedDetails);

      // Fall back to the legacy details.address location for records saved before
      // city/province were promoted to top-level columns.
      setCity(customer.city ?? customer.details?.address?.city ?? "");
      setProvince(customer.province ?? customer.details?.address?.province ?? "");
      setBranchId(customer.branch_id || "");
      setAssignedAgentId(customer.assigned_agent_id || "");

      setEditSelectedPlanId("");
      setEditPolicyCoverage("");
      setEditPolicyTerm("");
      setEditPolicyDependentName("");
      setEditPolicyDependentDob("");
      setEditAddingPolicy(true);

      if (tenantId) {
        setViewPoliciesLoading(true);
        Promise.all([
          api.get(`/tenants/${tenantId}/customers/${customer.id}/policies`),
          listInsurancePlans(tenantId),
        ])
          .then(([polRes, plansRes]) => {
            setCustomerPolicies(polRes.data ?? []);
            setAvailablePlans((plansRes ?? []).filter((p: InsurancePlan) => p.status === "Active"));
          })
          .catch(() => setCustomerPolicies([]))
          .finally(() => setViewPoliciesLoading(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, customer]);

  const calculateBMI = (height: number, weight: number) => {
    if (!height || !weight) return 0;
    const hMeter = height / 100;
    return parseFloat((weight / (hMeter * hMeter)).toFixed(1));
  };

  const updateField = (section: keyof CustomerDetails, key: string, value: any) => {
    setDetails((prev) => {
      const updatedSection = { ...(prev[section] as any), [key]: value };
      if (section === "lifestyle" && (key === "height_cm" || key === "weight_kg")) {
        const h = key === "height_cm" ? parseFloat(value) : (prev.lifestyle as any).height_cm;
        const w = key === "weight_kg" ? parseFloat(value) : (prev.lifestyle as any).weight_kg;
        (updatedSection as any).bmi = calculateBMI(h, w);
      }
      return { ...prev, [section]: updatedSection };
    });
  };

  const updateSubField = (section: keyof CustomerDetails, sub: string, key: string, value: any) => {
    setDetails((prev: any) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [sub]: {
          ...prev[section][sub],
          [key]: value,
        },
      },
    }));
  };

  const addCondition = () => {
    if (!newCondition.condition_name) return;
    setDetails((prev) => ({ ...prev, conditions: [...prev.conditions, newCondition] }));
    setNewCondition({ condition_name: "", severity: "Mild", diagnosis_date: "", is_chronic: false });
  };

  const handleSuggestPlan = async () => {
    if (availablePlans.length === 0) return;
    setIsSuggestingPlan(true);
    setSuggestedReasoning("");
    setError("");
    try {
      const customerData = {
        ...formValues,
        ...details,
        age: formValues.dob ? new Date().getFullYear() - new Date(formValues.dob).getFullYear() : 30,
      };
      const res = await api.post(`/suggest-plan`, { customer: customerData, plans: availablePlans });
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

  const handleCreateCustomer = async (data: CustomerCoreForm) => {
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
      const payloadDetails = {
        ...details,
        income_record: {
          ...details.income_record,
          declared_income: data.declaredIncome,
          annual_income: data.declaredIncome,
        },
      };

      if (data.selectedPlanId) {
        const selectedPlan = availablePlans.find((p) => p.id === data.selectedPlanId);
        if (selectedPlan) {
          const planErr = getPlanValidationError(
            selectedPlan,
            data.policyCoverage,
            data.policyTerm,
            data.declaredIncome as any,
            data.dob,
            data.policyDependentName,
            data.policyDependentDob
          );
          if (planErr) {
            setError(planErr);
            setFormLoading(false);
            return;
          }
        }
      }

      const customerResp = await api.post<Customer>(`/tenants/${tenantId}/customers`, {
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
        city: city.trim() || null,
        province: province || null,
        branch_id: branchId || null,
        assigned_agent_id: assignedAgentId || null,
        details: payloadDetails,
      });

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
          await api.post(`/tenants/${tenantId}/customers/${customerResp.data.id}/policies`, policyPayload);
        }
      }

      registerPendingQuote(customerResp.data.id, customerResp.data.name);
      onSaved("Customer registered successfully with full diagnostic profile!");
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to register customer.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleEditCustomer = async (data: CustomerCoreForm) => {
    setError("");
    setSuccess("");
    setFormLoading(true);
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || !customer) {
      setError("No active context found.");
      setFormLoading(false);
      return;
    }
    try {
      const payloadDetails = {
        ...details,
        income_record: {
          ...details.income_record,
          declared_income: data.declaredIncome || null,
          annual_income: data.declaredIncome || null,
        },
      };

      const dobVal = data.dob && String(data.dob).trim() !== "" ? data.dob : null;
      const cnicVal = data.cnic && String(data.cnic).trim() !== "" ? data.cnic : null;
      const genderVal = data.gender && String(data.gender).trim() !== "" ? data.gender : null;
      const occupationVal = data.occupation && String(data.occupation).trim() !== "" ? data.occupation : null;
      const incomeVal = data.declaredIncome && String(data.declaredIncome).trim() !== "" ? parseFloat(String(data.declaredIncome)) : null;

      const planId = editSelectedPlanId || data.selectedPlanId;
      const coverage = editPolicyCoverage || data.policyCoverage;
      const term = editPolicyTerm || data.policyTerm;
      const depName = editPolicyDependentName || data.policyDependentName;
      const depDob = editPolicyDependentDob || data.policyDependentDob;

      if (planId) {
        const plan = availablePlans.find((p) => p.id === planId);
        if (plan) {
          const planErr = getPlanValidationError(
            plan,
            coverage,
            term,
            incomeVal ?? customer.declared_income,
            dobVal ?? customer.dob,
            depName,
            depDob
          );
          if (planErr) {
            setError(planErr);
            setFormLoading(false);
            return;
          }
        }
      }

      await api.put(`/tenants/${tenantId}/customers/${customer.id}`, {
        cnic: cnicVal,
        first_name: data.firstName,
        last_name: data.lastName,
        date_of_birth: dobVal,
        gender: genderVal,
        occupation: occupationVal,
        declared_income: incomeVal,
        is_smoker: !!payloadDetails.medical_history.is_smoker,
        height_cm: parseFloat(payloadDetails.lifestyle.height_cm as any) || 170.0,
        weight_kg: parseFloat(payloadDetails.lifestyle.weight_kg as any) || 70.0,
        city: city.trim() || null,
        province: province || null,
        branch_id: branchId || null,
        assigned_agent_id: assignedAgentId || null,
        details: payloadDetails,
      });

      if (planId && coverage && term) {
        const plan = availablePlans.find((p) => p.id === planId);
        if (plan) {
          const policyPayload: any = {
            plan_id: planId,
            product_name: plan.label,
            insurance_type: plan.insurance_type,
            coverage_amount: parseFloat(String(coverage)),
            term_years: parseInt(String(term)),
          };
          if (plan.insurance_type === "CHILD_EDUCATION_MARRIAGE") {
            policyPayload.dependent_name = depName || null;
            policyPayload.dependent_dob = depDob || null;
          }
          await api.post(`/tenants/${tenantId}/customers/${customer.id}/policies`, policyPayload);
        }
      }

      onSaved("Customer profile updated successfully!");
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to update customer.");
    } finally {
      setFormLoading(false);
    }
  };

  const onSubmit = (data: any) => (isCreate ? handleCreateCustomer(data) : handleEditCustomer(data));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <div>
            <h3 className="text-base font-bold text-slate-900">{isCreate ? "Add New Customer" : "Edit Customer"}</h3>
            <p className="text-xs text-slate-500 mt-0.5">Please populate the structured underwriting variables below.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>

        {/* Tab navigation */}
        <div className="px-6 border-b border-slate-100 bg-white flex flex-wrap gap-1">
          {customerTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFormTab(tab.id)}
              className={`px-4 py-3 text-xs font-semibold border-b-2 transition-all ${formTab === tab.id
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
        <form id="customer-main-form" onSubmit={hookFormSubmit(onSubmit)} className="flex-1 overflow-y-auto p-6 space-y-6">

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 text-xs text-red-600 font-medium flex justify-between items-center shadow-sm">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError("")}
                className="text-red-400 hover:text-red-700 font-bold ml-3 text-xs leading-none cursor-pointer hover:bg-red-100 p-1 rounded-md transition-colors"
                title="Close"
              >
                ✕
              </button>
            </div>
          )}
          {success && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 text-xs text-emerald-600 font-medium flex justify-between items-center shadow-sm">
              <span>{success}</span>
              <button
                type="button"
                onClick={() => setSuccess("")}
                className="text-emerald-400 hover:text-emerald-700 font-bold ml-3 text-xs leading-none cursor-pointer hover:bg-emerald-100 p-1 rounded-md transition-colors"
                title="Close"
              >
                ✕
              </button>
            </div>
          )}

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
                      {...register("firstName")}
                      className={`w-full bg-slate-50 border ${errors.firstName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                    />
                    {errors.firstName && <span className="text-[10px] text-red-500">{errors.firstName.message}</span>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-600">Last Name *</label>
                    <input
                      type="text"
                      {...register("lastName")}
                      className={`w-full bg-slate-50 border ${errors.lastName ? 'border-red-400' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                    />
                    {errors.lastName && <span className="text-[10px] text-red-500">{errors.lastName.message}</span>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-600">CNIC (Optional for Lead)</label>
                    <input
                      type="text"
                      {...register("cnic", {
                        onChange: (e) => {
                          e.target.value = formatCNIC(e.target.value);
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
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="e.g. Lahore"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-600">Province</label>
                    <select
                      value={province}
                      onChange={(e) => setProvince(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                    >
                      <option value="">Select province</option>
                      {PAKISTAN_PROVINCES.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
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

              <hr className="border-slate-100" />

              <div>
                <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Assignment</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-600">Branch</label>
                    <select
                      value={branchId}
                      onChange={(e) => setBranchId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                    >
                      <option value="">Unassigned</option>
                      {branchOptions.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-600">Assigned Agent</label>
                    <select
                      value={assignedAgentId}
                      onChange={(e) => setAssignedAgentId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900"
                    >
                      <option value="">Unassigned</option>
                      {agentOptions.map((a) => (
                        <option key={a.id} value={a.id}>{a.full_name}</option>
                      ))}
                    </select>
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
                      {...register("occupation")}
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
                      <span className="block text-[10px] text-slate-400 font-normal">Check if the customer has used illegal or non-prescribed substances.</span>
                    </div>
                  </label>
                </div>
              </div>

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
                      <span className="block text-[10px] text-slate-400 font-normal">Check if the customer has felony convictions or pending criminal charges.</span>
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

          {/* TAB 7: Insurance Plans (edit mode) */}
          {formTab === "insurance_plan" && !isCreate && (
            <div className="space-y-6">
              <div>
                <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1">Insurance Plans</h4>
                <p className="text-xs text-slate-400 mb-5">Existing policies for this customer. You can assign an additional plan below.</p>

                {viewPoliciesLoading ? (
                  <div className="flex items-center gap-2 py-6 justify-center">
                    <div className="animate-spin h-5 w-5 rounded-full border-2 border-slate-100 border-t-blue-500" />
                    <span className="text-xs text-slate-400">Loading policies...</span>
                  </div>
                ) : customerPolicies.length === 0 ? (
                  <div className="text-center py-8 text-sm text-slate-400 italic">No policies assigned yet.</div>
                ) : (
                  <div className="space-y-3 mb-6">
                    {customerPolicies.map((pol) => {
                      const colorClass = PLAN_TYPE_COLORS[pol.insurance_type] ?? "border-slate-200 bg-slate-50";
                      const textClass = PLAN_TYPE_TEXT[pol.insurance_type] ?? "text-slate-700";
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
                          const textClass = PLAN_TYPE_TEXT[plan.insurance_type] ?? "text-slate-700";
                          return (
                            <button
                              key={plan.id}
                              type="button"
                              onClick={() => {
                                const nextId = isSelected ? "" : plan.id;
                                setEditSelectedPlanId(nextId);
                                setValue("selectedPlanId", nextId);
                                if (!isSelected) {
                                  setEditPolicyCoverage("");
                                  setEditPolicyTerm(String(plan.term_min_years));
                                  setValue("policyCoverage", "");
                                  setValue("policyTerm", String(plan.term_min_years));
                                }
                              }}
                              className={`relative w-full text-left p-4 rounded-xl border-2 transition-all ${isSelected
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

                      const currentIncome = parseFloat(String(watch("declaredIncome") || customer?.declared_income || 0));
                      const maxIncomeCoverage = currentIncome > 0 && plan.max_income_multiple ? currentIncome * plan.max_income_multiple : null;

                      const coverageNum = parseFloat(String(editPolicyCoverage || 0));
                      const termNum = parseInt(String(editPolicyTerm || 0));

                      const isTermOutOfRange = editPolicyTerm !== "" && (termNum < plan.term_min_years || termNum > plan.term_max_years);
                      const isCoverageOverLimit = editPolicyCoverage !== "" && maxIncomeCoverage !== null && coverageNum > maxIncomeCoverage;

                      const customerDob = watch("dob") || customer?.dob;
                      let ageNotice: string | null = null;
                      if (customerDob) {
                        const bYear = new Date(customerDob).getFullYear();
                        if (!isNaN(bYear)) {
                          const age = new Date().getFullYear() - bYear;
                          if (age < plan.entry_age_min || age > plan.entry_age_max) {
                            ageNotice = `Customer age (${age} yrs) is outside allowed entry age range (${plan.entry_age_min}–${plan.entry_age_max} yrs) for ${plan.label}.`;
                          }
                        }
                      }

                      return (
                        <div className="space-y-4 pt-2">
                          {ageNotice && (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 font-medium flex items-center gap-2">
                              <span>⚠️ {ageNotice}</span>
                            </div>
                          )}

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1">
                              <label className="text-xs font-semibold text-slate-600">Coverage Amount (PKR) *</label>
                              <input
                                type="number" min={0}
                                value={editPolicyCoverage}
                                onChange={(e) => {
                                  setEditPolicyCoverage(e.target.value);
                                  setValue("policyCoverage", e.target.value);
                                }}
                                placeholder="e.g. 5000000"
                                className={`w-full bg-white border ${isCoverageOverLimit ? 'border-red-500 bg-red-50/20 ring-1 ring-red-500 text-red-900' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                              />
                              {isCoverageOverLimit ? (
                                <span className="block text-[11px] font-semibold text-red-600 mt-1">
                                  ❌ Exceeds max limit of PKR {maxIncomeCoverage!.toLocaleString()} ({plan.max_income_multiple}× declared income)
                                </span>
                              ) : (
                                <p className="text-[10px] text-slate-400">
                                  {maxIncomeCoverage ? `Max allowed: PKR ${maxIncomeCoverage.toLocaleString()} (${plan.max_income_multiple}× declared income)` : `Max ${plan.max_income_multiple}× declared income`}
                                </p>
                              )}
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-semibold text-slate-600">Policy Term (Years) *</label>
                              <input
                                type="number"
                                min={plan.term_min_years} max={plan.term_max_years}
                                value={editPolicyTerm}
                                onChange={(e) => {
                                  setEditPolicyTerm(e.target.value);
                                  setValue("policyTerm", e.target.value);
                                }}
                                className={`w-full bg-white border ${isTermOutOfRange ? 'border-red-500 bg-red-50/20 ring-1 ring-red-500 text-red-900' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                              />
                              {isTermOutOfRange ? (
                                <span className="block text-[11px] font-semibold text-red-600 mt-1">
                                  ❌ Invalid term: Must be between {plan.term_min_years}–{plan.term_max_years} yrs
                                </span>
                              ) : (
                                <p className="text-[10px] text-slate-400">Allowed range: {plan.term_min_years}–{plan.term_max_years} yrs</p>
                              )}
                            </div>
                          </div>
                          {plan.insurance_type === "CHILD_EDUCATION_MARRIAGE" && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="space-y-1">
                                <label className="text-xs font-semibold text-slate-600">Dependent Name *</label>
                                <input
                                  type="text"
                                  value={editPolicyDependentName}
                                  onChange={(e) => {
                                    setEditPolicyDependentName(e.target.value);
                                    setValue("policyDependentName", e.target.value);
                                  }}
                                  placeholder="Child's full name"
                                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs font-semibold text-slate-600">Dependent Date of Birth</label>
                                <input
                                  type="date"
                                  value={editPolicyDependentDob}
                                  onChange={(e) => {
                                    setEditPolicyDependentDob(e.target.value);
                                    setValue("policyDependentDob", e.target.value);
                                  }}
                                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
                                />
                              </div>
                            </div>
                          )}
                          <button
                            type="button"
                            disabled={editPolicyLoading || !editPolicyCoverage || !editPolicyTerm || isTermOutOfRange || isCoverageOverLimit}
                            onClick={async () => {
                              const tenantId = localStorage.getItem("tenant_id");
                              if (!tenantId || !customer) return;

                              const valErr = getPlanValidationError(
                                plan,
                                editPolicyCoverage,
                                editPolicyTerm,
                                currentIncome,
                                customerDob,
                                editPolicyDependentName,
                                editPolicyDependentDob
                              );
                              if (valErr) {
                                setError(valErr);
                                return;
                              }

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
                                  payload.dependent_dob = editPolicyDependentDob || null;
                                }
                                await api.post(`/tenants/${tenantId}/customers/${customer.id}/policies`, payload);
                                const res = await api.get(`/tenants/${tenantId}/customers/${customer.id}/policies`);
                                setCustomerPolicies(res.data ?? []);
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
                            className="w-full py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-lg transition-colors"
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

          {/* TAB 7: Insurance Plan (create mode) */}
          {formTab === "insurance_plan" && isCreate && (
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
                          className={`relative w-full text-left p-4 rounded-xl border-2 transition-all ${isSelected
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

                  const currentIncome = parseFloat(String(watch("declaredIncome") || 0));
                  const maxIncomeCoverage = currentIncome > 0 && plan.max_income_multiple ? currentIncome * plan.max_income_multiple : null;

                  const coverageVal = watch("policyCoverage");
                  const termVal = watch("policyTerm");

                  const coverageNum = parseFloat(String(coverageVal || 0));
                  const termNum = parseInt(String(termVal || 0));

                  const isTermOutOfRange = termVal !== undefined && termVal !== "" && (termNum < plan.term_min_years || termNum > plan.term_max_years);
                  const isCoverageOverLimit = coverageVal !== undefined && coverageVal !== "" && maxIncomeCoverage !== null && coverageNum > maxIncomeCoverage;

                  const customerDob = watch("dob");
                  let ageNotice: string | null = null;
                  if (customerDob) {
                    const bYear = new Date(customerDob).getFullYear();
                    if (!isNaN(bYear)) {
                      const age = new Date().getFullYear() - bYear;
                      if (age < plan.entry_age_min || age > plan.entry_age_max) {
                        ageNotice = `Customer age (${age} yrs) is outside allowed entry age range (${plan.entry_age_min}–${plan.entry_age_max} yrs) for ${plan.label}.`;
                      }
                    }
                  }

                  return (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                      <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Plan Configuration</h4>

                      {ageNotice && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 font-medium flex items-center gap-2">
                          <span>⚠️ {ageNotice}</span>
                        </div>
                      )}

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
                            className={`w-full bg-white border ${isCoverageOverLimit || errors.policyCoverage ? 'border-red-500 bg-red-50/20 ring-1 ring-red-500 text-red-900' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                          />
                          {isCoverageOverLimit ? (
                            <span className="block text-[11px] font-semibold text-red-600 mt-1">
                              ❌ Exceeds max limit of PKR {maxIncomeCoverage!.toLocaleString()} ({plan.max_income_multiple}× declared income)
                            </span>
                          ) : errors.policyCoverage ? (
                            <span className="text-[10px] text-red-500">{errors.policyCoverage.message}</span>
                          ) : (
                            <p className="text-[10px] text-slate-400">
                              {maxIncomeCoverage ? `Max limit: PKR ${maxIncomeCoverage.toLocaleString()} (${plan.max_income_multiple}× declared income)` : `Max ${plan.max_income_multiple}× declared income`}
                            </p>
                          )}
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
                            className={`w-full bg-white border ${isTermOutOfRange || errors.policyTerm ? 'border-red-500 bg-red-50/20 ring-1 ring-red-500 text-red-900' : 'border-slate-200'} rounded-lg px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400`}
                          />
                          {isTermOutOfRange ? (
                            <span className="block text-[11px] font-semibold text-red-600 mt-1">
                              ❌ Invalid term: Must be between {plan.term_min_years}–{plan.term_max_years} yrs
                            </span>
                          ) : errors.policyTerm ? (
                            <span className="text-[10px] text-red-500">{errors.policyTerm.message}</span>
                          ) : (
                            <p className="text-[10px] text-slate-400">
                              Allowed range: {plan.term_min_years}–{plan.term_max_years} years
                            </p>
                          )}
                        </div>
                      </div>

                      {plan.insurance_type === "CHILD_EDUCATION_MARRIAGE" && (
                        <>
                          <hr className="border-slate-200" />
                          <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Dependent / Child Details</h5>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1">
                              <label className="text-xs font-semibold text-slate-600">Dependent Name *</label>
                              <input
                                type="text"
                                {...register("policyDependentName")}
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
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
          <div className="flex gap-3">
            {(() => {
              const currentIdx = customerTabs.findIndex(t => t.id === formTab);
              return (
                <>
                  {currentIdx > 0 && (
                    <button
                      type="button"
                      onClick={() => setFormTab(customerTabs[currentIdx - 1].id)}
                      className="px-5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
                    >
                      Previous
                    </button>
                  )}
                  {currentIdx < customerTabs.length - 1 ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setFormTab(customerTabs[currentIdx + 1].id)}
                        className="px-5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg"
                      >
                        Next Step
                      </button>
                      <button
                        type="button"
                        onClick={hookFormSubmit(onSubmit)}
                        disabled={formLoading}
                        className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg shadow-sm cursor-pointer"
                      >
                        {formLoading ? "Saving..." : isCreate ? "Register Customer" : "Update Profile"}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={hookFormSubmit(onSubmit)}
                      disabled={formLoading}
                      className="px-6 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg shadow-sm cursor-pointer"
                    >
                      {formLoading ? "Saving Profile..." : isCreate ? "Register Customer" : "Update Profile"}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>

      </div>
    </div>
  );
}
