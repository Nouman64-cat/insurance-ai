"use client";

import { displayDateTime } from '../../lib/dateDisplay';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EApplication, verifyEApplication } from "@/app/services/eApplication";
import { tx } from "@/lib/i18n/tx";

interface VerifyEAppModalProps {
  caseId: string;
  customerName?: string;
  eApp: EApplication;
  onClose: () => void;
  onVerified: (action: "approve" | "reject") => void;
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

  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !verifying) onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; previous?.focus(); };
  }, [onClose, verifying]);

  const flagged = (medical.conditions || []).filter((c: any) => c.checked);
  const tabs: { id: typeof activeTab; label: string; count?: number; icon: string }[] = [
    { id: "medical", label: "Medical & Health", count: flagged.length + customQuestions.length, icon: "M4.318 6.318a4.5 4.5 0 0 0 0 6.364L12 20.364l7.682-7.682a4.5 4.5 0 0 0-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 0 0-6.364 0Z" },
    { id: "history", label: "Family History", count: family.length, icon: "M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m6-3.13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" },
    { id: "lifestyle", label: "Lifestyle & Travel", icon: "M3 12h4l3-8 4 16 3-8h4" },
    { id: "insurance", label: "Existing Insurance", count: (existing.policies || []).length, icon: "M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6l-8-3Z" },
    { id: "declaration", label: "Declaration & Signature", icon: "M15.232 5.232l3.536 3.536M9 13l-1 4 4-1 8.5-8.5a2.5 2.5 0 0 0-3.5-3.5L9 13Z" },
  ];

  const handleApprove = async () => {
    setVerifying(true);
    setErr(null);
    try {
      await verifyEApplication(caseId, "approve");
      onVerified("approve");
    } catch (e: any) {
      setErr(e?.message || "Failed to verify application");
    } finally {
      setVerifying(false);
    }
  };

  const handleReject = async () => {
    if (!window.confirm(tx("Are you sure you want to request changes/re-open this application for the customer?"))) {
      return;
    }
    setVerifying(true);
    setErr(null);
    try {
      await verifyEApplication(caseId, "reject");
      onVerified("reject");
    } catch (e: any) {
      setErr(e?.message || "Failed to reset application status");
    } finally {
      setVerifying(false);
    }
  };

  const Icon = ({ d, className = "h-4 w-4" }: { d: string; className?: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={d} /></svg>
  );
  const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-0.5 text-sm font-medium text-slate-900 break-words">{children}</dd></div>
  );
  const Section = ({ title, hint }: { title: string; hint?: string }) => (
    <div className="mb-2"><h4 className="text-sm font-bold text-slate-900">{title}</h4>{hint && <p className="text-xs text-slate-500">{hint}</p>}</div>
  );
  const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">{children}</p>;
  const Pill = ({ tone, children }: { tone: "amber" | "blue" | "slate" | "emerald"; children: ReactNode }) => {
    const c = { amber: "bg-amber-50 text-amber-800 ring-amber-200", blue: "bg-blue-50 text-blue-700 ring-blue-200", slate: "bg-slate-100 text-slate-600 ring-slate-200", emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200" }[tone];
    return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${c}`}>{children}</span>;
  };
  const yes = (v: unknown, detail?: string) => (v ? <>{tx("Yes")}{detail ? ` — ${detail}` : ""}</> : tx("No"));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onClick={() => !verifying && onClose()}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="eapp-title"
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl outline-none sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Customer E-Application Verification")}</p>
            <h3 id="eapp-title" className="mt-0.5 truncate text-lg font-bold text-slate-900">{tx("Review Submitted Form —")}{" "}{customerName || tx("Applicant")}</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Pill tone="blue">{tx("Submitted by Customer")}</Pill>
              {eApp.submitted_at && <span>{displayDateTime(eApp.submitted_at)}</span>}
            </div>
          </div>
          <button onClick={onClose} disabled={verifying} aria-label={tx("Close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label={tx("E-application sections")} className="flex gap-1 overflow-x-auto border-b border-slate-200 px-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              onClick={() => setActiveTab(t.id)}
              className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:bg-slate-50 ${
                activeTab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <Icon d={t.icon} />
              {tx(t.label)}
              {!!t.count && <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${activeTab === t.id ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{t.count}</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div role="tabpanel" className="flex-1 space-y-5 overflow-y-auto bg-slate-50/50 px-6 py-5">
          {activeTab === "medical" && (
            <>
              <dl className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
                <Fact label={tx("Height")}>{medical.height_cm ? tx("{0} cm", { 0: medical.height_cm }) : tx("Not specified")}</Fact>
                <Fact label={tx("Weight")}>{medical.weight_kg ? tx("{0} kg", { 0: medical.weight_kg }) : tx("Not specified")}</Fact>
                <Fact label={tx("Tobacco / Nicotine")}>{medical.tobacco_use ? tx("Yes ({0})", { 0: medical.tobacco_frequency || "No freq" }) : tx("No")}</Fact>
              </dl>

              <section>
                <Section title={tx("Medical Conditions Checklist")} hint={flagged.length ? tx("{0} condition(s) declared by the applicant", { 0: flagged.length }) : undefined} />
                {flagged.length === 0 ? <Empty>{tx("No medical conditions declared by applicant.")}</Empty> : (
                  <ul className="space-y-2.5">
                    {flagged.map((c: any) => (
                      <li key={c.key} className="rounded-xl border border-amber-200 border-s-4 border-s-amber-400 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{tx(c.label)}</span>
                          <Pill tone="amber">{tx("Declared")}</Pill>
                        </div>
                        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                          <Fact label={tx("Year of Diagnosis")}>{c.year_of_diagnosis || "N/A"}</Fact>
                          <Fact label={tx("Under Treatment")}>{c.under_treatment ? tx("Yes") : tx("No")}</Fact>
                          <Fact label={tx("Medications")}>{c.medications || tx("None")}</Fact>
                          <Fact label={tx("Physician")}>{c.physician_name || "N/A"}{c.physician_clinic ? ` (${c.physician_clinic})` : ""}</Fact>
                        </dl>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {customQuestions.length > 0 && (
                <section>
                  <Section title={tx("Custom Questions Answers")} />
                  <ul className="space-y-2.5">
                    {customQuestions.map((cq: any, idx: number) => (
                      <li key={cq.id || idx} className="rounded-xl border border-slate-200 bg-white p-4">
                        <p className="text-sm font-semibold text-slate-900">{cq.question}</p>
                        <p className="mt-1 text-sm text-slate-700">{tx("Answer:")}{" "}<span className="font-semibold text-blue-700">{cq.answer || tx("No response")}</span></p>
                        {cq.details && <p className="mt-0.5 text-xs text-slate-500">{tx("Details:")}{" "}{cq.details}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}

          {activeTab === "history" && (
            <section>
              <Section title={tx("Family Medical History")} />
              {family.length === 0 ? <Empty>{tx("No family medical history entries recorded.")}</Empty> : (
                <ul className="space-y-2.5">
                  {family.map((f: any, idx: number) => (
                    <li key={idx} className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">{f.relation}{f.name ? ` (${f.name})` : ""}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{tx("Age:")}{" "}{f.age || "N/A"}{" "}{tx("· Status:")}{" "}{f.is_alive ? tx("Living") : tx("Deceased")}</p>
                      </div>
                      <div className="shrink-0 text-end">
                        <p className="text-sm font-medium text-slate-800">{f.condition || tx("Healthy")}</p>
                        {f.age_at_onset && <p className="text-xs text-slate-500">{tx("Onset at age")}{" "}{f.age_at_onset}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {activeTab === "lifestyle" && (
            <section>
              <Section title={tx("Lifestyle & Risk Disclosures")} />
              <dl className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
                <Fact label={tx("Hazardous Hobbies")}>{yes(lifestyle.has_hazardous_hobby, lifestyle.hazardous_hobby_details)}</Fact>
                <Fact label={tx("Occupation Hazard Level")}>{lifestyle.occupation_hazard_level || tx("Low")}</Fact>
                <Fact label={tx("Frequent Foreign Travel")}>{yes(lifestyle.frequent_foreign_travel, lifestyle.foreign_travel_details)}</Fact>
                <Fact label={tx("Regular Road Travel")}>
                  {lifestyle.road_travel_frequent ? tx("Yes — {0} trips/month, ~{1} h each", { 0: lifestyle.road_trips_per_month || "—", 1: lifestyle.road_trip_hours || "—" }) : tx("No")}
                  {lifestyle.road_travel_frequent && lifestyle.road_travel_details && <span className="mt-0.5 block text-xs font-normal text-slate-500">{lifestyle.road_travel_details}</span>}
                </Fact>
                <Fact label={tx("Traffic Violations (3 yrs)")}>{lifestyle.moving_violations_past_3_years || "0"}</Fact>
              </dl>
            </section>
          )}

          {activeTab === "insurance" && (
            <section>
              <Section title={tx("Existing Insurance Policies")} />
              {(!existing.policies || existing.policies.length === 0) ? <Empty>{tx("No existing insurance policies declared.")}</Empty> : (
                <ul className="space-y-2.5">
                  {existing.policies.map((p: any, idx: number) => (
                    <li key={idx} className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">{p.insurer_name}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{tx("(Policy #")}{p.policy_number})</p>
                        <p className="mt-0.5 text-xs text-slate-500">{tx("Sum Assured: PKR")}{" "}{Number(p.sum_assured || 0).toLocaleString()}</p>
                      </div>
                      <Pill tone="blue">{p.status}</Pill>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {activeTab === "declaration" && (
            <section>
              <Section title={tx("Customer Declaration & E-Signature")} />
              <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                {["Information accuracy confirmed by customer", "Medical & record access authorized", "Policy terms & free-look understood"].map((line) => (
                  <p key={line} className="flex items-center gap-2.5 text-sm text-slate-800">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Icon d="M5 13l4 4L19 7" className="h-3.5 w-3.5" /></span>
                    {tx(line)}
                  </p>
                ))}
                <dl className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-3 sm:grid-cols-2">
                  <Fact label={tx("Typed Legal Signature")}><span className="font-mono text-base font-bold text-blue-800">{declaration.signature_name || "N/A"}</span></Fact>
                  <Fact label={tx("Submitted")}>{eApp.submitted_at ? displayDateTime(eApp.submitted_at) : tx("Recently")}</Fact>
                </dl>
              </div>
            </section>
          )}

          {err && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
        </div>

        {/* Footer: the decision */}
        <div className="flex flex-col-reverse gap-3 border-t border-slate-200 bg-white px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={handleReject}
            disabled={verifying}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {tx("Request Revision / Re-open")}
          </button>
          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose} disabled={verifying} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">{tx("Close Preview")}</button>
            <button
              onClick={handleApprove}
              disabled={verifying}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
            >
              {verifying ? tx("Verifying & Approving...") : <><Icon d="M5 13l4 4L19 7" />{tx("Approve & Verify E-Application")}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
