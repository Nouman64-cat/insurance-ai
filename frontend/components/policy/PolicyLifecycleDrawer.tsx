"use client";

import { displayDate } from '../../lib/dateDisplay';
import { displayDateTime } from '../../lib/dateDisplay';
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  getPolicyDetail,
  getPolicyEvents,
  fmtPKR,
  downloadDocument,
  type PolicyDetail,
  type PolicyEvent,
} from "@/app/services/policies";
import { fmtCoverage } from "@/lib/mock-data";
import { LifecycleStepper } from "./LifecycleStepper";
import { StageAPanel } from "./StageAPanel";
import { ISSUANCE_STAGES, currentStageIndex, normStatus } from "./lifecycle";
import { tx } from "@/lib/i18n/tx";
import { humanize, eventTitle, eventActor, friendlyTime } from "./eventText";

// Statuses where the Stage A pre-issuance checklist is relevant.
const PRE_ISSUANCE_STATUSES = new Set([
  "COUNTEROFFER", "APPROVED", "ACCEPTEDWITHLOADINGS", "INFORMATIONREQUESTED", "PENDINGPAYMENT", "ISSUED",
]);

// Statuses where the policy is in-force / post-issuance — Stage B management.
const POST_ISSUANCE_STATUSES = new Set([
  "ACTIVE", "GRACEPERIOD", "LAPSED", "CANCELLED",
]);

interface DrawerProps {
  policyId: string;
  fallbackName?: string;
  onClose: () => void;
  /** The page's next step for this policy (e.g. Issue Policy), shown in the footer. */
  primaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
    icon?: ReactNode;
  };
}

const SCHEDULE_TONE: Record<string, string> = {
  PAID: "bg-blue-50 text-blue-700 border-blue-200",
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  OVERDUE: "bg-red-50 text-red-700 border-red-200",
  WAIVED: "bg-slate-100 text-slate-500 border-slate-200",
};

// ── Audit trail, in plain language ──────────────────────────────────────────
// Events are stored with machine names (proposal_status_change, PolicyIssued),
// joined-up statuses (UnderReview) and user ids; this turns them into what
// happened, who did it and when.

// Icon + colour from what the event means, so the trail reads at a glance.
function eventTone(evt: PolicyEvent): { dot: string; icon: ReactNode } {
  // The event's own meaning decides first ("Policy issued" is a success even
  // though its new status is "Pending payment"); the status only breaks ties.
  const type = (evt.event_type || "").toLowerCase();
  const t = /(issued|approv|activ|renew|reinstat|revived|accepted|declin|reject|lapse|cancel|fail|terminat|not ?taken)/.test(type)
    ? type
    : `${type} ${evt.to_status ?? ""}`.toLowerCase();
  const check = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
  if (/(declin|reject|lapse|cancel|fail|terminat|not taken)/.test(t))
    return {
      dot: "bg-red-50 text-red-600 ring-red-100",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ),
    };
  if (/(payment|premium|collect)/.test(t))
    return {
      dot: "bg-amber-50 text-amber-600 ring-amber-100",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5">
          <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
        </svg>
      ),
    };
  if (/(approv|issued|active|renew|reinstat|revived|accepted)/.test(t))
    return { dot: "bg-emerald-50 text-emerald-600 ring-emerald-100", icon: check };
  return {
    dot: "bg-blue-50 text-blue-600 ring-blue-100",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    ),
  };
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return displayDateTime(d, { dateStyle: "medium", timeStyle: "short" });
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ISSUED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  APPROVED: "bg-blue-50 text-blue-700 ring-blue-200",
  ACCEPTEDWITHLOADINGS: "bg-blue-50 text-blue-700 ring-blue-200",
  PENDINGPAYMENT: "bg-amber-50 text-amber-700 ring-amber-200",
  GRACEPERIOD: "bg-amber-50 text-amber-700 ring-amber-200",
  LAPSED: "bg-red-50 text-red-700 ring-red-200",
  CANCELLED: "bg-red-50 text-red-700 ring-red-200",
};

