"use client";

import { displayDate, displayDateTime } from '../lib/dateDisplay';
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";
import { sendLeadToDraft, isEmbedded } from "@/lib/sendToDraft";
import CustomerFormModal from "@/components/entities/CustomerFormModal";
import FamilyFormModal from "@/components/entities/FamilyFormModal";
import OrganizationFormModal from "@/components/entities/OrganizationFormModal";
import { tx } from "@/lib/i18n/tx";

type EntityType = "INDIVIDUAL" | "FAMILY" | "CORPORATE";

interface RiskRule { code: string; name: string; reason?: string | null; impact_type?: string; risk_level?: number; }
interface RiskFactor { key: string; label: string; detail: string; contribution_pct: number; risk_level: number; category: string; rules?: RiskRule[]; }
interface RiskCategory {
  key: string; label: string; share_pct: number; safe_pct: number; risk_pct: number; risk_within_pct: number;
  band: string; safe_factors: RiskFactor[]; risk_factors: RiskFactor[]; missing: string[];
}
interface RiskProfile {
  safe_pct: number; risk_pct: number; band: string; completeness_pct: number; summary: string;
  categories: RiskCategory[]; safe_factors: RiskFactor[]; risk_factors: RiskFactor[]; missing: string[];
  cover_considered?: number | null; plan_considered?: string | null;
  rule_set?: { code: string; version?: string | null; source?: string } | null;
  assessed_at?: string | null;
  assessed_by?: string | null;
  stale?: boolean;
  stale_reasons?: string[];
  underwriting?: { medical_tests: string[]; extra_mortality_pct: number; referral: boolean };
}

function ageFrom(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob), now = new Date();
  if (isNaN(d.getTime())) return null;
  return now.getFullYear() - d.getFullYear() - (now < new Date(now.getFullYear(), d.getMonth(), d.getDate()) ? 1 : 0);
}

/** Compact facts shown under the name in the header: [label, value, monospace]. */
function headerInfo(entityType: EntityType, data: any): [string, string | null, boolean?][] {
  if (entityType === "INDIVIDUAL") {
    const dob = data.dob || data.date_of_birth;
    const age = ageFrom(dob);
    return [
      ["CNIC", data.cnic, true],
      ["Phone", data.details?.contact?.mobile_number || data.details?.contact?.phone_number || data.details?.phone || null],
      ["Email", data.details?.contact?.email || data.details?.email || null],
      ["Date of Birth", dob ? `${displayDate(dob)}${age !== null ? ` · ${age} yrs` : ""}` : null],
      ["Created", data.created_at ? displayDateTime(data.created_at) : null],
    ];
  }
  if (entityType === "FAMILY") {
    return [
      ["Primary Contact Phone", data.contact_phone || null],
      ["Primary Contact Email", data.contact_email || null],
      ["Head of Family ID", data.head_of_family_customer_id || null, true],
      ["Created", data.created_at ? displayDateTime(data.created_at) : null],
    ];
  }
  return [
    ["Registration Number", data.registration_number || null, true],
    ["Industry", data.industry_type || null],
    ["Contact Phone", data.contact_phone || null],
    ["Address", data.address || null],
    ["Created", data.created_at ? displayDateTime(data.created_at) : null],
  ];
}

const BAND_STYLE: Record<string, string> = {
  Low: "bg-emerald-50/70 text-emerald-700 border-emerald-100",
  Moderate: "bg-amber-50 text-amber-700 border-amber-200",
  Elevated: "bg-orange-50 text-orange-700 border-orange-200",
  High: "bg-rose-50 text-rose-700 border-rose-200",
};

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  medical: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>,
  occupational: <><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></>,
  financial: <><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
  avocational: <><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/></>,
};

