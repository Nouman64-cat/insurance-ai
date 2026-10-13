"use client";

import { useEffect, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import type { ExecutionStatus, Priority, ReviewStatus } from "@/lib/requestsApi";

// Small building blocks for the Request Management screens, in the portal's design language.

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  IN_REVIEW: "In review",
  NEEDS_INFORMATION: "Needs information",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

const REVIEW_STYLE: Record<ReviewStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-600 border-slate-200",
  SUBMITTED: "bg-blue-50 text-blue-700 border-blue-200",
  IN_REVIEW: "bg-indigo-50 text-indigo-700 border-indigo-200",
  NEEDS_INFORMATION: "bg-amber-50 text-amber-800 border-amber-200",
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  REJECTED: "bg-red-50 text-red-700 border-red-200",
  CANCELLED: "bg-slate-100 text-slate-500 border-slate-200",
};

export const EXECUTION_LABEL: Record<ExecutionStatus, string> = {
  NOT_APPLICABLE: "No action to apply",
  PENDING: "Waiting to apply",
  RUNNING: "Applying",
  SUCCEEDED: "Applied",
  FAILED: "Couldn't apply",
};

const EXECUTION_STYLE: Record<ExecutionStatus, string> = {
  NOT_APPLICABLE: "bg-white text-slate-400 border-slate-200",
  PENDING: "bg-sky-50 text-sky-700 border-sky-200",
  RUNNING: "bg-sky-50 text-sky-700 border-sky-200",
  SUCCEEDED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
};

export const PRIORITY_LABEL: Record<Priority, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };
const PRIORITY_STYLE: Record<Priority, string> = {
  LOW: "text-slate-500",
  NORMAL: "text-slate-700",
  HIGH: "text-amber-700",
  URGENT: "text-red-700 font-bold",
};

export const TYPE_LABEL: Record<string, string> = {
  general: "General operational request",
  customer_profile_correction: "Customer profile correction",
  commission_dispute: "Commission dispute",
};

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REVIEW_STYLE[status]}`}>
      {tx(REVIEW_LABEL[status])}
    </span>
  );
}

export function ExecutionBadge({ status }: { status: ExecutionStatus }) {
  if (status === "NOT_APPLICABLE") return null;
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${EXECUTION_STYLE[status]}`}>
      {tx(EXECUTION_LABEL[status])}
    </span>
  );
}

export function PriorityText({ priority }: { priority: Priority }) {
  return <span className={`text-xs ${PRIORITY_STYLE[priority]}`}>{tx(PRIORITY_LABEL[priority])}</span>;
}

export function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString(undefined, withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" });
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white shadow-card ${className}`}>{children}</section>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
      {label ?? tx("Loading…")}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 text-xs font-semibold text-red-700 underline">
          {tx("Try again")}
        </button>
      )}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {hint && <p className="max-w-md text-xs text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}

export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
      <span>{tx("Page {page} of {total}", { page, total: pages })}</span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="rounded-lg border border-slate-200 px-3 py-1 font-semibold text-slate-700 disabled:opacity-40">{tx("Previous")}</button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}
          className="rounded-lg border border-slate-200 px-3 py-1 font-semibold text-slate-700 disabled:opacity-40">{tx("Next")}</button>
      </div>
    </div>
  );
}

export const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20";
export const labelClass = "mb-1 block text-xs font-semibold text-slate-600";
export const primaryButton = "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50";
export const secondaryButton = "rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
export const dangerButton = "rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50";
