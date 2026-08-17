"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import api from "@/app/services/api";
import { useNotify } from "@/components/NotificationContext";

interface RuleSet {
  id: string;
  code: string;
  name: string;
  domain: string;
  description: string;
  is_active: boolean;
  active_version_no: number | null;
  active_version_status: string;
  version_count: number;
  rule_count: number;
  updated_at: string;
}

interface BusinessRule {
  id: string;
  name: string;
  priority: number;
  condition_operator: string;
  conditions: Array<{ field: string; operator: string; value: any }>;
  action_outcome: string;
  outcome_payload: Record<string, any>;
  is_enabled: boolean;
}

interface RuleVersion {
  id: string;
  version_no: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  effective_from: string;
  effective_to?: string | null;
  authored_by: string;
  approved_by?: string | null;
  notes?: string | null;
  rules: BusinessRule[];
}

interface RuleSetDetail extends RuleSet {
  versions: RuleVersion[];
}

interface AuditLog {
  id: string;
  rule_set_code: string;
  rule_version_no: number;
  case_id?: string | null;
  actor?: string | null;
  input_context: Record<string, any>;
  outcome: Record<string, any>;
  reasons: string[];
  evaluated_at: string;
}

const DOMAINS = [
  { key: "ALL", label: "All Rule Categories" },
  { key: "ELIGIBILITY", label: "Eligibility & Policy Limits" },
  { key: "PRICING", label: "Pricing & Risk Loadings" },
  { key: "UNDERWRITING_GATES", label: "Underwriting Clearance Gates" },
  { key: "COMPLIANCE_AML", label: "AML & Sanctions Compliance" },
  { key: "MEDICAL_NML", label: "Medical Examination Limits" },
  { key: "INSURANCE_HISTORY", label: "Insurance & Financial History" },
  { key: "COMMISSION_SECP", label: "SECP Statutory Commission Rates" },
  { key: "RBAC_AUTHORIZATION", label: "Role Authorization Rules" },
  { key: "AI_DECISION_BANDS", label: "AI Underwriting Risk Bands" },
  { key: "REINSURANCE", label: "Reinsurance & Retention" },
];

// Plain English field translations for non-technical users
const FIELD_LABELS: Record<string, string> = {
  age: "Applicant Age",
  sum_assured: "Sum Assured",
  is_smoker: "Smoker Status",
  sanctions_matched: "UN / SECP Sanctions Match",
  is_pep: "Politically Exposed Person (PEP)",
  annual_premium: "Annual Premium",
  category: "Policy Category",
  policy_year: "Policy Duration Year",
  bmi: "Body Mass Index (BMI)",
  composite_score: "AI Risk Score (0-100)",
};

// Plain English operator phrases
const OPERATOR_TEXT: Record<string, string> = {
  eq: "is equal to",
  "==": "is equal to",
  equals: "is equal to",
  ne: "is not equal to",
  "!=": "is not equal to",
  not_equals: "is not equal to",
  gt: "is greater than (>)",
  ">": "is greater than (>)",
  gte: "is at least (≥)",
  ">=": "is at least (≥)",
  lt: "is less than (<)",
  "<": "is less than (<)",
  lte: "is at most (≤)",
  "<=": "is at most (≤)",
  boolean: "is",
  is: "is",
  between: "is between",
  in: "is one of",
  contains: "contains",
};

