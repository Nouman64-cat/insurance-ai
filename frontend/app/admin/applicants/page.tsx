"use client";

import { useState, useEffect } from "react";
import api from "@/app/services/api";

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
  const [applicants, setApplicants] = useState<Applicant[]>([]);
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

  // Core fields
  const [cnic, setCnic] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("Male");
  const [maritalStatus, setMaritalStatus] = useState("Single");
  const [nationality, setNationality] = useState("Pakistani");
  const [occupation, setOccupation] = useState("");
  const [declaredIncome, setDeclaredIncome] = useState("");
  const [formLoading, setFormLoading] = useState(false);

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
    }
  };

  const [details, setDetails] = useState<typeof defaultDetails>(defaultDetails);

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
    } catch (err: any) {
      setError(err.message ?? "Failed to load applicants directory.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreateModal = () => {
    setCnic("");
    setFirstName("");
    setLastName("");
    setDob("");
    setGender("Male");
    setMaritalStatus("Single");
    setNationality("Pakistani");
    setOccupation("");
    setDeclaredIncome("");
    setDetails(JSON.parse(JSON.stringify(defaultDetails)));
    setFormTab("demographics");
    setError("");
    setSuccess("");
    setShowCreateModal(true);
  };

  const handleCreateApplicant = async (e: React.FormEvent) => {
    e.preventDefault();
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
          declared_income: parseFloat(declaredIncome) || 0,
          annual_income: parseFloat(declaredIncome) || 0
        }
      };

      await api.post(`/tenants/${tenantId}/applicants`, {
        cnic,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: dob,
        gender,
        marital_status: maritalStatus,
        nationality,
        occupation,
        declared_income: parseFloat(declaredIncome) || 0,
        details: payloadDetails
      });

      setSuccess("Applicant registered successfully with full diagnostic profile!");
      setShowCreateModal(false);
      fetchApplicants();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Failed to register applicant.");
    } finally {
      setFormLoading(false);
    }
  };

  const handleOpenEditModal = (applicant: Applicant) => {
    setSelectedApplicant(applicant);
    setCnic(applicant.cnic);
    const parts = applicant.name.split(" ");
    setFirstName(parts[0] || "");
    setLastName(parts.slice(1).join(" ") || "");
    setDob(applicant.dob);
    setGender(applicant.gender);
    setOccupation(applicant.occupation);
    setDeclaredIncome(applicant.declared_income.toString());

    // Import existing details or fill defaults
    const importedDetails = applicant.details
      ? { ...defaultDetails, ...applicant.details }
      : JSON.parse(JSON.stringify(defaultDetails));

    setDetails(importedDetails);
    setFormTab("demographics");
    setError("");
    setSuccess("");
    setShowEditModal(true);
  };

  const handleEditApplicant = async (e: React.FormEvent) => {
    e.preventDefault();
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
          declared_income: parseFloat(declaredIncome) || 0,
          annual_income: parseFloat(declaredIncome) || 0
        }
      };

      await api.put(`/tenants/${tenantId}/applicants/${selectedApplicant.id}`, {
        cnic,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: dob,
        gender,
        occupation,
        declared_income: parseFloat(declaredIncome) || 0,
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

  const handleOpenProfileModal = (applicant: Applicant) => {
    setSelectedApplicant(applicant);
    const importedDetails = applicant.details
      ? { ...defaultDetails, ...applicant.details }
      : JSON.parse(JSON.stringify(defaultDetails));
    setDetails(importedDetails);
    setViewTab("demographics");
    setShowProfileModal(true);
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
    { id: "financial", label: "Financial Profile" },
    { id: "beneficiary", label: "Nominee Details" }
  ];

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
        <button
          onClick={handleOpenCreateModal}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-all shadow-sm hover:shadow active:scale-95 self-start"
        >
          Add Applicant
        </button>
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
                  <th className="px-5 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {applicants.map((applicant) => (
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
                ))}
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
            <div className="px-6 border-b border-slate-100 bg-white flex gap-1 overflow-x-auto whitespace-nowrap scrollbar-none">
              {tabs.map((tab) => (
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
                </button>
              ))}
            </div>

            {/* Scrollable Form Body */}
            <form onSubmit={showCreateModal ? handleCreateApplicant : handleEditApplicant} className="flex-1 overflow-y-auto p-6 space-y-6">
              
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
                          required
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Last Name *</label>
                        <input
                          type="text"
                          required
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC *</label>
                        <input
                          type="text"
                          required
                          value={cnic}
                          onChange={(e) => setCnic(formatCNIC(e.target.value))}
                          placeholder="35201-XXXXXXX-X"
                          maxLength={15}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Date of Birth *</label>
                        <input
                          type="date"
                          required
                          value={dob}
                          onChange={(e) => setDob(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Gender *</label>
                        <select
                          value={gender}
                          onChange={(e) => setGender(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        >
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Marital Status</label>
                        <select
                          value={maritalStatus}
                          onChange={(e) => setMaritalStatus(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        >
                          <option value="Single">Single</option>
                          <option value="Married">Married</option>
                          <option value="Divorced">Divorced</option>
                          <option value="Widowed">Widowed</option>
                        </select>
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Email Address</label>
                        <input
                          type="email"
                          value={details.contact.email}
                          onChange={(e) => updateField("contact", "email", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Emergency Contact Name</label>
                        <input
                          type="text"
                          value={details.contact.emergency_contact_name}
                          onChange={(e) => updateField("contact", "emergency_contact_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">City</label>
                        <input
                          type="text"
                          value={details.address.city}
                          onChange={(e) => updateField("address", "city", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Province</label>
                        <input
                          type="text"
                          value={details.address.province}
                          onChange={(e) => updateField("address", "province", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Postal Code</label>
                        <input
                          type="text"
                          value={details.address.postal_code}
                          onChange={(e) => updateField("address", "postal_code", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">CNIC Expiry Date</label>
                        <input
                          type="date"
                          value={details.cnic_metadata.expiry_date}
                          onChange={(e) => updateField("cnic_metadata", "expiry_date", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Validation Status</label>
                        <select
                          value={details.cnic_metadata.validation_status}
                          onChange={(e) => updateField("cnic_metadata", "validation_status", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                        <label className="text-xs font-semibold text-slate-600">Job Title / Designation *</label>
                        <input
                          type="text"
                          required
                          value={occupation}
                          onChange={(e) => setOccupation(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Employer Name</label>
                        <input
                          type="text"
                          value={details.occupation_details.employer_name}
                          onChange={(e) => updateField("occupation_details", "employer_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Industry Sector</label>
                        <input
                          type="text"
                          value={details.occupation_details.industry}
                          onChange={(e) => updateField("occupation_details", "industry", e.target.value)}
                          placeholder="e.g. IT, Healthcare"
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Years of Experience</label>
                        <input
                          type="number"
                          value={details.occupation_details.years_of_experience}
                          onChange={(e) => updateField("occupation_details", "years_of_experience", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Occupation Hazard Level</label>
                        <select
                          value={details.occupation_details.occupation_hazard_level}
                          onChange={(e) => updateField("occupation_details", "occupation_hazard_level", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          required
                          value={declaredIncome}
                          onChange={(e) => setDeclaredIncome(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Monthly Income Equivalent</label>
                        <input
                          type="number"
                          value={details.income_record.monthly_income}
                          onChange={(e) => updateField("income_record", "monthly_income", parseFloat(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Weight (kg)</label>
                        <input
                          type="number"
                          value={details.lifestyle.weight_kg}
                          onChange={(e) => updateField("lifestyle", "weight_kg", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Delinquencies count</label>
                        <input
                          type="number"
                          value={details.financial_records.credit_bureau.delinquency_count}
                          onChange={(e) => updateSubField("financial_records", "credit_bureau", "delinquency_count", parseInt(e.target.value) || 0)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Credit Bureau Risk Grade</label>
                        <select
                          value={details.financial_records.credit_bureau.risk_grade}
                          onChange={(e) => updateSubField("financial_records", "credit_bureau", "risk_grade", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Primary Dependent Type</label>
                        <select
                          value={details.financial_records.dependents.dependent_type}
                          onChange={(e) => updateSubField("financial_records", "dependents", "dependent_type", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Last Name</label>
                        <input
                          type="text"
                          value={details.beneficiary.last_name}
                          onChange={(e) => updateField("beneficiary", "last_name", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-600">Relationship</label>
                        <select
                          value={details.beneficiary.relationship}
                          onChange={(e) => updateField("beneficiary", "relationship", e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                    </div>
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
                {tabs.findIndex(t => t.id === formTab) > 0 && (
                  <button
                    type="button"
                    onClick={() => setFormTab(tabs[tabs.findIndex(t => t.id === formTab) - 1].id)}
                    className="px-5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
                  >
                    Previous
                  </button>
                )}
                {tabs.findIndex(t => t.id === formTab) < tabs.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => setFormTab(tabs[tabs.findIndex(t => t.id === formTab) + 1].id)}
                    className="px-5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg"
                  >
                    Next Step
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      if (showCreateModal) handleCreateApplicant(e);
                      else handleEditApplicant(e);
                    }}
                    disabled={formLoading}
                    className="px-6 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg shadow-sm"
                  >
                    {formLoading ? "Saving Profile..." : "Submit Profile Details"}
                  </button>
                )}
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
