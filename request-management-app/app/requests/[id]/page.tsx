"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { appHref } from "@/lib/appLinks";
import {
  newKey, requestsApi, RequestsError, type Action, type RequestDetail, type Reviewer, type TimelineEvent,
} from "@/lib/requestsApi";
import { useRequestEvents, useSummary } from "@/components/RequestsShell";
import {
  CATEGORY_LABEL, Card, DISPUTE_LABEL, EXECUTION_LABEL, Empty, ErrorNote, ExecutionBadge, PriorityText, ReviewBadge, Spinner, TYPE_LABEL, dangerButton, formatDate,
  inputClass, labelClass, primaryButton, secondaryButton,
} from "@/components/ui";

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Draft created", DRAFT_EDITED: "Draft edited", REVISION_CREATED: "New revision started", SUBMITTED: "Submitted",
  RESUBMITTED: "Resubmitted", REVIEW_STARTED: "Review started", RELEASED_TO_QUEUE: "Returned to the team queue",
  INFORMATION_REQUESTED: "More information requested", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled",
  REASSIGNED: "Reassigned", COMMENT_ADDED: "Comment added", ATTACHMENT_ADDED: "Attachment added",
  EXECUTION_STARTED: "Applying the approved change", EXECUTION_SUCCEEDED: "Approved change applied",
  EXECUTION_RETRY_SCHEDULED: "Applying failed; retry scheduled", EXECUTION_FAILED: "Applying the approved change failed",
  EXECUTION_RETRY_REQUESTED: "Retry requested", REOPENED_AFTER_CONFLICT: "Reopened: the record changed after review",
  OVERDUE_REMINDER: "Overdue reminder sent",
};

const RESOLUTION_LABEL: Record<string, string> = { UPHELD: "Upheld", PARTIALLY_UPHELD: "Partially upheld", NOT_UPHELD: "Not upheld" };
const ROLES_FOR_QUEUES = ["Admin", "Underwriter", "ClaimsManager"];

type Form = { action: Action; text: string; resolution: string; targetUser: string; targetRole: string };

const ACTION_COPY: Record<Action, { label: string; needs?: "reason" | "message" | "response" | "target" | "optional"; danger?: boolean; hint?: string }> = {
  edit_draft: { label: "Edit proposal" },
  submit: { label: "Submit" },
  resubmit: { label: "Resubmit", needs: "response", hint: "Tell the reviewer what you changed or answer their question." },
  start_review: { label: "Start review" },
  release: { label: "Return to team queue", needs: "optional" },
  request_information: { label: "Ask for more information", needs: "message", hint: "The requester sees this message." },
  approve: { label: "Approve", needs: "reason", hint: "The requester sees your reason." },
  reject: { label: "Reject", needs: "reason", danger: true, hint: "The requester sees your reason (at least 10 characters)." },
  cancel: { label: "Cancel request", needs: "reason", danger: true },
  reassign: { label: "Reassign", needs: "target", hint: "The reason stays between reviewers and administrators." },
  retry_execution: { label: "Retry applying the change", needs: "optional" },
  reopen_for_review: { label: "Reopen for review", needs: "reason", hint: "The record changed after it was reviewed. The requester is asked to confirm against the current record." },
};
const IDEMPOTENT: Action[] = ["submit", "resubmit", "approve", "reject", "retry_execution"];
const ENDPOINT: Partial<Record<Action, string>> = {
  start_review: "start-review", request_information: "request-information", retry_execution: "retry-execution", reopen_for_review: "reopen-for-review",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-0.5 text-sm text-slate-800">{children}</div>
    </div>
  );
}