// Unified Portal Color Badges (Strictly Blue & Slate Theme)
const ACTION_OUTCOMES: Record<string, { label: string; badge: string }> = {
  REQUIRE_MEDICAL_EXAM: {
    label: "Require Panel Medical Exam",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  WAIVE_MEDICAL: {
    label: "Waive Medical Exam (Standard Limit)",
    badge: "bg-slate-100 text-slate-700 border-slate-200 font-semibold",
  },
  BLOCK_APPLICATION: {
    label: "Block Application (Sanctions)",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  REQUIRE_MANUAL_CLEARANCE: {
    label: "Require Senior Compliance Sign-off",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  REQUIRE_ENHANCED_DUE_DILIGENCE: {
    label: "Require Source of Funds (EDD)",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  APPLY_COMMISSION_RATE: {
    label: "Apply Statutory Commission",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  APPLY_LOADING: {
    label: "Apply Premium Risk Surcharge",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  AUTO_APPROVE: {
    label: "Auto Approve Policy",
    badge: "bg-slate-100 text-slate-700 border-slate-200 font-semibold",
  },
  APPROVE_WITH_LOADING: {
    label: "Approve with Loading / Counter-Offer",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
  HUMAN_REVIEW: {
    label: "Escalate to Senior Underwriter",
    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
  },
};

function formatValue(field: string, val: any): string {
  if (val === true) return "Yes";
  if (val === false) return "No";
  if (typeof val === "number") {
    if (field === "sum_assured" || field === "annual_premium") {
      return `${val.toLocaleString()} PKR`;
    }
    return val.toString();
  }
  if (Array.isArray(val)) {
    return val.map((v) => (typeof v === "number" ? v.toLocaleString() : String(v))).join(" and ");
  }
  return String(val);
}

function formatConditionSentence(cond: { field: string; operator: string; value: any }): { fieldLabel: string; opLabel: string; valLabel: string } {
  const fieldLabel = FIELD_LABELS[cond.field] || cond.field;
  const opLabel = OPERATOR_TEXT[cond.operator?.toLowerCase()] || cond.operator;
  const valLabel = formatValue(cond.field, cond.value);
  return { fieldLabel, opLabel, valLabel };
}

export default function RuleEnginePage() {
  const { notify } = useNotify();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"catalog" | "simulator" | "logs">("catalog");
  const [selectedDomain, setSelectedDomain] = useState<string>("ALL");
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");

  // Selected Rule Set detail view
  const [selectedRuleSetId, setSelectedRuleSetId] = useState<string | null>(null);
  const [ruleSetDetail, setRuleSetDetail] = useState<RuleSetDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedRule, setSelectedRule] = useState<any | null>(null);

  // New Rule Set Modal
  const [showCreateSetModal, setShowCreateSetModal] = useState(false);
  const [newSetCode, setNewSetCode] = useState("");
  const [newSetName, setNewSetName] = useState("");
  const [newSetDomain, setNewSetDomain] = useState("ELIGIBILITY");
  const [newSetDesc, setNewSetDesc] = useState("");

  // New Rule Modal
  const [showAddRuleModal, setShowAddRuleModal] = useState(false);
  const [isEditingRule, setIsEditingRule] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  
  const [ruleName, setRuleName] = useState("");
  const [ruleCode, setRuleCode] = useState("");
  const [ruleDescription, setRuleDescription] = useState("");
  const [ruleCategory, setRuleCategory] = useState("");
  const [ruleSubcategory, setRuleSubcategory] = useState("");
  const [ruleEligibility, setRuleEligibility] = useState("");
  
  const [rulePriority, setRulePriority] = useState<number>(10);
  const [ruleOperator, setRuleOperator] = useState<"ALL" | "ANY">("ALL");
  const [ruleAction, setRuleAction] = useState("REQUIRE_MEDICAL_EXAM");
  const [ruleReason, setRuleReason] = useState("");
  const [condField, setCondField] = useState("age");
  const [condOp, setCondOp] = useState("gte");
  const [condValue, setCondValue] = useState("50");

  // Friendly Simulator Form State (Non-Technical)
  const [simRuleCode, setSimRuleCode] = useState("medical.nml_grid");
  const [simForm, setSimForm] = useState({
    age: 52,
    sum_assured: 6000000,
    category: "Individual",
    policy_year: 1,
    is_smoker: true,
    bmi: 31,
    composite_score: 45,
    is_pep: false,
    sanctions_matched: false,
  });
  const [showAdvancedJson, setShowAdvancedJson] = useState(false);
  const [simContextJson, setSimContextJson] = useState("");
  const [simResult, setSimResult] = useState<any>(null);
  const [simulating, setSimulating] = useState(false);

  // Audit logs
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    const tid = localStorage.getItem("tenant_id");
    if (tid) {
      setTenantId(tid);
      fetchRuleSets(tid);
    } else {
      setError("No active organization tenant found. Please log in.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Keep JSON string synced with friendly form state
    setSimContextJson(JSON.stringify(simForm, null, 2));
  }, [simForm]);

  const fetchRuleSets = async (tid: string, domainFilter?: string) => {
    try {
      setLoading(true);
      setError("");
      const domain = domainFilter || selectedDomain;
      const url = domain && domain !== "ALL"
        ? `/tenants/${tid}/rules/sets?domain=${domain}`
        : `/tenants/${tid}/rules/sets`;
      const res = await api.get(url);
      setRuleSets(res.data);
    } catch (err: any) {
      setError(err.message || "Failed to load rule sets.");
    } finally {
      setLoading(false);
    }
  };

  const fetchRuleSetDetail = async (ruleSetId: string) => {
    if (!tenantId) return;
    try {
      setLoadingDetail(true);
      const res = await api.get(`/tenants/${tenantId}/rules/sets/${ruleSetId}`);
      setRuleSetDetail(res.data);
      if (res.data.versions && res.data.versions.length > 0) {
        const active = res.data.versions.find((v: RuleVersion) => v.status === "ACTIVE") || res.data.versions[0];
        setSelectedVersionId(active.id);
      }
    } catch (err: any) {
      notify(`Failed to fetch rule set detail: ${err.message}`, false);
    } finally {
      setLoadingDetail(false);
    }
  };

  const fetchAuditLogs = async () => {
    if (!tenantId) return;
    try {
      setLoadingLogs(true);
      const res = await api.get(`/tenants/${tenantId}/rules/logs`);
      setLogs(res.data);
    } catch (err: any) {
      notify(`Failed to fetch audit logs: ${err.message}`, false);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleDomainSelect = (domain: string) => {
    setSelectedDomain(domain);
    setSelectedRuleSetId(null);
    setRuleSetDetail(null);
    if (tenantId) {
      fetchRuleSets(tenantId, domain);
    }
  };

  const handleCreateRuleSet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId || !newSetCode || !newSetName) return;
    try {
      await api.post(`/tenants/${tenantId}/rules/sets`, {
        code: newSetCode.toLowerCase().trim(),
        name: newSetName,
        domain: newSetDomain,
        description: newSetDesc,
      });
      notify("Rule set created successfully!", true);
      setShowCreateSetModal(false);
      setNewSetCode("");
      setNewSetName("");
      setNewSetDesc("");
      fetchRuleSets(tenantId);
    } catch (err: any) {
      notify(err.message || "Failed to create rule set.", false);
    }
  };

  const handleCreateVersion = async () => {
    if (!tenantId || !ruleSetDetail) return;
    try {
      const res = await api.post(`/tenants/${tenantId}/rules/sets/${ruleSetDetail.id}/versions`);
      notify(`Created draft version v${res.data.version_no}`, true);
      fetchRuleSetDetail(ruleSetDetail.id);
    } catch (err: any) {
      notify(err.message || "Failed to create version.", false);
    }
  };

  const handleDeployVersion = async (versionId: string) => {
    if (!tenantId || !ruleSetDetail) return;
    try {
      await api.patch(`/tenants/${tenantId}/rules/versions/${versionId}/status`, {
        status: "ACTIVE",
        approved_by: "Compliance Officer",
      });
      notify("Version activated & deployed successfully!", true);
      fetchRuleSetDetail(ruleSetDetail.id);
      fetchRuleSets(tenantId);
    } catch (err: any) {
      notify(err.message || "Failed to deploy version.", false);
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId || !selectedVersionId || !ruleName || !ruleAction) return;

    let parsedVal: any = condValue;
    if (condValue.toLowerCase() === "true") parsedVal = true;
    else if (condValue.toLowerCase() === "false") parsedVal = false;
    else if (!isNaN(Number(condValue)) && condValue.trim() !== "") parsedVal = Number(condValue);

    const newRulePayload = {
      name: ruleName,
      code: ruleCode,
      description: ruleDescription,
      category: ruleCategory,
      subcategory: ruleSubcategory,
      eligibility_criteria: ruleEligibility,
      priority: Number(rulePriority),
      condition_operator: ruleOperator,
      conditions: condField ? [{ field: condField, operator: condOp, value: parsedVal }] : [],
      action_outcome: ruleAction,
      outcome_payload: { reason: ruleReason || ruleName },
      is_enabled: true,
    };

    try {
      if (isEditingRule && editingRuleId) {
        await api.put(`/tenants/${tenantId}/rules/versions/${selectedVersionId}/rules/${editingRuleId}`, newRulePayload);
        notify("Rule updated successfully!", true);
      } else {
        await api.post(`/tenants/${tenantId}/rules/versions/${selectedVersionId}/rules`, newRulePayload);
        notify("Rule added to version successfully!", true);
      }
      
      setShowAddRuleModal(false);
      setIsEditingRule(false);
      setEditingRuleId(null);
      setRuleName("");
      setRuleCode("");
      setRuleDescription("");
      setRuleCategory("");
      setRuleSubcategory("");
      setRuleEligibility("");
      setRuleAction("REQUIRE_MEDICAL_EXAM");
      setRuleReason("");
      setCondField("age");
      setCondValue("50");
      if (selectedRuleSetId) fetchRuleSetDetail(selectedRuleSetId);
    } catch (err: any) {
      notify(err.message || "Failed to save rule.", false);
    }
  };

  const openEditRuleModal = (rule: any) => {
    setIsEditingRule(true);
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleCode(rule.code || "");
    setRuleDescription(rule.description || "");
    setRuleCategory(rule.category || "");
    setRuleSubcategory(rule.subcategory || "");
    setRuleEligibility(rule.eligibility_criteria || "");
    setRulePriority(rule.priority);
    setRuleOperator(rule.condition_operator);
    setRuleAction(rule.action_outcome);
    setRuleReason(rule.outcome_payload?.reason || "");
    if (rule.conditions && rule.conditions.length > 0) {
      setCondField(rule.conditions[0].field);
      setCondOp(rule.conditions[0].operator);
      setCondValue(rule.conditions[0].value != null ? String(rule.conditions[0].value) : "");
    }
    setShowAddRuleModal(true);
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!tenantId) return;
    try {
      await api.delete(`/tenants/${tenantId}/rules/rules/${ruleId}`);
      notify("Rule deleted.", true);
      if (selectedRuleSetId) fetchRuleSetDetail(selectedRuleSetId);
    } catch (err: any) {
      notify(err.message || "Failed to delete rule.", false);
    }
  };

  const handleRunSimulation = async () => {
    if (!tenantId) return;
    setSimulating(true);
    setSimResult(null);

    let parsedCtx = simForm;
    if (showAdvancedJson) {
      try {
        parsedCtx = JSON.parse(simContextJson);
      } catch (e) {
        notify("Invalid JSON format in test payload.", false);
        setSimulating(false);
        return;
      }
    }

    try {
      const res = await api.post(`/tenants/${tenantId}/rules/evaluate`, {
        rule_set_code: simRuleCode,
        context: parsedCtx,
        actor: "Underwriter Tester",
      });
      setSimResult(res.data);
      notify("Rule evaluation complete!", true);
    } catch (err: any) {
      notify(err.message || "Simulation failed.", false);
    } finally {
      setSimulating(false);
    }
  };

  const currentVersionObj = ruleSetDetail?.versions.find((v) => v.id === selectedVersionId);

  return (
    <div className="px-6 pt-5 pb-24 space-y-5 max-w-screen-2xl mx-auto w-full font-sans text-slate-800">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-50 text-blue-600 border border-blue-100 rounded-lg">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Business Rule Engine</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Manage portal underwriting rules, medical limits, SECP commission cards, and compliance guidelines without coding.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              if (activeTab === "logs") fetchAuditLogs();
              else if (tenantId) fetchRuleSets(tenantId);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 shadow-sm transition"
          >
            <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>

          <button
            onClick={() => setShowCreateSetModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition active:scale-95"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Rule Set
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 gap-6 text-xs font-medium">
        <button
          onClick={() => setActiveTab("catalog")}
          className={`pb-3 flex items-center gap-2 transition border-b-2 ${activeTab === "catalog"
            ? "border-blue-600 text-blue-600 font-semibold"
            : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          Rule Catalog & Decision Guidelines
        </button>

        {/* 
        <button
          onClick={() => setActiveTab("simulator")}
          className={`pb-3 flex items-center gap-2 transition border-b-2 ${activeTab === "simulator"
            ? "border-blue-600 text-blue-600 font-semibold"
            : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Test & Simulate Rules
        </button>
        */}

        {/*
        <button
          onClick={() => {
            setActiveTab("logs");
            fetchAuditLogs();
          }}
          className={`pb-3 flex items-center gap-2 transition border-b-2 ${activeTab === "logs"
            ? "border-blue-600 text-blue-600 font-semibold"
            : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          SECP Regulatory Audit Trail
        </button>
        */}
      </div>

      {/* TABS CONTENT */}

      {/* TAB 1: CATALOG */}
      {activeTab === "catalog" && (
        <div className="space-y-5">
          {/* Domain Filter Pills (Standard Blue Portal Theme) */}
          <div className="flex flex-wrap gap-2">
            {DOMAINS.map((d) => {
              const isAll = d.key === "ALL";
              const isActive = selectedDomain === d.key;
              
              let btnClass = "";
              if (isAll) {
                btnClass = isActive 
                  ? "bg-slate-800 text-white border-slate-800 shadow-sm font-semibold" 
                  : "bg-slate-200 text-slate-800 border-slate-300 hover:bg-slate-300 hover:text-slate-900 font-semibold shadow-sm";
              } else {
                btnClass = isActive
                  ? "bg-blue-600 text-white border-blue-600 shadow-sm font-semibold"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900";
              }

              return (
                <button
                  key={d.key}
                  onClick={() => handleDomainSelect(d.key)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium border transition ${btnClass}`}
                >
                  {isAll && (
                    <svg className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                    </svg>
                  )}
                  {d.label}
                </button>
              );
            })}
          </div>

          {/* Catalog Layout */}
          <div>
            <div className="flex items-center justify-between px-1 mb-4">
              <h2 className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                Rule Categories ({ruleSets.length})
              </h2>
              {/* View Mode Toggle */}
              <div className="flex items-center bg-slate-100 p-1 rounded-xl shadow-inner border border-slate-200">
                <button
                  onClick={() => setViewMode("grid")}
                  title="Grid View"
                  className={`p-2 rounded-lg transition-all ${viewMode === "grid"
                    ? "bg-white text-blue-600 shadow-sm border border-slate-200"
                    : "text-slate-400 hover:text-slate-600 hover:bg-slate-200"
                    }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <rect x="3" y="3" width="7" height="7"></rect>
                    <rect x="14" y="3" width="7" height="7"></rect>
                    <rect x="14" y="14" width="7" height="7"></rect>
                    <rect x="3" y="14" width="7" height="7"></rect>
                  </svg>
                </button>
                <button
                  onClick={() => setViewMode("list")}
                  title="List View"
                  className={`p-2 rounded-lg transition-all ${viewMode === "list"
                    ? "bg-white text-blue-600 shadow-sm border border-slate-200"
                    : "text-slate-400 hover:text-slate-600 hover:bg-slate-200"
                    }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <line x1="8" y1="6" x2="21" y2="6"></line>
                    <line x1="8" y1="12" x2="21" y2="12"></line>
                    <line x1="8" y1="18" x2="21" y2="18"></line>
                    <line x1="3" y1="6" x2="3.01" y2="6"></line>
                    <line x1="3" y1="12" x2="3.01" y2="12"></line>
                    <line x1="3" y1="18" x2="3.01" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>

            {loading ? (
              <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-400 text-sm animate-pulse font-medium">
                Loading rule catalog...
              </div>
            ) : ruleSets.length === 0 ? (
              <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-500 text-sm font-medium">
                No rule sets found in this category.
              </div>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                {ruleSets.map((rs) => {
                  const domainObj = DOMAINS.find((d) => d.key === rs.domain);
                  return (
                    <div
                      key={rs.id}
                      onClick={() => {
                        setSelectedRuleSetId(rs.id);
                        fetchRuleSetDetail(rs.id);
                      }}
                      className="p-5 rounded-2xl border transition cursor-pointer shadow-sm bg-white border-slate-200 hover:border-blue-300 hover:shadow-md hover:ring-1 hover:ring-blue-300 flex flex-col h-full group"
                    >
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <span className="inline-block px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-200 group-hover:bg-blue-50 group-hover:text-blue-700 group-hover:border-blue-200 transition-colors">
                          {domainObj?.label || rs.domain}
                        </span>
                        <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                          v{rs.active_version_no || 1} {rs.active_version_status}
                        </span>
                      </div>
                      
                      <h3 className="text-base font-bold text-slate-900 mb-2">{rs.name}</h3>
                      <p className="text-sm text-slate-500 line-clamp-3 mb-5 flex-1">{rs.description}</p>

                      <div className="flex items-center justify-between text-xs text-slate-400 pt-4 border-t border-slate-100 mt-auto">
                        <span className="font-semibold text-slate-700">{rs.rule_count} Business Rules</span>
                        <span>Updated {new Date(rs.updated_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden w-full">
                <div className="overflow-x-auto w-full">
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-100">
                      <tr>
                        <th className="px-6 py-4">Category Name</th>
                        <th className="px-6 py-4">Domain</th>
                        <th className="px-6 py-4">Status</th>
                        <th className="px-6 py-4">Rules</th>
                        <th className="px-6 py-4 text-right">Last Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ruleSets.map((rs) => {
                        const domainObj = DOMAINS.find((d) => d.key === rs.domain);
                        return (
                          <tr
                            key={rs.id}
                            onClick={() => {
                              setSelectedRuleSetId(rs.id);
                              fetchRuleSetDetail(rs.id);
                            }}
                            className="hover:bg-slate-50/80 transition-colors cursor-pointer group"
                          >
                            <td className="px-6 py-4">
                              <div className="font-bold text-slate-900 text-base">{rs.name}</div>
                              <div className="text-[11px] text-slate-500 line-clamp-1 mt-1 max-w-md whitespace-normal">{rs.description}</div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="inline-block px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-200">
                                {domainObj?.label || rs.domain}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                v{rs.active_version_no || 1} {rs.active_version_status}
                              </span>
                            </td>
                            <td className="px-6 py-4 font-semibold text-slate-700">
                              {rs.rule_count} Rules
                            </td>
                            <td className="px-6 py-4 text-slate-500 text-right">
                              {new Date(rs.updated_at).toLocaleDateString()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

            {/* Rule Set Detail Modal */}
            {selectedRuleSetId && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
                <div className="bg-white w-full max-w-6xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-300">
                  
                  {loadingDetail || !ruleSetDetail ? (
                    <div className="p-12 flex-1 flex items-center justify-center text-center text-slate-400 text-sm animate-pulse font-medium">
                      Loading decision rules...
                    </div>
                  ) : (
                    <>
                      {/* Modal Header */}
                      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                        <div>
                          <div className="flex items-center gap-3">
                            <h2 className="text-xl font-bold text-slate-900">{ruleSetDetail.name}</h2>
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                              v{ruleSetDetail.active_version_no || 1} {ruleSetDetail.active_version_status}
                            </span>
                          </div>
                          <p className="text-sm text-slate-500 mt-1">{ruleSetDetail.description}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={handleCreateVersion}
                            className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 shadow-sm transition"
                          >
                            + New Draft Version
                          </button>
                          {/* 
                          <button
                            onClick={() => {
                              setSelectedRuleSetId(null);
                              setRuleSetDetail(null);
                              setSimRuleCode(ruleSetDetail.code);
                              setActiveTab("simulator");
                            }}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
                          >
                            Test in Simulator
                          </button>
                          */}
                          <button
                            onClick={() => {
                              setSelectedRuleSetId(null);
                              setRuleSetDetail(null);
                            }}
                            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors ml-2"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>
                      </div>

                      <div className="flex-1 overflow-y-auto p-6 bg-slate-50 space-y-6">
                        {/* Versions Sub-Bar */}
                        <div className="flex items-center justify-between bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                          <div className="flex items-center gap-2 overflow-x-auto">
                            <span className="text-xs text-slate-500 font-bold uppercase tracking-wider mr-2">Version History:</span>
                            {ruleSetDetail.versions.map((ver) => (
                              <button
                                key={ver.id}
                                onClick={() => setSelectedVersionId(ver.id)}
                                className={`px-4 py-1.5 rounded-lg text-xs font-bold border transition shadow-sm ${selectedVersionId === ver.id
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                                  }`}
                              >
                                v{ver.version_no} ({ver.status})
                              </button>
                            ))}
                          </div>

                          {currentVersionObj && currentVersionObj.status === "DRAFT" && (
                            <button
                              onClick={() => handleDeployVersion(currentVersionObj.id)}
                              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
                            >
                              Deploy v{currentVersionObj.version_no} to Active
                            </button>
                          )}
                        </div>

                        {/* Decision Table */}
                        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-5">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm uppercase tracking-wider text-slate-900 font-bold">
                              Active Decision Rules ({currentVersionObj?.rules.length || 0})
                            </h3>
                            {currentVersionObj && currentVersionObj.status === "DRAFT" && (
                              <button
                                onClick={() => {
                                  setIsEditingRule(false);
                                  setEditingRuleId(null);
                                  setRuleName("");
                                  setRuleCode("");
                                  setRuleDescription("");
                                  setRuleCategory("");
                                  setRuleSubcategory("");
                                  setRuleEligibility("");
                                  setRulePriority(10);
                                  setShowAddRuleModal(true);
                                }}
                                className="px-4 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 text-xs font-bold rounded-lg transition shadow-sm"
                              >
                                + Add Rule
                              </button>
                            )}
                          </div>

                          {!currentVersionObj || currentVersionObj.rules.length === 0 ? (
                            <div className="p-10 text-center border border-slate-200 rounded-xl bg-slate-50 text-slate-500 text-sm font-medium">
                              No decision rules defined in this version. Click "+ Add Rule" to add guidelines.
                            </div>
                          ) : (
                            <div className="overflow-x-auto w-full border border-slate-200 rounded-xl">
                              <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-100">
                                  <tr>
                                    <th className="px-4 py-4 w-32">Rule Code</th>
                                    <th className="px-4 py-4 w-56">Rule Name</th>
                                    <th className="px-4 py-4">Category</th>
                                    <th className="px-4 py-4">Eligibility & Conditions</th>
                                    <th className="px-4 py-4">Outcome</th>
                                    <th className="px-4 py-4 text-right">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {currentVersionObj.rules.map((rule) => {
                                    const outcomeConfig = ACTION_OUTCOMES[rule.action_outcome] || {
                                      label: rule.action_outcome,
                                      badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
                                    };

                                    return (
                                      <tr
                                        key={rule.id}
                                        onClick={() => setSelectedRule(rule)}
                                        className="hover:bg-slate-50/80 transition-colors cursor-pointer group"
                                      >
                                        <td className="px-4 py-4">
                                          <div className="flex flex-col gap-1.5">
                                            {rule.code ? (
                                              <span className="font-mono text-[11px] text-slate-700 bg-slate-100 border border-slate-200 w-fit px-2 py-0.5 rounded font-semibold">{rule.code}</span>
                                            ) : (
                                              <span className="text-slate-400 text-[10px] italic">No Code</span>
                                            )}
                                            <span className="text-blue-700 font-bold text-[10px] uppercase tracking-wider">
                                              Priority: #{rule.priority}
                                            </span>
                                          </div>
                                        </td>
                                        <td className="px-4 py-4">
                                          <div className="flex flex-col gap-1 max-w-[250px] whitespace-normal">
                                            <span className="font-bold text-slate-900 leading-tight">{rule.name}</span>
                                            {rule.description && (
                                              <details className="group mt-1" onClick={(e) => e.stopPropagation()}>
                                                <summary className="text-[10px] text-blue-600 hover:text-blue-800 cursor-pointer font-semibold select-none flex items-center gap-1 w-fit outline-none transition-colors">
                                                  View Description
                                                  <svg className="w-3 h-3 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                                  </svg>
                                                </summary>
                                                <div className="text-[11px] text-slate-600 mt-1.5 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-200 shadow-inner">
                                                  {rule.description}
                                                </div>
                                              </details>
                                            )}
                                          </div>
                                        </td>
                                        <td className="px-4 py-4">
                                          <div className="flex flex-col">
                                            {rule.category ? (
                                              <span className="font-semibold text-slate-800 text-xs">{rule.category}</span>
                                            ) : (
                                              <span className="text-slate-400 text-[11px] italic">Uncategorized</span>
                                            )}
                                            {rule.subcategory && <span className="text-[10px] text-slate-500">{rule.subcategory}</span>}
                                          </div>
                                        </td>
                                        <td className="px-4 py-4 text-slate-600 font-medium text-xs whitespace-normal max-w-[250px]">
                                          {rule.eligibility_criteria && (
                                            <div className="mb-1 text-[11px] text-slate-500">
                                              <span className="font-semibold text-slate-700">Applies to:</span> {rule.eligibility_criteria}
                                            </div>
                                          )}
                                          {rule.conditions.length === 0 ? (
                                            <span className="italic text-slate-400">Always applies unconditionally</span>
                                          ) : (
                                            <span>
                                              If {rule.condition_operator === "ALL" ? "all" : "any"} of {rule.conditions.length} condition{rule.conditions.length !== 1 ? 's' : ''} match...
                                            </span>
                                          )}
                                        </td>
                                        <td className="px-4 py-4">
                                          <span className={`inline-block px-2.5 py-1 rounded-md text-[10px] border font-bold uppercase tracking-wider ${outcomeConfig.badge}`}>
                                            {outcomeConfig.label}
                                          </span>
                                        </td>
                                        <td className="px-4 py-4 text-right">
                                          {currentVersionObj.status === "DRAFT" ? (
                                            <div className="flex items-center justify-end gap-1">
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  openEditRuleModal(rule);
                                                }}
                                                className="text-slate-400 hover:text-blue-600 p-1.5 rounded-lg hover:bg-blue-50 transition flex items-center justify-center bg-slate-50 border border-slate-200"
                                                title="Edit Rule"
                                              >
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                                </svg>
                                              </button>
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleDeleteRule(rule.id);
                                                }}
                                                className="text-slate-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 transition flex items-center justify-center bg-slate-50 border border-slate-200"
                                                title="Delete Rule"
                                              >
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                </svg>
                                              </button>
                                            </div>
                                          ) : (
                                            <span className="text-xs text-slate-400 italic">Locked (Active)</span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
        </div>
      )}

      {/* TAB 2: LIVE SIMULATOR */}
      {activeTab === "simulator" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left Controls - Non-Technical Form */}
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Test Applicant Details</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Adjust values below to test how the rule engine makes decisions.
                </p>
              </div>
              <button
                onClick={() => setShowAdvancedJson(!showAdvancedJson)}
                className="text-[11px] font-semibold text-blue-600 hover:underline"
              >
                {showAdvancedJson ? "Use Simple Form" : "View Raw JSON"}
              </button>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="block text-xs text-slate-700 font-semibold mb-1">Select Rule Set to Test</label>
                <select
                  value={simRuleCode}
                  onChange={(e) => setSimRuleCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 font-medium focus:outline-none focus:border-blue-500 shadow-xs"
                >
                  {ruleSets.map((rs) => (
                    <option key={rs.id} value={rs.code}>
                      {rs.name}
                    </option>
                  ))}
                </select>
              </div>

              {!showAdvancedJson ? (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Applicant Age</label>
                      <input
                        type="number"
                        value={simForm.age}
                        onChange={(e) => setSimForm({ ...simForm, age: Number(e.target.value) })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-semibold"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Sum Assured (PKR)</label>
                      <input
                        type="number"
                        step={100000}
                        value={simForm.sum_assured}
                        onChange={(e) => setSimForm({ ...simForm, sum_assured: Number(e.target.value) })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-semibold"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Policy Category</label>
                      <select
                        value={simForm.category}
                        onChange={(e) => setSimForm({ ...simForm, category: e.target.value })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-medium"
                      >
                        <option value="Individual">Individual Life</option>
                        <option value="Group">Group Life</option>
                        <option value="Family">Family Takaful</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Policy Duration Year</label>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={simForm.policy_year}
                        onChange={(e) => setSimForm({ ...simForm, policy_year: Number(e.target.value) })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-semibold"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Tobacco Smoker?</label>
                      <select
                        value={simForm.is_smoker ? "true" : "false"}
                        onChange={(e) => setSimForm({ ...simForm, is_smoker: e.target.value === "true" })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-medium"
                      >
                        <option value="false">No (Non-Smoker)</option>
                        <option value="true">Yes (Active Smoker)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Body Mass Index (BMI)</label>
                      <input
                        type="number"
                        value={simForm.bmi}
                        onChange={(e) => setSimForm({ ...simForm, bmi: Number(e.target.value) })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-semibold"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">Sanctions List Match?</label>
                      <select
                        value={simForm.sanctions_matched ? "true" : "false"}
                        onChange={(e) => setSimForm({ ...simForm, sanctions_matched: e.target.value === "true" })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-medium"
                      >
                        <option value="false">No Match</option>
                        <option value="true">Match Found (Sanctioned)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-600 font-medium mb-1">AI Risk Score (0 - 100)</label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={simForm.composite_score}
                        onChange={(e) => setSimForm({ ...simForm, composite_score: Number(e.target.value) })}
                        className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 font-semibold"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-slate-700 font-semibold mb-1">Advanced Test Context (JSON)</label>
                  <textarea
                    value={simContextJson}
                    onChange={(e) => setSimContextJson(e.target.value)}
                    rows={12}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono text-slate-800 focus:outline-none focus:bg-white focus:border-blue-500 shadow-xs"
                  />
                </div>
              )}

              <button
                onClick={handleRunSimulation}
                disabled={simulating}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-xs rounded-lg shadow-sm transition flex items-center justify-center gap-2 active:scale-95"
              >
                {simulating ? "Running Rule Test..." : "Run Decision Test"}
              </button>
            </div>
          </div>

          {/* Right Results */}
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Test Decision Outcome</h2>

            {!simResult ? (
              <div className="p-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg text-xs">
                Configure test applicant details on the left and click "Run Decision Test" to see the rule evaluation result.
              </div>
            ) : (
              <div className="space-y-4">
                {/* Result Header */}
                <div className="p-4 rounded-lg border bg-blue-50/60 border-blue-200 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-blue-600 uppercase tracking-wider font-semibold">Final Rule Decision</span>
                    <h3 className="text-base font-bold text-blue-900 mt-0.5">
                      {ACTION_OUTCOMES[simResult.final_outcome]?.label || simResult.final_outcome}
                    </h3>
                  </div>
                  <span className="px-3 py-1 bg-blue-100 text-blue-800 border border-blue-300 rounded-full text-xs font-semibold">
                    {simResult.triggered_rules?.length || 0} Rule(s) Triggered
                  </span>
                </div>

                {/* Reasons / Required Actions */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg space-y-2">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Underwriting Guidelines & Reasons</h3>
                  <ul className="space-y-1 text-xs text-slate-700 list-disc list-inside">
                    {simResult.reasons?.map((r: string, idx: number) => (
                      <li key={idx} className="font-medium">{r}</li>
                    ))}
                  </ul>
                </div>

                {/* Triggered Rules Execution List */}
                <div>
                  <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Matched Rules Details</h3>
                  <div className="space-y-2">
                    {simResult.triggered_rules?.map((tr: any, i: number) => {
                      const trConfig = ACTION_OUTCOMES[tr.action_outcome] || { label: tr.action_outcome };
                      return (
                        <div key={i} className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-slate-900">Rule #{tr.priority}: {tr.name}</span>
                            <span className="text-blue-700 font-semibold">{trConfig.label}</span>
                          </div>
                          <p className="text-slate-600 text-[11px]">{tr.outcome_payload?.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: AUDIT LOGS */}
      {activeTab === "logs" && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">SECP Regulatory Audit Trail</h2>
              <p className="text-xs text-slate-500">Immutable record of all automated rule evaluations for SECP compliance auditing.</p>
            </div>
            <button
              onClick={fetchAuditLogs}
              className="px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 shadow-sm"
            >
              Refresh Logs
            </button>
          </div>

          {loadingLogs ? (
            <div className="p-8 text-center text-slate-400 animate-pulse text-xs">Fetching audit logs...</div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-slate-400 border border-slate-200 rounded-lg text-xs">
              No audit logs recorded yet. As applications are processed by the rules engine, their decision trails will appear here.
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] tracking-wider border-b border-slate-200 font-semibold">
                  <tr>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Rule Category</th>
                    <th className="px-4 py-3">Version</th>
                    <th className="px-4 py-3">User / Actor</th>
                    <th className="px-4 py-3">Decision Outcome</th>
                    <th className="px-4 py-3">Underwriting Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {logs.map((log) => {
                    const outcomeCode = log.outcome?.final_outcome;
                    const outcomeObj = ACTION_OUTCOMES[outcomeCode] || { label: outcomeCode || "Evaluated" };

                    return (
                      <tr key={log.id} className="hover:bg-slate-50 transition">
                        <td className="px-4 py-3 text-slate-500 font-mono text-[11px]">
                          {new Date(log.evaluated_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-900">{log.rule_set_code}</td>
                        <td className="px-4 py-3 text-slate-600 font-medium">v{log.rule_version_no}</td>
                        <td className="px-4 py-3 text-slate-800">{log.actor || "System"}</td>
                        <td className="px-4 py-3 font-semibold text-blue-700">
                          {outcomeObj.label}
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-[11px] max-w-[280px] truncate">
                          {log.reasons?.join("; ") || "Evaluated successfully."}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* MODAL: CREATE RULE SET */}
      {showCreateSetModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4 shadow-xl text-slate-800">
            <h3 className="text-base font-bold text-slate-900">Create New Business Rule Category</h3>

            <form onSubmit={handleCreateRuleSet} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Display Name</label>
                <input
                  type="text"
                  placeholder="e.g. Maximum Sum Assured Multipliers"
                  value={newSetName}
                  onChange={(e) => {
                    setNewSetName(e.target.value);
                    if (!newSetCode) {
                      setNewSetCode(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "_"));
                    }
                  }}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Taxonomy Category</label>
                <select
                  value={newSetDomain}
                  onChange={(e) => setNewSetDomain(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                >
                  {DOMAINS.filter((d) => d.key !== "ALL").map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Description / Guidelines</label>
                <textarea
                  placeholder="Explain the purpose and underwriting logic of this rule set..."
                  value={newSetDesc}
                  onChange={(e) => setNewSetDesc(e.target.value)}
                  rows={3}
                  className="w-full bg-white border border-slate-200 rounded-lg p-3 text-slate-900 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateSetModal(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-sm"
                >
                  Create Rule Category
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ADD RULE */}
      {showAddRuleModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full p-6 space-y-5 shadow-xl text-slate-800 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-slate-900">{isEditingRule ? "Edit Decision Guideline" : "Add Decision Guideline to Version"}</h3>

            <form onSubmit={handleAddRule} className="space-y-4 text-xs">
              
              <div className="grid grid-cols-4 gap-3">
                <div className="col-span-3">
                  <label className="block text-slate-700 font-semibold mb-1">Rule Name</label>
                  <input
                    type="text"
                    placeholder="e.g. High BMI Smoker Surcharge"
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                    required
                  />
                </div>
                <div className="col-span-1">
                  <label className="block text-slate-700 font-semibold mb-1">Priority</label>
                  <input
                    type="number"
                    min={1}
                    value={rulePriority}
                    onChange={(e) => setRulePriority(Number(e.target.value))}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Rule Code (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. BMI-SMK-001"
                    value={ruleCode}
                    onChange={(e) => setRuleCode(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Eligibility Criteria</label>
                  <input
                    type="text"
                    placeholder="e.g. Age > 18"
                    value={ruleEligibility}
                    onChange={(e) => setRuleEligibility(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Category</label>
                  <input
                    type="text"
                    placeholder="e.g. Medical Underwriting"
                    value={ruleCategory}
                    onChange={(e) => setRuleCategory(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Subcategory</label>
                  <input
                    type="text"
                    placeholder="e.g. Non-Medical Limits"
                    value={ruleSubcategory}
                    onChange={(e) => setRuleSubcategory(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Description</label>
                <textarea
                  placeholder="Detailed explanation of this rule..."
                  value={ruleDescription}
                  onChange={(e) => setRuleDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-white border border-slate-200 rounded-lg p-3 text-slate-900 focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Condition Spec (Friendly Non-Technical Selector) */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                <span className="text-[11px] font-bold text-blue-700 uppercase tracking-wider block">Rule Condition Criteria</span>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-600 font-semibold mb-1">Field Name</label>
                    <select
                      value={condField}
                      onChange={(e) => setCondField(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-md px-2 py-1.5 text-slate-900 font-medium text-[11px]"
                    >
                      <option value="age">Applicant Age</option>
                      <option value="sum_assured">Sum Assured (PKR)</option>
                      <option value="is_smoker">Smoker Status</option>
                      <option value="category">Policy Category</option>
                      <option value="policy_year">Policy Duration Year</option>
                      <option value="bmi">Body Mass Index (BMI)</option>
                      <option value="composite_score">AI Risk Score</option>
                      <option value="sanctions_matched">Sanctions List Match</option>
                      <option value="is_pep">PEP Status</option>
                      <option value="annual_premium">Annual Premium</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600 font-semibold mb-1">Comparison</label>
                    <select
                      value={condOp}
                      onChange={(e) => setCondOp(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-md px-2 py-1.5 text-slate-900 text-[11px]"
                    >
                      <option value="gte">is at least (≥)</option>
                      <option value="gt">is greater than (&gt;)</option>
                      <option value="lte">is at most (≤)</option>
                      <option value="lt">is less than (&lt;)</option>
                      <option value="eq">is equal to (==)</option>
                      <option value="ne">is not equal to (!=)</option>
                      <option value="boolean">is Yes / No</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600 font-semibold mb-1">Target Value</label>
                    <input
                      type="text"
                      placeholder="e.g. 50, true, 5000000"
                      value={condValue}
                      onChange={(e) => setCondValue(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-slate-900 text-[11px]"
                    />
                  </div>
                </div>
              </div>

              {/* Action Outcome Spec */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Action Decision Outcome</label>
                  <select
                    value={ruleAction}
                    onChange={(e) => setRuleAction(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-blue-500"
                  >
                    <option value="REQUIRE_MEDICAL_EXAM">Require Panel Medical Exam</option>
                    <option value="WAIVE_MEDICAL">Waive Medical Exam</option>
                    <option value="APPLY_LOADING">Apply Premium Risk Loading</option>
                    <option value="APPLY_COMMISSION_RATE">Apply Statutory Commission</option>
                    <option value="AUTO_APPROVE">Auto Approve Policy</option>
                    <option value="BLOCK_APPLICATION">Block Application (Sanctions)</option>
                    <option value="REQUIRE_MANUAL_CLEARANCE">Require Compliance Sign-off</option>
                    <option value="HUMAN_REVIEW">Escalate to Senior Underwriter</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Underwriting Reason / Note</label>
                  <input
                    type="text"
                    placeholder="e.g. High BMI risk loading 25%"
                    value={ruleReason}
                    onChange={(e) => setRuleReason(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddRuleModal(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-sm"
                >
                  {isEditingRule ? "Save Changes" : "Add Decision Guideline"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedRule && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="font-mono text-blue-600 font-semibold text-xs bg-blue-50 px-2 py-0.5 rounded border border-blue-100">
                  #{selectedRule.priority}
                </span>
                <h3 className="font-bold text-slate-900 text-base">{selectedRule.name}</h3>
              </div>
              <button
                onClick={() => setSelectedRule(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-6 flex-1 text-sm">
              <div>
                <h4 className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-3">When Conditions Match</h4>
                {selectedRule.conditions.length === 0 ? (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-slate-500 italic text-sm">
                    Always applies unconditionally
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      If {selectedRule.condition_operator === "ALL" ? "ALL" : "ANY"} of the following apply:
                    </div>
                    {selectedRule.conditions.map((c: any, idx: number) => {
                      const { fieldLabel, opLabel, valLabel } = formatConditionSentence(c);
                      return (
                        <div key={idx} className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm text-slate-700 flex items-center flex-wrap gap-1.5">
                          <span className="font-semibold text-slate-900">{fieldLabel}</span>
                          <span className="text-slate-500">{opLabel}</span>
                          <span className="font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">{valLabel}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <h4 className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-3">Action Outcome</h4>
                {(() => {
                  const outcomeConfig = ACTION_OUTCOMES[selectedRule.action_outcome] || {
                    label: selectedRule.action_outcome,
                    badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
                  };
                  return (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col gap-2">
                      <div>
                        <span className={`inline-block px-2.5 py-1 rounded text-xs border ${outcomeConfig.badge}`}>
                          {outcomeConfig.label}
                        </span>
                      </div>
                      {selectedRule.outcome_payload?.reason && (
                        <p className="text-slate-600 text-sm mt-1">
                          <span className="font-medium">Note:</span> {selectedRule.outcome_payload.reason}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
              <button
                onClick={() => setSelectedRule(null)}
                className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 font-medium rounded-lg border border-slate-200 shadow-sm transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
