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

  // Selected Rule Set detail view
  const [selectedRuleSetId, setSelectedRuleSetId] = useState<string | null>(null);
  const [ruleSetDetail, setRuleSetDetail] = useState<RuleSetDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // New Rule Set Modal
  const [showCreateSetModal, setShowCreateSetModal] = useState(false);
  const [newSetCode, setNewSetCode] = useState("");
  const [newSetName, setNewSetName] = useState("");
  const [newSetDomain, setNewSetDomain] = useState("ELIGIBILITY");
  const [newSetDesc, setNewSetDesc] = useState("");

  // New Rule Modal
  const [showAddRuleModal, setShowAddRuleModal] = useState(false);
  const [ruleName, setRuleName] = useState("");
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
      priority: Number(rulePriority),
      condition_operator: ruleOperator,
      conditions: condField ? [{ field: condField, operator: condOp, value: parsedVal }] : [],
      action_outcome: ruleAction,
      outcome_payload: { reason: ruleReason || ruleName },
      is_enabled: true,
    };

    try {
      await api.post(`/tenants/${tenantId}/rules/versions/${selectedVersionId}/rules`, newRulePayload);
      notify("Rule added to version successfully!", true);
      setShowAddRuleModal(false);
      setRuleName("");
      setRuleAction("REQUIRE_MEDICAL_EXAM");
      setRuleReason("");
      setCondField("age");
      setCondValue("50");
      if (selectedRuleSetId) fetchRuleSetDetail(selectedRuleSetId);
    } catch (err: any) {
      notify(err.message || "Failed to add rule.", false);
    }
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
          className={`pb-3 flex items-center gap-2 transition border-b-2 ${
            activeTab === "catalog"
              ? "border-blue-600 text-blue-600 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          Rule Catalog & Decision Guidelines
        </button>

        <button
          onClick={() => setActiveTab("simulator")}
          className={`pb-3 flex items-center gap-2 transition border-b-2 ${
            activeTab === "simulator"
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

        <button
          onClick={() => {
            setActiveTab("logs");
            fetchAuditLogs();
          }}
          className={`pb-3 flex items-center gap-2 transition border-b-2 ${
            activeTab === "logs"
              ? "border-blue-600 text-blue-600 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          SECP Regulatory Audit Trail
        </button>
      </div>

      {/* TABS CONTENT */}

      {/* TAB 1: CATALOG */}
      {activeTab === "catalog" && (
        <div className="space-y-5">
          {/* Domain Filter Pills (Standard Blue Portal Theme) */}
          <div className="flex flex-wrap gap-2">
            {DOMAINS.map((d) => (
              <button
                key={d.key}
                onClick={() => handleDomainSelect(d.key)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-medium border transition ${
                  selectedDomain === d.key
                    ? "bg-blue-600 text-white border-blue-600 shadow-sm font-semibold"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          {/* Catalog Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left List of Rule Sets */}
            <div className={`${selectedRuleSetId ? "lg:col-span-4" : "lg:col-span-12"} space-y-3`}>
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                  Rule Categories ({ruleSets.length})
                </h2>
              </div>

              {loading ? (
                <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-400 text-xs animate-pulse">
                  Loading rule catalog...
                </div>
              ) : ruleSets.length === 0 ? (
                <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-500 text-xs">
                  No rule sets found in this category.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-3">
                  {ruleSets.map((rs) => {
                    const isSelected = selectedRuleSetId === rs.id;
                    const domainObj = DOMAINS.find((d) => d.key === rs.domain);
                    return (
                      <div
                        key={rs.id}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedRuleSetId(null);
                            setRuleSetDetail(null);
                          } else {
                            setSelectedRuleSetId(rs.id);
                            fetchRuleSetDetail(rs.id);
                          }
                        }}
                        className={`p-4 rounded-xl border transition cursor-pointer shadow-sm ${
                          isSelected
                            ? "bg-blue-50/80 border-blue-500 ring-1 ring-blue-500"
                            : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/60"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                              {domainObj?.label || rs.domain}
                            </span>
                            <h3 className="text-sm font-semibold text-slate-900 mt-1.5">{rs.name}</h3>
                          </div>
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                            v{rs.active_version_no || 1} {rs.active_version_status}
                          </span>
                        </div>

                        <p className="text-xs text-slate-500 mt-2 line-clamp-2">{rs.description}</p>

                        <div className="flex items-center justify-between mt-3 text-[11px] text-slate-400 pt-2.5 border-t border-slate-100">
                          <span className="font-medium text-slate-600">{rs.rule_count} Business Rules</span>
                          <span>Updated {new Date(rs.updated_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right Detail Pane */}
            {selectedRuleSetId && (
              <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-5 shadow-sm">
                {loadingDetail || !ruleSetDetail ? (
                  <div className="p-12 text-center text-slate-400 text-xs animate-pulse">
                    Loading decision rules...
                  </div>
                ) : (
                  <>
                    {/* Detail Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="text-lg font-bold text-slate-900">{ruleSetDetail.name}</h2>
                          <button
                            onClick={() => {
                              setSelectedRuleSetId(null);
                              setRuleSetDetail(null);
                            }}
                            className="text-slate-400 hover:text-slate-600 text-xs font-semibold ml-2"
                          >
                            ✕ Close
                          </button>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">{ruleSetDetail.description}</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleCreateVersion}
                          className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 transition"
                        >
                          + New Draft Version
                        </button>
                        <button
                          onClick={() => {
                            setSimRuleCode(ruleSetDetail.code);
                            setActiveTab("simulator");
                          }}
                          className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold rounded-lg border border-blue-200 transition"
                        >
                          Test in Simulator
                        </button>
                      </div>
                    </div>

                    {/* Versions Sub-Bar */}
                    <div className="flex items-center justify-between bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                      <div className="flex items-center gap-2 overflow-x-auto">
                        <span className="text-xs text-slate-500 font-medium mr-1">Version History:</span>
                        {ruleSetDetail.versions.map((ver) => (
                          <button
                            key={ver.id}
                            onClick={() => setSelectedVersionId(ver.id)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
                              selectedVersionId === ver.id
                                ? "bg-blue-600 text-white border-blue-600 shadow-xs font-semibold"
                                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                            }`}
                          >
                            v{ver.version_no} ({ver.status})
                          </button>
                        ))}
                      </div>

                      {currentVersionObj && currentVersionObj.status === "DRAFT" && (
                        <button
                          onClick={() => handleDeployVersion(currentVersionObj.id)}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-xs transition"
                        >
                          Deploy v{currentVersionObj.version_no} to Active
                        </button>
                      )}
                    </div>

                    {/* Decision Table */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                          Active Decision Rules ({currentVersionObj?.rules.length || 0})
                        </h3>
                        {currentVersionObj && (
                          <button
                            onClick={() => setShowAddRuleModal(true)}
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition"
                          >
                            + Add Rule
                          </button>
                        )}
                      </div>

                      {!currentVersionObj || currentVersionObj.rules.length === 0 ? (
                        <div className="p-8 text-center border border-slate-200 rounded-lg text-slate-400 text-xs">
                          No decision rules defined in this version. Click "+ Add Rule" to add guidelines.
                        </div>
                      ) : (
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                          <table className="w-full text-left text-xs text-slate-700">
                            <thead className="bg-slate-50 text-slate-600 font-semibold text-[10px] uppercase tracking-wider border-b border-slate-200">
                              <tr>
                                <th className="px-3.5 py-2.5">Priority</th>
                                <th className="px-3.5 py-2.5">Rule Name</th>
                                <th className="px-3.5 py-2.5">When Conditions Match</th>
                                <th className="px-3.5 py-2.5">Action Outcome</th>
                                <th className="px-3.5 py-2.5">Explanation / Note</th>
                                <th className="px-3.5 py-2.5 text-right">Action</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 bg-white">
                              {currentVersionObj.rules.map((rule) => {
                                const outcomeConfig = ACTION_OUTCOMES[rule.action_outcome] || {
                                  label: rule.action_outcome,
                                  badge: "bg-blue-50 text-blue-700 border-blue-200 font-semibold",
                                };

                                return (
                                  <tr key={rule.id} className="hover:bg-slate-50/70 transition">
                                    <td className="px-3.5 py-3 font-mono text-blue-600 font-semibold">#{rule.priority}</td>
                                    <td className="px-3.5 py-3 font-semibold text-slate-900 max-w-[160px]">
                                      {rule.name}
                                    </td>
                                    <td className="px-3.5 py-3 max-w-[280px]">
                                      {rule.conditions.length === 0 ? (
                                        <span className="text-slate-400 italic">Always applies unconditionally</span>
                                      ) : (
                                        <div className="space-y-1.5">
                                          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                                            If {rule.condition_operator === "ALL" ? "ALL" : "ANY"} of the following apply:
                                          </span>
                                          {rule.conditions.map((c, idx) => {
                                            const { fieldLabel, opLabel, valLabel } = formatConditionSentence(c);
                                            return (
                                              <div key={idx} className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px] text-slate-700">
                                                <span className="font-semibold text-slate-900">{fieldLabel}</span>{" "}
                                                <span className="text-slate-500">{opLabel}</span>{" "}
                                                <span className="font-semibold text-blue-700">{valLabel}</span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </td>
                                    <td className="px-3.5 py-3">
                                      <span className={`inline-block px-2.5 py-1 rounded text-[11px] border ${outcomeConfig.badge}`}>
                                        {outcomeConfig.label}
                                      </span>
                                    </td>
                                    <td className="px-3.5 py-3 text-slate-500 text-[11px] max-w-[200px]">
                                      <p className="line-clamp-2">{rule.outcome_payload?.reason || "—"}</p>
                                    </td>
                                    <td className="px-3.5 py-3 text-right">
                                      <button
                                        onClick={() => handleDeleteRule(rule.id)}
                                        className="text-slate-400 hover:text-red-600 p-1 text-xs transition"
                                        title="Delete Rule"
                                      >
                                        ✕
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
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
              No audit logs recorded yet. Run a rule test in the simulator to generate audit entries.
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
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-5 space-y-4 shadow-xl text-slate-800">
            <h3 className="text-base font-bold text-slate-900">Add Decision Guideline to Version</h3>

            <form onSubmit={handleAddRule} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
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
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Priority Order</label>
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
                  Add Decision Guideline
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