function Panel({ title, action, children }: Readonly<{ title: string; action?: ReactNode; children: ReactNode }>) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Centered dialog showing a policy's full lifecycle: the journey stepper, the
 * current-stage explainer, the Stage A checklist, contract facts, the premium
 * billing schedule, generated documents and the immutable audit event
 * timeline (from GET /events).
 */
export function PolicyLifecycleDrawer({ policyId, fallbackName, onClose, primaryAction }: Readonly<DrawerProps>) {
  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [events, setEvents] = useState<PolicyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [d, e] = await Promise.all([
        getPolicyDetail(policyId),
        getPolicyEvents(policyId).catch(() => [] as PolicyEvent[]),
      ]);
      setDetail(d);
      setEvents(e);
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? tx("Failed to load policy."));
    }
  }, [policyId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await reload();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [reload]);

  // Esc closes; the page behind stays put while the dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const status = detail?.status ?? "";
  const stageIdx = currentStageIndex(status);
  const currentStage = stageIdx >= 0 ? ISSUANCE_STAGES[stageIdx] : null;
  const paidCount = detail?.premium_schedules.filter((s) => normStatus(s.status) === "PAID").length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm animate-in fade-in duration-200 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={detail?.customer_name ?? fallbackName ?? tx("Policy")}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-slate-50 shadow-2xl ring-1 ring-slate-900/5 animate-in zoom-in-95 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative border-b border-slate-200/80 bg-white px-6 pb-4 pt-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500" />
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-base font-bold text-white shadow-sm">
                {(detail?.customer_name ?? fallbackName ?? "P").trim().charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                {currentStage && (
                  <p className="mb-0.5 text-xs font-bold uppercase tracking-wider text-blue-700">{tx(currentStage.label)}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-lg font-bold tracking-tight text-slate-900">
                    {detail?.customer_name ?? fallbackName ?? tx("Policy")}
                  </h2>
                  {status && (
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${STATUS_TONE[normStatus(status)] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
                      {status}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  <span className="font-mono">{detail?.policy_number ?? tx("Not yet issued")}</span>
                  {detail?.product_name ? ` · ${detail.product_name}` : ""}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label={tx("Close")}
              className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          {detail && (
            <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                [tx("Sum Assured"), fmtCoverage(detail.coverage_amount)],
                [tx("Term"), tx("{0} years", { 0: detail.term_years })],
                [tx("Premiums paid"), `${paidCount} / ${detail.premium_schedules.length}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-100">
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{k}</dt>
                  <dd className="mt-0.5 truncate text-sm font-semibold text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex justify-center py-24">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-blue-500" />
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : detail ? (
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                {/* Left: where the policy is and what it still needs */}
                <div className="space-y-4">
                  <Panel title={tx("Lifecycle Journey")}>
                    <LifecycleStepper status={status} />
                  </Panel>

                </div>

                {/* Right: the contract itself */}
                <div className="space-y-4">
                  <Panel title={tx("Contract")}>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                      {[
                        ["Nominee", detail.nominee_name ?? "—"],
                        ["Effective", detail.effective_date ?? "—"],
                        ["Expiry", detail.expiry_date ?? "—"],
                        ["Grace ends", detail.grace_period_end_date ?? "—"],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{tx(k)}</dt>
                          <dd className="mt-0.5 truncate text-sm font-semibold text-slate-800">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </Panel>

                  <Panel title={tx("Premium Schedule ({0})", { 0: detail.premium_schedules.length })}>
                    {detail.premium_schedules.length === 0 ? (
                      <p className="text-xs italic text-slate-400">{tx("No installments yet — created when the policy is drafted.")}</p>
                    ) : (
                      <ul className="max-h-56 space-y-1.5 overflow-y-auto">
                        {detail.premium_schedules.map((s) => (
                          <li key={s.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                            <div>
                              <p className="text-xs font-semibold text-slate-700">{tx("Due")} {displayDate(s.due_date)}</p>
                              <p className="text-[10px] text-slate-400">
                                {tx("Paid")} {fmtPKR(s.amount_paid)} {tx("of")} {fmtPKR(s.amount_due)}
                              </p>
                            </div>
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${SCHEDULE_TONE[normStatus(s.status)] ?? "border-slate-200 bg-slate-100 text-slate-600"}`}>
                              {s.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Panel>

                  <Panel title={tx("Documents ({0})", { 0: detail.documents.length })}>
                    {detail.documents.length === 0 ? (
                      <p className="text-xs italic text-slate-400">{tx("No documents generated yet.")}</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {detail.documents.map((d) => (
                          <li key={d.id} className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2">
                            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-white text-slate-400 ring-1 ring-slate-200">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                              </svg>
                            </span>
                            <p className="flex-1 truncate text-xs font-medium text-slate-700">{d.document_name}</p>
                            {d.is_stub ? (
                              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600">
                                {tx("STUB")}
                              </span>
                            ) : (
                              <button
                                onClick={() => downloadDocument(policyId, d.id).catch(err => alert("Failed to download document: " + err.message))}
                                title={tx("Download Document")}
                                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Panel>
                </div>
              </div>

              {/* Stage A — full width: its steps (beneficiaries, reinsurance…) need the room */}
              {PRE_ISSUANCE_STATUSES.has(normStatus(status)) && (
                <Panel title={tx("Stage A — Pre-Issuance")}>
                  <StageAPanel policyId={policyId} onChanged={reload} />
                </Panel>
              )}

              {/* Audit trail */}
              <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white">
                <button
                  type="button"
                  onClick={() => setShowEvents(!showEvents)}
                  aria-expanded={showEvents}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50"
                >
                  <div>
                    <p className="text-sm font-bold text-slate-800">
                      {tx("Audit Trail")}{" "}
                      <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">{events.length}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{tx("Everything that has happened on this policy, newest first.")}</p>
                  </div>
                  <svg className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform duration-300 ${showEvents ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showEvents && (
                  <div className="border-t border-slate-100 px-5 py-5">
                    {events.length === 0 ? (
                      <p className="text-xs italic text-slate-400">{tx("No lifecycle events recorded yet.")}</p>
                    ) : (
                      <ol className="space-y-0">
                        {[...events].reverse().map((evt, i, list) => {
                          const tone = eventTone(evt);
                          const from = humanize(evt.from_status);
                          const to = humanize(evt.to_status);
                          return (
                            <li key={evt.id} className="relative flex gap-3 pb-5 last:pb-0">
                              {i < list.length - 1 && <span className="absolute left-[15px] top-8 bottom-0 w-px bg-slate-200" aria-hidden />}
                              <span className={`relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ring-4 ring-white ${tone.dot}`}>
                                {tone.icon}
                              </span>
                              <div className="min-w-0 flex-1 pt-0.5">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                  <p className="text-sm font-semibold text-slate-800">{eventTitle(evt)}</p>
                                  <time dateTime={evt.created_at} title={fmtDateTime(evt.created_at)} className="text-[11px] text-slate-400">
                                    {friendlyTime(evt.created_at)}
                                  </time>
                                </div>
                                <p className="mt-0.5 text-xs text-slate-500">
                                  {tx("by")} <span className="font-medium text-slate-700">{eventActor(evt)}</span>
                                </p>
                                {from && to && (
                                  <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-500 ring-1 ring-slate-100">
                                    {from}
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 text-slate-300" aria-hidden>
                                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                                    </svg>
                                    <span className="font-semibold text-slate-700">{to}</span>
                                  </p>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>

        {/* Footer — always visible, so the next step never scrolls away */}
        <div className="flex items-center justify-end gap-3 border-t border-slate-200/80 bg-white px-6 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
            >
              {tx("Close")}
            </button>
            {!primaryAction && POST_ISSUANCE_STATUSES.has(normStatus(status)) && (
              <Link
                href={`/post-issuance/${policyId}`}
                title={tx("Free-look, servicing, renewals & claims.")}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:from-blue-700 hover:to-indigo-700 active:scale-[0.98]"
              >
                {tx("Manage Policy")}
                <span aria-hidden>→</span>
              </Link>
            )}
            {primaryAction && (
              <button
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled || loading}
                title={primaryAction.title}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:from-blue-700 hover:to-indigo-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {primaryAction.icon}
                {primaryAction.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