function Proposal({ req }: { req: RequestDetail }) {
  const rev = req.reviewed_revision ?? req.current_revision;
  if (!rev) return null;
  const p = rev.payload ?? {};
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-900">{tx("Proposal")}</h2>
        <span className="text-[11px] text-slate-500">
          {req.reviewed_revision ? tx("Revision {n}, as submitted for review", { n: rev.revision_no }) : tx("Revision {n} (draft, not submitted)", { n: rev.revision_no })}
        </span>
      </div>
      {req.viewer.is_requester && req.current_revision && req.reviewed_revision && req.current_revision.revision_no !== req.reviewed_revision.revision_no && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{tx("You have unsent changes in revision {n}. Resubmit to send them for review.", { n: req.current_revision.revision_no })}</p>
      )}
      {req.request_type === "customer_profile_correction" && req.changes ? (
        <>
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr><th className="py-1.5 text-start">{tx("Field")}</th><th className="py-1.5 text-start">{tx("Before")}</th><th className="py-1.5 text-start">{tx("After")}</th></tr>
            </thead>
            <tbody>
              {req.changes.map((c) => (
                <tr key={c.field} className="border-t border-slate-100">
                  <td className="py-2 font-medium text-slate-700">{tx(c.label)}</td>
                  <td className="py-2 text-slate-500 line-through decoration-slate-300">{c.before ?? "—"}</td>
                  <td className="py-2 font-semibold text-emerald-700">{c.after ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!req.reviewed_revision && <p className="mt-2 text-[11px] text-slate-500">{tx("“Before” values are captured from the customer record when the request is submitted.")}</p>}
          <p className="mt-3 text-sm text-slate-700"><span className="font-semibold">{tx("Reason:")}</span> {p.reason}</p>
        </>
      ) : req.request_type === "commission_dispute" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tx("Dispute")}>{tx(DISPUTE_LABEL[p.dispute_kind] ?? p.dispute_kind)}</Field>
          <Field label={tx("Amount expected")}>{p.claimed_amount ? `PKR ${p.claimed_amount}` : "—"}</Field>
          <Field label={tx("Recorded earning")}>{rev.subject_snapshot?.gross_amount ? `PKR ${rev.subject_snapshot.gross_amount} · ${rev.subject_snapshot.rate_pct}%` : "—"}</Field>
          <div className="sm:col-span-3"><Field label={tx("Explanation")}><p className="whitespace-pre-wrap">{p.explanation}</p></Field></div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label={tx("Category")}>{tx(CATEGORY_LABEL[p.category] ?? p.category)}</Field>
          <Field label={tx("Description")}><p className="whitespace-pre-wrap">{p.description}</p></Field>
          {p.desired_outcome && <Field label={tx("Desired outcome")}><p className="whitespace-pre-wrap">{p.desired_outcome}</p></Field>}
        </div>
      )}
    </Card>
  );
}

