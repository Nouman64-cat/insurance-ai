"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  getPolicyDetail,
  getPolicyEvents,
  fmtPKR,
  type PolicyDetail,
  type PolicyEvent,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";
import { LifecycleStepper } from "./LifecycleStepper";
import { ISSUANCE_STAGES, currentStageIndex, normStatus } from "./lifecycle";

interface DrawerProps {
  policyId: string;
  fallbackName?: string;
  onClose: () => void;
}

const SCHEDULE_TONE: Record<string, string> = {
  PAID: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  OVERDUE: "bg-red-50 text-red-700 border-red-200",
  WAIVED: "bg-slate-100 text-slate-500 border-slate-200",
};

// Map an event to an icon + accent so the timeline reads at a glance.
function eventTone(evt: PolicyEvent): { dot: string; icon: ReactNode } {
  const t = (evt.event_type || "").toLowerCase();
  if (t.includes("payment") || t.includes("collect"))
    return {
      dot: "bg-amber-500",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-3 h-3">
          <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      ),
    };
  if (t.includes("lapse") || t.includes("cancel") || t.includes("declin"))
    return {
      dot: "bg-red-500",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-3 h-3">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ),
    };
  if (t.includes("active") || t.includes("issue") || t.includes("renew"))
    return {
      dot: "bg-emerald-500",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" className="w-3 h-3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ),
    };
  return {
    dot: "bg-slate-400",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-3 h-3">
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
  };
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">{title}</p>
      {children}
    </div>
  );
}

/**
 * Right-side drawer showing a policy's full lifecycle: the journey stepper,
 * the current-stage explainer, the premium billing schedule, generated
 * documents and — most importantly — the immutable audit event timeline
 * (from GET /events). This is where the Phase 0/1 work becomes visible.
 */
export function PolicyLifecycleDrawer({ policyId, fallbackName, onClose }: Readonly<DrawerProps>) {
  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [events, setEvents] = useState<PolicyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [d, e] = await Promise.all([
          getPolicyDetail(policyId),
          getPolicyEvents(policyId).catch(() => [] as PolicyEvent[]),
        ]);
        if (!alive) return;
        setDetail(d);
        setEvents(e);
      } catch (err: any) {
        if (alive) setError(err?.response?.data?.detail ?? "Failed to load policy.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [policyId]);

  const status = detail?.status ?? "";
  const stageIdx = currentStageIndex(status);
  const currentStage = stageIdx >= 0 ? ISSUANCE_STAGES[stageIdx] : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <button className="flex-1 cursor-default" aria-label="Close" onClick={onClose} />
      <div className="w-full max-w-xl h-full bg-white shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-6 py-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900 tracking-tight">
              {detail?.customer_name ?? fallbackName ?? "Policy"}
            </h2>
            <p className="text-xs text-slate-500 font-mono mt-0.5">
              {detail?.policy_number ?? "Not yet issued"}
              {detail?.product_name ? ` · ${detail.product_name}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="py-24 flex justify-center">
            <div className="animate-spin h-6 w-6 rounded-full border-2 border-slate-100 border-t-emerald-500" />
          </div>
        ) : error ? (
          <div className="m-6 bg-red-50 text-red-700 p-4 rounded-lg border border-red-200 text-sm">{error}</div>
        ) : detail ? (
          <div className="px-6 py-5 space-y-7">
            {/* Journey stepper */}
            <Section title="Lifecycle Journey">
              <div className="bg-slate-50 rounded-xl p-4">
                <LifecycleStepper status={status} />
                {currentStage && (
                  <p className="mt-4 text-xs text-slate-500 leading-relaxed border-t border-slate-200 pt-3">
                    <span className="font-semibold text-slate-700">{currentStage.label}: </span>
                    {currentStage.blurb}
                  </p>
                )}
              </div>
            </Section>

            {/* Key facts */}
            <Section title="Contract">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {[
                  ["Sum Assured", fmtCoverage(detail.coverage_amount)],
                  ["Term", `${detail.term_years} years`],
                  ["Nominee", detail.nominee_name ?? "—"],
                  ["Effective", detail.effective_date ?? "—"],
                  ["Expiry", detail.expiry_date ?? "—"],
                  ["Grace ends", detail.grace_period_end_date ?? "—"],
                ].map(([k, v]) => (
                  <div key={k}>
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">{k}</p>
                    <p className="text-sm font-semibold text-slate-800 mt-0.5">{v}</p>
                  </div>
                ))}
              </div>
            </Section>

            {/* Premium schedule */}
            <Section title={`Premium Schedule (${detail.premium_schedules.length})`}>
              {detail.premium_schedules.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No installments yet — created when the policy is drafted.</p>
              ) : (
                <div className="border border-slate-100 rounded-lg overflow-hidden divide-y divide-slate-50">
                  {detail.premium_schedules.map((s) => (
                    <div key={s.id} className="flex items-center justify-between px-3 py-2.5">
                      <div>
                        <p className="text-xs font-semibold text-slate-700">Due {s.due_date}</p>
                        <p className="text-[10px] text-slate-400">
                          Paid {fmtPKR(s.amount_paid)} of {fmtPKR(s.amount_due)}
                        </p>
                      </div>
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          SCHEDULE_TONE[normStatus(s.status)] ?? "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {s.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Documents */}
            <Section title={`Documents (${detail.documents.length})`}>
              {detail.documents.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No documents generated yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {detail.documents.map((d) => (
                    <div key={d.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-50">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-4 h-4 text-slate-400 flex-shrink-0">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                      </svg>
                      <p className="text-xs font-medium text-slate-700 flex-1 truncate">{d.document_name}</p>
                      {d.is_stub && (
                        <span className="text-[9px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                          STUB
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Event timeline — the audit trail */}
            <Section title={`Lifecycle Events (${events.length})`}>
              {events.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No lifecycle events recorded yet.</p>
              ) : (
                <ol className="relative border-l border-slate-200 ml-2 space-y-4">
                  {events.map((evt) => {
                    const tone = eventTone(evt);
                    return (
                      <li key={evt.id} className="ml-5">
                        <span
                          className={`absolute -left-[9px] flex items-center justify-center w-[18px] h-[18px] rounded-full ring-4 ring-white ${tone.dot}`}
                        >
                          {tone.icon}
                        </span>
                        <p className="text-xs font-semibold text-slate-800">{evt.event_type}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {evt.from_status && evt.to_status ? (
                            <>
                              <span className="font-medium">{evt.from_status}</span>
                              <span className="mx-1">→</span>
                              <span className="font-medium text-slate-700">{evt.to_status}</span>
                              <span className="mx-1.5 text-slate-300">·</span>
                            </>
                          ) : null}
                          by {evt.actor}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-0.5">{fmtDateTime(evt.created_at)}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