function CategoryCard({ cat }: { cat: RiskCategory }) {
  // One row per factor; a partly adverse factor carries both a safe and a risk share.
  const rows = new Map<string, { label: string; detail: string; safe: number; risk: number; rules: RiskRule[] }>();
  for (const f of cat.safe_factors) rows.set(f.key, { label: f.label, detail: f.detail, safe: f.contribution_pct, risk: 0, rules: [] });
  for (const f of cat.risk_factors) {
    const row = rows.get(f.key) ?? { label: f.label, detail: f.detail, safe: 0, risk: 0, rules: [] };
    rows.set(f.key, { ...row, risk: f.contribution_pct, rules: f.rules ?? [] });
  }
  const recorded = cat.share_pct > 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white border border-slate-200 text-slate-600">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">{CATEGORY_ICON[cat.key]}</svg>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800 leading-tight">{tx(cat.label)}</p>
            <p className="text-[11px] text-slate-500">{recorded ? tx("{0}% of the profile", { 0: cat.share_pct }) : tx("Not recorded")}</p>
          </div>
        </div>
        {recorded && <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border ${BAND_STYLE[cat.band] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}>{tx(cat.band)}</span>}
      </div>
      {recorded ? (
        <>
          <div className="mt-3 flex h-2 rounded-full overflow-hidden bg-slate-100" role="img" aria-label={tx("Safe {0}%, risk {1}%", { 0: cat.safe_pct, 1: cat.risk_pct })}>
            <div className="bg-emerald-300" style={{ width: `${100 - cat.risk_within_pct}%` }} />
            <div className="bg-rose-300" style={{ width: `${cat.risk_within_pct}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[11px] font-semibold">
            <span className="text-emerald-600">{tx("Safe")} {cat.safe_pct}%</span>
            <span className="text-rose-700">{tx("Risk")} {cat.risk_pct}%</span>
          </div>
          <ul className="mt-3 space-y-2">
            {Array.from(rows.entries()).map(([key, f]) => (
              <li key={key} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-slate-700">{tx(f.label)}</span>
                  <span className="shrink-0 tabular-nums">
                    {f.safe > 0 && <span className="font-bold text-emerald-600">{f.safe.toFixed(1)}%</span>}
                    {f.safe > 0 && f.risk > 0 && <span className="text-slate-300"> · </span>}
                    {f.risk > 0 && <span className="font-bold text-rose-700">{f.risk.toFixed(1)}%</span>}
                  </span>
                </div>
                <p className={`text-[11px] ${f.risk > 0 ? "text-rose-600" : "text-slate-500"}`}>{f.detail}</p>
                {f.rules.map((r) => r.reason && (
                  <p key={r.code} className="mt-1 rounded-md bg-rose-50/70 border border-rose-100 px-2 py-1 text-[11px] text-slate-600">
                    <span className="font-semibold text-rose-700">{tx("Why")}: </span>{r.reason}
                    <span className="ml-1 font-mono text-[10px] text-slate-400" title={r.name}>{r.code}</span>
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {cat.missing.length > 0 && (
        <p className="mt-3 text-[11px] text-amber-700">{tx("Not recorded: {0}", { 0: cat.missing.join(", ") })}</p>
      )}
    </div>
  );
}

interface UnifiedDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityId: string;
  entityType: EntityType;
  onSaved?: () => void;
  /** Shown in place of the details when the modal is opened to explain a failed action (e.g. an eligibility decline). */
  initialError?: string;
}

export default function UnifiedDetailsModal({ isOpen, onClose, entityId, entityType, onSaved, initialError }: UnifiedDetailsModalProps) {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(initialError ?? "");
  const [keepInitial, setKeepInitial] = useState(!!initialError);
  const [showEditModal, setShowEditModal] = useState(false);
  const [risk, setRisk] = useState<RiskProfile | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState("");
  const [riskHidden, setRiskHidden] = useState(false);

  // The last saved assessment comes back when the profile is reopened.
  const loadSavedRisk = async () => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId || entityType !== "INDIVIDUAL") return;
    try {
      const res = await api.get(`/tenants/${tenantId}/customers/${entityId}/risk-profile/latest`);
      setRisk(res.data?.assessment ?? null);
    } catch {
      /* no saved assessment is fine — the button runs one */
    }
  };

  const runRiskAssessment = async () => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setRiskLoading(true);
    setRiskError("");
    setRiskHidden(false);
    try {
      const res = await api.post(`/tenants/${tenantId}/customers/${entityId}/risk-profile`);
      setRisk(res.data);
    } catch (err: any) {
      setRiskError(err.response?.data?.detail ?? err.message ?? tx("Risk assessment failed."));
    } finally {
      setRiskLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && entityId) {
      setRisk(null);
      setRiskError("");
      setRiskHidden(false);
      fetchDetails();
      loadSavedRisk();
    }
  }, [isOpen, entityId]);


  const handleSendToDraft = async (overrideReason?: string) => {
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      await sendLeadToDraft(entityType, entityId, data?.name ?? "", overrideReason ? { overrideReason } : {});
      setKeepInitial(false);
      if (onSaved) onSaved();
      if (isEmbedded()) {
        fetchDetails();
      } else {
        onClose();
        router.push("/proposal");
      }
    } catch (err: any) {
      setError(err.message || tx("Failed to update status to DRAFT."));
      setLoading(false);
    }
  };

  const fetchDetails = async () => {

    setLoading(true);
    // Reset to the message the modal was opened with (effects run twice in dev, so don't consume it once).
    setError(keepInitial ? (initialError ?? "") : "");
    const tenantId = localStorage.getItem("tenant_id");
    if (!tenantId) {
      setError(tx("No active tenant found."));
      setLoading(false);
      return;
    }

    try {
      let endpoint = "";
      if (entityType === "INDIVIDUAL") endpoint = `/tenants/${tenantId}/customers/${entityId}`;
      else if (entityType === "FAMILY") endpoint = `/tenants/${tenantId}/families/${entityId}`;
      else if (entityType === "CORPORATE") endpoint = `/tenants/${tenantId}/organizations/${entityId}`;

      const res = await api.get(endpoint);
      setData(res.data);
    } catch (err: any) {
      setError(err.message || tx("Failed to load details."));
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-300">
        
        {/* Header */}
        <div className="px-6 pt-4 pb-3 border-b border-slate-100 bg-slate-50/50">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 rounded-xl bg-blue-100 text-blue-600 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
                  {entityType === 'INDIVIDUAL' ? <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></> : null}
                  {entityType === 'FAMILY' ? <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></> : null}
                  {entityType === 'CORPORATE' ? <><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><path d="M9 9h6"/><path d="M9 13h6"/><path d="M9 17h6"/></> : null}
                </svg>
              </div>
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-slate-800 tracking-tight truncate">
                  {loading && !data ? tx("Loading...") : data?.name || tx("Unknown Profile")}
                </h2>
                <div className="flex flex-wrap items-center gap-2 mt-0.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                    {entityType}
                  </span>
                  {data?.profile_status && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                      {data.profile_status.replace('_', ' ')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {entityType === "FAMILY" && (
                <button 
                  onClick={() => window.location.href = `/admin/families/${entityId}`}
                  className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg transition-colors shadow-sm"
                >
                  {tx("Manage Family & Roster")}
                </button>
              )}
              {entityType === "CORPORATE" && (
                <button 
                  onClick={() => window.location.href = `/admin/organizations/${entityId}`}
                  className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg transition-colors shadow-sm"
                >
                  {tx("Manage Corporate & Census")}
                </button>
              )}
              {entityType === "INDIVIDUAL" && data && (
                <button
                  onClick={() => (risk && riskHidden ? setRiskHidden(false) : runRiskAssessment())}
                  disabled={riskLoading}
                  title={tx("AI feature: rule-engine risk screening of this profile")}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 px-4 py-2 rounded-lg transition-colors shadow-sm disabled:opacity-60"
                >
                  {riskLoading ? <span className="w-4 h-4 rounded-full border-2 border-blue-200 border-t-blue-600 animate-spin" /> : <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>}
                  {tx("Risk Assessment")}
                </button>
              )}
              {data && data.profile_status !== "DRAFT" && (
                <button 
                  onClick={() => handleSendToDraft()}
                  title={tx("AI feature: turns the selected plan into a proposal")}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-fuchsia-700 bg-fuchsia-50 border border-fuchsia-200 hover:bg-fuchsia-100 px-4 py-2 rounded-lg transition-colors shadow-sm"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>
                  {tx("Create Proposal")}
                </button>
              )}
              <button 
                onClick={() => setShowEditModal(true)}
                className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                {tx("Open Full Details Form")}
              </button>
              <button 
                onClick={onClose}
                aria-label={tx("Close")}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
          {data && (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
              {headerInfo(entityType, data).map(([label, value, mono]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{tx(label)}</dt>
                  <dd className={`mt-0.5 font-medium text-slate-800 truncate max-w-[16rem] ${mono ? "font-mono" : ""}`}>{value || <span className="text-slate-400">{tx("Not provided")}</span>}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
              <p className="text-sm font-medium text-slate-500">{tx("Retrieving profile data...")}</p>
            </div>
          ) : error ? (
            <div className={`p-6 rounded-xl border font-medium ${error.startsWith("Not eligible for cover") ? "bg-amber-50 text-amber-800 border-amber-300" : "bg-red-50 text-red-600 border-red-200"}`}>
              {error}
              {error.startsWith("Not eligible for cover") && (
                <div className="mt-3">
                  <button
                    onClick={() => {
                      const reason = window.prompt(tx("Reason for moving this lead despite the eligibility decline:"));
                      if (reason && reason.trim()) void handleSendToDraft(reason.trim());
                    }}
                    className="text-xs font-semibold text-amber-800 bg-white border border-amber-300 hover:bg-amber-100 px-4 py-2 rounded-lg transition-colors"
                  >
                    {tx("Move anyway")}
                  </button>
                  <p className="mt-1 text-[11px] font-normal text-amber-700">{tx("Underwriters and admins only. Your name and reason are recorded.")}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
                {entityType === 'INDIVIDUAL' && (risk || riskError) && !riskHidden && (
                  <div className="bg-white p-5 rounded-2xl shadow-sm border border-blue-100">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div>
                        <h3 className="flex items-center gap-1.5 text-xs font-bold text-blue-800 uppercase tracking-wider">
                          {tx("Risk Assessment")}
                          <span className="rounded-full bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[9px] text-blue-700">AI</span>
                        </h3>
                        {risk?.cover_considered ? (
                          <p className="text-xs text-slate-500 mt-1">
                            {tx("For a sum assured of PKR {0}", { 0: Number(risk.cover_considered).toLocaleString() })}
                            {risk.plan_considered ? ` · ${risk.plan_considered}` : ""}
                          </p>
                        ) : null}
                        {risk?.assessed_at && (
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            {tx("Assessed {0}", { 0: displayDateTime(risk.assessed_at) })}
                            {risk.assessed_by ? ` · ${risk.assessed_by}` : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {risk && <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${BAND_STYLE[risk.band] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}>{tx("{0} risk", { 0: tx(risk.band) })}</span>}
                        <button
                          onClick={runRiskAssessment}
                          disabled={riskLoading}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {riskLoading ? <span className="w-3 h-3 rounded-full border-2 border-slate-200 border-t-slate-600 animate-spin" /> : <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>}
                          {tx("Re-run")}
                        </button>
                        <button onClick={() => { setRiskHidden(true); setRiskError(""); }} className="p-1 text-slate-400 hover:text-slate-600" aria-label={tx("Hide")} title={tx("Hide — the result stays saved")}>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                    </div>
                    {risk?.stale && !riskError && (
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                        <p className="text-xs text-amber-800">
                          <span className="font-semibold">{tx("Out of date.")}</span>{" "}
                          {(risk.stale_reasons ?? []).join(" ")}
                        </p>
                        <button onClick={runRiskAssessment} disabled={riskLoading} className="rounded-lg bg-amber-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
                          {tx("Re-run now")}
                        </button>
                      </div>
                    )}
                    {riskError ? (
                      <p className="text-sm text-red-600">{riskError}</p>
                    ) : risk && (
                      <>
                        <div className="flex h-3 rounded-full overflow-hidden bg-slate-100" role="img" aria-label={tx("Safe {0}%, risk {1}%", { 0: risk.safe_pct, 1: risk.risk_pct })}>
                          <div className="bg-emerald-300" style={{ width: `${risk.safe_pct}%` }} />
                          <div className="bg-rose-300" style={{ width: `${risk.risk_pct}%` }} />
                        </div>
                        <div className="mt-1.5 flex justify-between text-xs font-semibold">
                          <span className="text-emerald-600">{tx("Safe")} {risk.safe_pct}%</span>
                          <span className="text-rose-700">{tx("Risk")} {risk.risk_pct}%</span>
                        </div>
                        {risk.underwriting && (risk.underwriting.referral || risk.underwriting.medical_tests.length > 0 || risk.underwriting.extra_mortality_pct > 0) && (
                          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
                            {risk.underwriting.referral && <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-semibold text-amber-800">{tx("Refer to underwriter")}</span>}
                            {risk.underwriting.extra_mortality_pct > 0 && <span className="rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 font-semibold text-orange-800">{tx("Expected loading +{0}%", { 0: risk.underwriting.extra_mortality_pct })}</span>}
                            {risk.underwriting.medical_tests.length > 0 && <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 font-semibold text-blue-800">{tx("Tests: {0}", { 0: risk.underwriting.medical_tests.join(", ") })}</span>}
                          </div>
                        )}
                        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {(risk.categories ?? []).map((cat) => <CategoryCard key={cat.key} cat={cat} />)}
                        </div>
                        {risk.missing.length > 0 && (
                          <p className="mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                            {tx("Missing details are left out; {0}% of the profile was answered.", { 0: risk.completeness_pct })}
                          </p>
                        )}
                        <p className="mt-4 text-[11px] text-slate-400">{tx("Green is the safe share and red the risk share of each factor; all four sections together make 100%.")}{" "}
                          {risk.rule_set && tx("Risks are decided by rule set {0} v{1} in the Rule Engine.", { 0: risk.rule_set.code, 1: risk.rule_set.version ?? "" })}{" "}
                          {tx("Screening view only; the underwriting decision is made on the proposal.")}</p>
                      </>
                    )}
                  </div>
                )}
                
                {/* Risk Overview (If Applicable) */}
                {entityType === 'INDIVIDUAL' && data.underwriting_score !== undefined && data.underwriting_score !== null && (
                  <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">{tx("Underwriting AI Score")}</h3>
                      <p className="text-sm text-slate-600 font-medium">{tx("Auto-generated via risk engine parameters.")}</p>
                    </div>
                    <div className="text-center px-6 py-3 bg-slate-50 rounded-xl border border-slate-100">
                      <span className={`text-3xl font-black ${data.underwriting_score >= 80 ? 'text-blue-500' : data.underwriting_score >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                        {data.underwriting_score}
                      </span>
                      <span className="text-xs font-bold text-slate-400 block mt-0.5">/ 100</span>
                    </div>
                  </div>
                )}

                {/* Relationship / Roster Data */}
                <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 min-h-[300px]">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">
                    {entityType === 'INDIVIDUAL' ? tx("Insurance Plan") : entityType === 'FAMILY' ? tx("Family Roster & Coverage") : tx("Employee Census")}
                  </h3>
                  
                  {entityType === 'INDIVIDUAL' && data.details?.pending_plan && (
                    <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold text-slate-800">{data.details.pending_plan.product_name}</p>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mt-0.5">{tx("Selected plan · not yet a proposal")}</p>
                        </div>
                        {data.details.pending_plan.term_years && <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-bold text-blue-700">{data.details.pending_plan.term_years} {tx("yr")}</span>}
                      </div>
                      {data.details.pending_plan.coverage_amount && <p className="mt-2 text-xs text-slate-600">{tx("Sum Assured")}: <span className="font-bold text-slate-800">{tx("PKR")} {Number(data.details.pending_plan.coverage_amount).toLocaleString()}</span></p>}
                      <p className="mt-2 text-xs text-slate-500">{tx("Create Proposal turns this plan into a proposal.")}</p>
                    </div>
                  )}
                  {entityType === 'INDIVIDUAL' && !data.details?.pending_plan && (
                    <p className="text-sm text-slate-400 italic py-6 text-center">{tx("No plan selected yet. Choose one in Open Full Details Form → Insurance Plans.")}</p>
                  )}
                  {entityType !== 'INDIVIDUAL' && (
                  <div className="flex flex-col items-center justify-center h-48 text-center bg-slate-50/50 rounded-xl border border-slate-100 border-dashed p-4">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 text-slate-300 mb-3">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <p className="text-sm font-semibold text-slate-700">{tx("Detailed View Protected")}</p>
                    <p className="text-xs text-slate-500 mt-1 mb-4 max-w-sm">
                      {entityType === 'FAMILY'
                        ? tx("To view and manage this family's roster, members, relationships, and health floaters, go to the family management page.")
                        : tx("To view and manage this organization's employee census, departments, and master policy, go to the organization management page.")
                      }
                    </p>
                    {entityType === "FAMILY" && (
                      <button 
                        onClick={() => window.location.href = `/admin/families/${entityId}`}
                        className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-sm"
                      >
                        {tx("Manage Family Roster →")}
                      </button>
                    )}
                    {entityType === "CORPORATE" && (
                      <button 
                        onClick={() => window.location.href = `/admin/organizations/${entityId}`}
                        className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-sm"
                      >
                        {tx("Manage Employee Census →")}
                      </button>
                    )}
                  </div>
                  )}
                </div>

            </div>
          )}
        </div>
      </div>

      {showEditModal && data && (
        <>
          {entityType === "INDIVIDUAL" && (
            <CustomerFormModal
              open={showEditModal}
              mode="edit"
              customer={data}
              onClose={() => setShowEditModal(false)}
              onSaved={(msg) => {
                fetchDetails();
                setShowEditModal(false);
                if (onSaved) onSaved();
              }}
            />
          )}
          {entityType === "FAMILY" && (
            <FamilyFormModal
              open={showEditModal}
              mode="full"
              family={data}
              onClose={() => setShowEditModal(false)}
              onSaved={(msg) => {
                fetchDetails();
                setShowEditModal(false);
                if (onSaved) onSaved();
              }}
            />
          )}
          {entityType === "CORPORATE" && (
            <OrganizationFormModal
              open={showEditModal}
              mode="full"
              organization={data}
              onClose={() => setShowEditModal(false)}
              onSaved={(msg) => {
                fetchDetails();
                setShowEditModal(false);
                if (onSaved) onSaved();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