/** Where the request is in its life, at a glance. */
function Progress({ req }: { req: RequestDetail }) {
  const s = req.review_status;
  const decided = s === "APPROVED" || s === "REJECTED";
  const steps: { label: string; state: "done" | "current" | "todo" | "warn" | "bad"; note?: string }[] = [
    { label: tx("Draft"), state: s === "DRAFT" ? "current" : "done" },
    { label: tx("Submitted"), state: s === "DRAFT" ? "todo" : s === "SUBMITTED" ? "current" : "done",
      note: s === "SUBMITTED" ? (req.assignee_name ? tx("Waiting for {name}", { name: req.assignee_name }) : req.queue_role ? tx("Waiting in the {role} queue", { role: req.queue_role }) : undefined) : undefined },
    { label: tx("In review"), state: s === "IN_REVIEW" ? "current" : s === "NEEDS_INFORMATION" ? "warn" : decided ? "done" : "todo",
      note: s === "NEEDS_INFORMATION" ? tx("Waiting for the requester") : s === "IN_REVIEW" && req.assignee_name ? req.assignee_name : undefined },
    { label: s === "REJECTED" ? tx("Rejected") : tx("Approved"), state: s === "APPROVED" ? "done" : s === "REJECTED" ? "bad" : "todo" },
  ];
  if (req.type.executes) {
    const e = req.execution_status;
    steps.push({ label: tx("Applied"), state: e === "SUCCEEDED" ? "done" : e === "FAILED" ? "bad" : e === "PENDING" || e === "RUNNING" ? "current" : "todo",
      note: e === "FAILED" ? tx("Couldn't apply") : e === "PENDING" || e === "RUNNING" ? tx("In progress") : undefined });
  }
  if (s === "CANCELLED") {
    return <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">{tx("This request was cancelled by the requester.")}</p>;
  }
  const dot = { done: "bg-emerald-500 text-white", current: "bg-blue-600 text-white ring-4 ring-blue-100", todo: "bg-slate-200 text-slate-500", warn: "bg-amber-500 text-white ring-4 ring-amber-100", bad: "bg-red-500 text-white" };
  const line = { done: "bg-emerald-400", current: "bg-slate-200", todo: "bg-slate-200", warn: "bg-slate-200", bad: "bg-slate-200" };
  return (
    <ol className="flex items-start" aria-label={tx("Request progress")}>
      {steps.map((step, i) => (
        <li key={step.label} className="flex flex-1 items-start last:flex-none">
          <div className="flex w-28 flex-col items-center text-center">
            <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${dot[step.state]}`}>
              {step.state === "done" ? "✓" : step.state === "bad" ? "!" : i + 1}
            </span>
            <span className={`mt-1.5 text-xs font-semibold ${step.state === "todo" ? "text-slate-400" : "text-slate-800"}`}>{step.label}</span>
            {step.note && <span className="mt-0.5 text-[10px] leading-tight text-slate-500">{step.note}</span>}
          </div>
          {i < steps.length - 1 && <span className={`mt-3.5 h-0.5 flex-1 rounded ${line[step.state]}`} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export default function RequestDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const { refresh: refreshSummary } = useSummary();
  const [req, setReq] = useState<RequestDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [comment, setComment] = useState("");
  const [commentInternal, setCommentInternal] = useState(false);
  const [uploadInternal, setUploadInternal] = useState(false);
  const [sideError, setSideError] = useState<string | null>(null);
  const actionKey = useRef<string>(newKey());

  const current = useRef<RequestDetail | null>(null);
  current.current = req;
  const [liveNote, setLiveNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([requestsApi.get(id), requestsApi.timeline(id)]);
      setReq(d); setTimeline(t); setLoadError(null);
    } catch (e) {
      const err = e as RequestsError;
      // Watching it from the team queue and it vanished: a teammate picked it up.
      const claimed = err.status === 404 && !!current.current?.viewer.in_queue;
      setLoadError({ message: claimed ? tx("Someone in your team picked this request up.") : err.message ?? tx("Couldn't load the request."),
                     notFound: err.status === 404 && !claimed });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Live: reload when this request changes elsewhere (another reviewer, the executor), and say so.
  useRequestEvents((e) => {
    const shown = current.current;
    if (e.type === "resync" || (e.type === "queue" && shown?.viewer.in_queue)) { load(); return; }
    if (e.type !== "request" || e.request_id !== id || (shown && e.version <= shown.version)) return;
    load();
    if (shown && !busy && (e.review_status !== shown.review_status || e.execution_status !== shown.execution_status)) {
      setLiveNote(tx("This request was just updated."));
    }
  });

  useEffect(() => {
    if (form?.action !== "reassign" || !req) return;
    requestsApi.reviewers(req.request_type, req.requester_id).then(setReviewers).catch(() => setReviewers([]));
  }, [form?.action, req]);

  const open = (action: Action) => {
    setActionError(null);
    actionKey.current = newKey();
    setForm({ action, text: "", resolution: "", targetUser: "", targetRole: "" });
  };

  const run = async () => {
    if (!req || !form) return;
    const { action } = form;
    const body: Record<string, any> = { expected_version: req.version };
    const needs = ACTION_COPY[action].needs;
    if (needs === "reason" || needs === "optional") body.reason = form.text.trim() || undefined;
    if (needs === "message") body.message = form.text.trim();
    if (needs === "response") body.response = form.text.trim();
    if (action === "approve" || action === "reject" || action === "request_information") body.revision_no = req.submitted_revision_no;
    if (form.resolution) body.resolution = form.resolution;
    if (action === "reassign") {
      if (form.targetUser) body.target_user_id = form.targetUser; else if (form.targetRole) body.target_role = form.targetRole;
    }
    setBusy(true); setActionError(null);
    try {
      const updated = await requestsApi.action(id, ENDPOINT[action] ?? action, body, IDEMPOTENT.includes(action) ? actionKey.current : undefined);
      setReq(updated);
      setForm(null);
      setTimeline(await requestsApi.timeline(id).catch(() => timeline));
      refreshSummary();
    } catch (e) {
      const err = e as RequestsError;
      if (err.code === "STALE_VERSION" || err.code === "STALE_REVISION") {
        setActionError(`${err.message}`);
        await load();
      } else {
        const fields = err.fieldErrors?.() ?? {};
        setActionError(Object.values(fields)[0] ?? err.message ?? tx("Something went wrong."));
      }
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setSideError(null);
    try {
      setReq(await requestsApi.comment(id, comment.trim(), commentInternal ? "INTERNAL" : "REQUESTER"));
      setComment("");
      setTimeline(await requestsApi.timeline(id));
    } catch (e) {
      setSideError((e as RequestsError).message);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setSideError(null);
    try {
      setReq(await requestsApi.upload(id, file, uploadInternal ? "INTERNAL" : "REQUESTER"));
    } catch (e) {
      setSideError((e as RequestsError).message);
    }
  };

  const download = async (attachmentId: string, name: string) => {
    try {
      const blob = await requestsApi.attachmentBlob(id, attachmentId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setSideError((e as RequestsError).message);
    }
  };

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        {loadError.notFound
          ? <Empty title={tx("This request doesn't exist or you don't have access to it.")} action={<Link href="/requests" className="text-xs font-semibold text-blue-600">{tx("Back to my requests")}</Link>} />
          : <ErrorNote message={loadError.message} onRetry={load} />}
      </div>
    );
  }
  if (!req) return <Spinner />;

  const actions = req.allowed_actions.filter((a) => a !== "edit_draft");
  const resolutions = form?.action === "approve" ? req.type.approve_resolutions : form?.action === "reject" ? req.type.reject_resolutions : [];
  const copy = form ? ACTION_COPY[form.action] : null;
  const canRun = !!form && !busy && (
    (copy?.needs === "reason" && (form.text.trim().length >= (form.action === "reject" || form.action === "reopen_for_review" ? 10 : form.action === "cancel" && req.review_status !== "DRAFT" ? 5 : form.action === "cancel" ? 0 : 3)))
    || (copy?.needs === "message" && form.text.trim().length >= 10)
    || (copy?.needs === "response" && form.text.trim().length >= 3)
    || (copy?.needs === "target" && form.text.trim().length >= 5 && !!(form.targetUser || form.targetRole))
    || copy?.needs === "optional" || copy?.needs === undefined
  ) && (resolutions.length === 0 || !!form.resolution);

  return (
    <div className="mx-auto w-full max-w-screen-xl space-y-5 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={req.viewer.is_requester ? "/requests" : "/requests/review"} className="text-xs text-slate-500 hover:text-blue-700">{tx("← Back")}</Link>
          <h1 className="mt-1 text-xl font-bold text-slate-900">{req.title}</h1>
          <p className="mt-1 text-xs text-slate-500">{req.reference_no} · {tx(TYPE_LABEL[req.request_type] ?? req.type.label)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ReviewBadge status={req.review_status} />
            <ExecutionBadge status={req.execution_status} />
            <PriorityText priority={req.priority} />
            {req.overdue && <span className="text-xs font-semibold text-red-700">{tx("Overdue")}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {req.allowed_actions.includes("edit_draft") && (
            <Link href={`/requests/${id}/edit`} className={secondaryButton}>{tx("Edit proposal")}</Link>
          )}
          {actions.map((a) => (
            <button key={a} type="button" onClick={() => open(a)}
              className={a === "approve" || a === "submit" || a === "resubmit" || a === "start_review" ? primaryButton : ACTION_COPY[a].danger ? dangerButton : secondaryButton}>
              {tx(ACTION_COPY[a].label)}
            </button>
          ))}
        </div>
      </div>

      {liveNote && (
        <div role="status" className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-800">
          <span>{liveNote}</span>
          <button type="button" className="font-semibold" onClick={() => setLiveNote(null)}>{tx("Dismiss")}</button>
        </div>
      )}

      <Card className="overflow-x-auto px-5 py-4"><Progress req={req} /></Card>

      {form && copy && (
        <Card className="space-y-3 border-blue-200 p-5">
          <h2 className="text-sm font-bold text-slate-900">{tx(copy.label)}</h2>
          {copy.hint && <p className="text-xs text-slate-500">{tx(copy.hint)}</p>}
          {(form.action === "approve" || form.action === "reject") && (
            <p className="text-xs text-slate-600">{tx("You are deciding revision {n}.", { n: req.submitted_revision_no ?? "—" })}</p>
          )}
          {resolutions.length > 0 && (
            <div>
              <label className={labelClass} htmlFor="resolution">{tx("Resolution")}</label>
              <select id="resolution" className={inputClass} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })}>
                <option value="">{tx("Choose…")}</option>
                {resolutions.map((r) => <option key={r} value={r}>{tx(RESOLUTION_LABEL[r] ?? r)}</option>)}
              </select>
            </div>
          )}
          {form.action === "reassign" && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="target-user">{tx("To a reviewer")}</label>
                <select id="target-user" className={inputClass} value={form.targetUser} onChange={(e) => setForm({ ...form, targetUser: e.target.value, targetRole: "" })}>
                  <option value="">—</option>
                  {reviewers.map((r) => <option key={r.id} value={r.id}>{r.full_name} · {r.role_name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="target-role">{tx("Or to a team queue")}</label>
                <select id="target-role" className={inputClass} value={form.targetRole} onChange={(e) => setForm({ ...form, targetRole: e.target.value, targetUser: "" })}>
                  <option value="">—</option>
                  {ROLES_FOR_QUEUES.map((r) => <option key={r} value={r}>{tx("{role} queue", { role: r })}</option>)}
                </select>
              </div>
            </div>
          )}
          {copy.needs && (
            <textarea rows={3} className={inputClass} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })}
              placeholder={copy.needs === "optional" ? tx("Note (optional)") : copy.needs === "target" ? tx("Reason for reassigning") : tx("Write here…")}
              aria-label={tx("Reason")} />
          )}
          {actionError && <ErrorNote message={actionError} />}
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setForm(null)} disabled={busy}>{tx("Close")}</button>
            <button type="button" className={copy.danger ? dangerButton : primaryButton} onClick={run} disabled={!canRun}>{busy ? tx("Working…") : tx(copy.label)}</button>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Proposal req={req} />

          {(req.decision || req.closed_reason) && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-bold text-slate-900">{tx("Review outcome")}</h2>
              {req.decision ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2"><ReviewBadge status={req.decision.decision as any} />
                    {req.decision.resolution && <span className="text-xs font-semibold text-slate-700">{tx(RESOLUTION_LABEL[req.decision.resolution] ?? req.decision.resolution)}</span>}
                  </div>
                  <p className="text-sm text-slate-700">{req.decision.reason}</p>
                  <p className="text-[11px] text-slate-500">{tx("{name} · revision {n} · {date}", { name: req.decision.decided_by_name, n: req.decision.revision_no, date: formatDate(req.decision.created_at, true) })}</p>
                </div>
              ) : <p className="text-sm text-slate-700">{tx("Cancelled:")} {req.closed_reason || "—"}</p>}
            </Card>
          )}

          {req.execution && (
            <Card className="p-5">
              <h2 className="mb-1 text-sm font-bold text-slate-900">{tx("Applying the approved change")}</h2>
              <p className="mb-3 text-xs text-slate-500">{tx("Tracked separately from the review decision.")}</p>
              <div className="flex flex-wrap items-center gap-3">
                <ExecutionBadge status={req.execution.status} />
                <span className="text-xs text-slate-500">{tx("Attempts: {n} of {max}", { n: req.execution.attempts, max: req.execution.max_attempts })}</span>
                {req.execution.next_attempt_at && <span className="text-xs text-slate-500">{tx("Next try: {date}", { date: formatDate(req.execution.next_attempt_at, true) })}</span>}
              </div>
              {req.execution.status === "FAILED" && (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                  {req.execution.last_error_code === "CONFLICT"
                    ? tx("The customer record changed after it was reviewed, so nothing was overwritten. The request needs a fresh review against the current record.")
                    : `${tx(EXECUTION_LABEL.FAILED)}: ${req.execution.last_error ?? req.execution.last_error_code}`}
                </p>
              )}
              {req.execution.attempt_log.length > 0 && (
                <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
                  {req.execution.attempt_log.map((a) => (
                    <li key={a.attempt_no}>{tx("Attempt {n}", { n: a.attempt_no })} · {formatDate(a.started_at, true)} · {a.outcome ?? tx("running")}{a.error_code ? ` (${a.error_code})` : ""}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-bold text-slate-900">{tx("Comments")}</h2>
            {req.comments.length === 0 ? <p className="text-xs text-slate-500">{tx("No comments yet.")}</p> : (
              <ul className="space-y-3">
                {req.comments.map((c) => (
                  <li key={c.id} className={`rounded-lg px-3 py-2 ${c.visibility === "INTERNAL" ? "border border-amber-200 bg-amber-50" : "bg-slate-50"}`}>
                    <p className="text-[11px] font-semibold text-slate-600">{c.author_name} · {formatDate(c.created_at, true)}{c.visibility === "INTERNAL" ? ` · ${tx("Internal note")}` : ""}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {req.review_status !== "DRAFT" || req.viewer.is_requester ? (
              <div className="mt-3 space-y-2">
                <textarea rows={2} className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={tx("Add a comment…")} aria-label={tx("Comment")} />
                <div className="flex items-center justify-between">
                  {req.viewer.sees_internal ? (
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={commentInternal} onChange={(e) => setCommentInternal(e.target.checked)} /> {tx("Internal note (hidden from the requester)")}
                    </label>
                  ) : <span />}
                  <button type="button" className={secondaryButton} onClick={addComment} disabled={!comment.trim()}>{tx("Post")}</button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="space-y-3 p-5">
            <Field label={tx("Requester")}>{req.requester_name} <span className="text-xs text-slate-500">· {req.requester_role}</span></Field>
            <Field label={tx("Responsible")}>{req.assignee_name ?? (req.queue_role ? tx("{role} queue", { role: req.queue_role }) : tx("Not routed yet"))}</Field>
            {req.subject_kind === "CUSTOMER" && req.subject_id && (
              <Field label={tx("Customer")}>
                <a href={appHref(`/admin/customers/${req.subject_id}/plans`)} className="text-blue-600 hover:underline">{req.subject_label ?? req.subject_id}</a>
              </Field>
            )}
            {req.subject_kind === "COMMISSION_EARNING" && <Field label={tx("Commission earning")}>{req.subject_label}</Field>}
            <Field label={tx("Submitted")}>{formatDate(req.submitted_at, true)}</Field>
            <Field label={tx("Due")}>{formatDate(req.due_at, true)}</Field>
            {req.routing?.rule_version && req.viewer.sees_internal && (
              <Field label={tx("Routed by")}>{tx("{target} (rule version {v})", { target: req.routing.target_label, v: req.routing.rule_version })}</Field>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-bold text-slate-900">{tx("Attachments")}</h2>
            {req.attachments.length === 0 ? <p className="text-xs text-slate-500">{tx("No attachments.")}</p> : (
              <ul className="space-y-2">
                {req.attachments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                    <button type="button" onClick={() => download(a.id, a.file_name)} className="truncate text-start text-blue-600 hover:underline">{a.file_name}</button>
                    <span className="shrink-0 text-[10px] text-slate-500">{Math.ceil(a.size_bytes / 1024)} KB{a.visibility === "INTERNAL" ? ` · ${tx("Internal")}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
            {req.review_status !== "CANCELLED" && (req.review_status !== "DRAFT" || req.viewer.is_requester) && (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-semibold text-slate-600">
                  {tx("Attach a PDF, PNG or JPEG (up to 10 MB)")}
                  <input type="file" accept="application/pdf,image/png,image/jpeg" className="mt-1.5 block w-full text-xs text-slate-500 file:me-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
                    onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
                </label>
                {req.viewer.sees_internal && (
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={uploadInternal} onChange={(e) => setUploadInternal(e.target.checked)} /> {tx("Internal (hidden from the requester)")}
                  </label>
                )}
              </div>
            )}
          </Card>
          {sideError && <ErrorNote message={sideError} />}

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-bold text-slate-900">{tx("Timeline")}</h2>
            <ol className="space-y-3 border-s border-slate-200 ps-4">
              {timeline.map((e, i) => (
                <li key={i} className="relative">
                  <span className="absolute -start-[21px] top-1 h-2.5 w-2.5 rounded-full bg-blue-500" />
                  <p className="text-xs font-semibold text-slate-800">{tx(EVENT_LABEL[e.event_type] ?? e.event_type)}</p>
                  <p className="text-[11px] text-slate-500">{e.actor_name} · {formatDate(e.created_at, true)}{e.revision_no ? ` · ${tx("revision {n}", { n: e.revision_no })}` : ""}</p>
                  {e.reason && <p className="mt-0.5 text-[11px] text-slate-600">{e.reason}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
