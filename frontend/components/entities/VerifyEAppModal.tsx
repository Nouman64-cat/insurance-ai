"use client";

import { useState } from "react";
import { EApplication, verifyEApplication } from "@/app/services/eApplication";

interface VerifyEAppModalProps {
  caseId: string;
  customerName?: string;
  eApp: EApplication;
  onClose: () => void;
  onVerified: () => void;
}

export default function VerifyEAppModal({
  caseId,
  customerName,
  eApp,
  onClose,
  onVerified,
}: VerifyEAppModalProps) {
  const [activeTab, setActiveTab] = useState<"medical" | "history" | "lifestyle" | "insurance" | "declaration">("medical");
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const medical = eApp.medical_questionnaire || {};
  const family = eApp.family_history?.entries || [];
  const lifestyle = eApp.lifestyle_habits || {};
  const existing = eApp.existing_insurance || {};
  const declaration = eApp.declaration || {};
  const customQuestions = (medical.custom_questions as any[]) || [];

  const handleApprove = async () => {
    setVerifying(true);
    setErr(null);
    try {
      await verifyEApplication(caseId, "approve");
      onVerified();
    } catch (e: any) {
      setErr(e?.message || "Failed to verify application");
    } finally {
      setVerifying(false);
    }
  };

  const handleReject = async () => {
    if (!window.confirm("Are you sure you want to request changes/re-open this application for the customer?")) {
      return;
    }
    setVerifying(true);
    setErr(null);
    try {
      await verifyEApplication(caseId, "reject");
      onVerified();
    } catch (e: any) {
      setErr(e?.message || "Failed to reset application status");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden border border-slate-100 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-blue-950 to-indigo-900 text-white flex items-center justify-between flex-shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-300">
                Customer E-Application Verification
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-500/30 text-blue-200 border border-blue-400/30">
                Submitted by Customer
              </span>
            </div>
            <h3 className="text-base font-bold text-white mt-0.5">
              Review Submitted Form — {customerName || "Applicant"}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white text-lg font-bold p-1 rounded-lg hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 bg-slate-50 px-6 gap-2 pt-2 flex-shrink-0 overflow-x-auto">
          {[
            { id: "medical", label: "🩺 Medical & Health" },
            { id: "history", label: "👨‍👩‍👧 Family History" },
            { id: "lifestyle", label: "🏃 Lifestyle & Travel" },
            { id: "insurance", label: "📜 Existing Insurance" },
            { id: "declaration", label: "✍️ Declaration & Signature" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all whitespace-nowrap ${
                activeTab === t.id
                  ? "border-blue-600 text-blue-600 bg-white shadow-xs"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1 bg-white">
          {/* TAB 1: MEDICAL */}
          {activeTab === "medical" && (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Height</span>
                  <p className="font-semibold text-slate-800">{medical.height_cm ? `${medical.height_cm} cm` : "Not specified"}</p>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Weight</span>
                  <p className="font-semibold text-slate-800">{medical.weight_kg ? `${medical.weight_kg} kg` : "Not specified"}</p>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Tobacco / Nicotine</span>
                  <p className="font-semibold text-slate-800">{medical.tobacco_use ? `Yes (${medical.tobacco_frequency || "No freq"})` : "No"}</p>
                </div>
              </div>

              {/* Medical Conditions */}
              <div>
                <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wide mb-2">Medical Conditions Checklist</h4>
                {(!medical.conditions || medical.conditions.filter((c: any) => c.checked).length === 0) ? (
                  <p className="text-slate-500 italic bg-slate-50 p-2.5 rounded-lg border border-slate-200">No medical conditions declared by applicant.</p>
                ) : (
                  <div className="space-y-2">
                    {medical.conditions.filter((c: any) => c.checked).map((c: any) => (
                      <div key={c.key} className="bg-amber-50/60 border border-amber-200 rounded-xl p-3 space-y-1">
                        <span className="font-bold text-amber-900">⚠️ {c.label}</span>
                        <div className="grid grid-cols-2 gap-2 text-[11px] text-amber-800 pt-1">
                          <p>Year of Diagnosis: <span className="font-semibold">{c.year_of_diagnosis || "N/A"}</span></p>
                          <p>Under Treatment: <span className="font-semibold">{c.under_treatment ? "Yes" : "No"}</span></p>
                          <p>Medications: <span className="font-semibold">{c.medications || "None"}</span></p>
                          <p>Physician: <span className="font-semibold">{c.physician_name || "N/A"} ({c.physician_clinic || ""})</span></p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Custom Questions */}
              {customQuestions.length > 0 && (
                <div>
                  <h4 className="font-bold text-blue-900 text-xs uppercase tracking-wide mb-2">Custom Questions Answers</h4>
                  <div className="space-y-2">
                    {customQuestions.map((cq: any, idx: number) => (
                      <div key={cq.id || idx} className="bg-blue-50/60 border border-blue-200 rounded-xl p-3">
                        <p className="font-semibold text-blue-900">{cq.question}</p>
                        <p className="text-slate-800 mt-1 font-medium">
                          Answer: <span className="font-bold text-blue-700">{cq.answer || "No response"}</span>
                        </p>
                        {cq.details && <p className="text-slate-600 text-[11px] mt-0.5">Details: {cq.details}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: FAMILY HISTORY */}
          {activeTab === "history" && (
            <div className="space-y-3 text-xs">
              <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wide">Family Medical History</h4>
              {family.length === 0 ? (
                <p className="text-slate-500 italic bg-slate-50 p-3 rounded-lg border border-slate-200">No family medical history entries recorded.</p>
              ) : (
                <div className="space-y-2">
                  {family.map((f: any, idx: number) => (
                    <div key={idx} className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex justify-between items-center">
                      <div>
                        <span className="font-bold text-slate-800">{f.relation}</span> {f.name ? `(${f.name})` : ""}
                        <p className="text-slate-500 text-[11px]">Age: {f.age || "N/A"} · Status: {f.is_alive ? "Living" : "Deceased"}</p>
                      </div>
                      <div className="text-right">
                        <span className="font-semibold text-slate-700">{f.condition || "Healthy"}</span>
                        {f.age_at_onset && <p className="text-[11px] text-slate-400">Onset at age {f.age_at_onset}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: LIFESTYLE */}
          {activeTab === "lifestyle" && (
            <div className="space-y-3 text-xs">
              <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wide">Lifestyle & Risk Disclosures</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-slate-500">Hazardous Hobbies:</span>
                  <p className="font-semibold text-slate-800">{lifestyle.has_hazardous_hobby ? `Yes (${lifestyle.hazardous_hobby_details || ""})` : "No"}</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-slate-500">Occupation Hazard Level:</span>
                  <p className="font-semibold text-slate-800">{lifestyle.occupation_hazard_level || "Low"}</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-slate-500">Frequent Foreign Travel:</span>
                  <p className="font-semibold text-slate-800">{lifestyle.frequent_foreign_travel ? `Yes (${lifestyle.foreign_travel_details || ""})` : "No"}</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-slate-500">Traffic Violations (3 yrs):</span>
                  <p className="font-semibold text-slate-800">{lifestyle.moving_violations_past_3_years || "0"}</p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: EXISTING INSURANCE */}
          {activeTab === "insurance" && (
            <div className="space-y-3 text-xs">
              <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wide">Existing Insurance Policies</h4>
              {(!existing.policies || existing.policies.length === 0) ? (
                <p className="text-slate-500 italic bg-slate-50 p-3 rounded-lg border border-slate-200">No existing insurance policies declared.</p>
              ) : (
                <div className="space-y-2">
                  {existing.policies.map((p: any, idx: number) => (
                    <div key={idx} className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex justify-between items-center">
                      <div>
                        <span className="font-bold text-slate-800">{p.insurer_name}</span> (Policy #{p.policy_number})
                        <p className="text-slate-500 text-[11px]">Sum Assured: PKR {Number(p.sum_assured || 0).toLocaleString()}</p>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-100 text-blue-800">
                        {p.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: DECLARATION */}
          {activeTab === "declaration" && (
            <div className="space-y-3 text-xs">
              <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wide">Customer Declaration & E-Signature</h4>
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-slate-700">
                  <span className="text-blue-600 font-bold">✓</span> Information accuracy confirmed by customer
                </div>
                <div className="flex items-center gap-2 text-slate-700">
                  <span className="text-blue-600 font-bold">✓</span> Medical & record access authorized
                </div>
                <div className="flex items-center gap-2 text-slate-700">
                  <span className="text-blue-600 font-bold">✓</span> Policy terms & free-look understood
                </div>
                <div className="pt-3 border-t border-slate-200 flex justify-between items-center">
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase">Typed Legal Signature</span>
                    <p className="text-sm font-bold text-blue-900 font-mono">{declaration.signature_name || "N/A"}</p>
                  </div>
                  <div className="text-right text-[11px] text-slate-400">
                    Submitted: {eApp.submitted_at ? new Date(eApp.submitted_at).toLocaleString() : "Recently"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {err && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {err}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between flex-shrink-0">
          <button
            onClick={handleReject}
            disabled={verifying}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-amber-700 hover:bg-amber-100/60 border border-amber-300 disabled:opacity-40 transition-all"
          >
            Request Revision / Re-open
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
            >
              Close Preview
            </button>
            <button
              onClick={handleApprove}
              disabled={verifying}
              className="px-6 py-2.5 rounded-xl text-xs font-extrabold bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg disabled:opacity-40 transition-all flex items-center gap-2"
            >
              {verifying ? "Verifying & Approving..." : "✓ Approve & Verify E-Application"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
