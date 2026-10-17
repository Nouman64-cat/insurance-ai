"use client";

import { tx } from "@/lib/i18n/tx";
import { Badge, Priority, type PriorityCode, type Tone } from "@/components/satellite/ui";
import type { ExecutionStatus, ReviewStatus } from "@/lib/requestsApi";

// Request Management's labels and badges, on top of the shared building blocks (components/satellite/ui.tsx).
export {
  Card, CardHeader, Empty, ErrorNote, Pager, Spinner, SkeletonRows, Segmented, Dialog, Field, Avatar, DueLabel,
  dangerButton, formatDate, ghostButton, inputClass, labelClass, primaryButton, relativeTime, secondaryButton, useDebounced,
  PRIORITY_LABEL,
} from "@/components/satellite/ui";

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  IN_REVIEW: "In review",
  NEEDS_INFORMATION: "Needs information",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

const REVIEW_TONE: Record<ReviewStatus, Tone> = {
  DRAFT: "slate", SUBMITTED: "blue", IN_REVIEW: "indigo", NEEDS_INFORMATION: "amber",
  APPROVED: "emerald", REJECTED: "red", CANCELLED: "slate",
};

export const EXECUTION_LABEL: Record<ExecutionStatus, string> = {
  NOT_APPLICABLE: "No action to apply",
  PENDING: "Waiting to apply",
  RUNNING: "Applying",
  SUCCEEDED: "Applied",
  FAILED: "Couldn't apply",
};

const EXECUTION_TONE: Record<ExecutionStatus, Tone> = {
  NOT_APPLICABLE: "slate", PENDING: "sky", RUNNING: "sky", SUCCEEDED: "emerald", FAILED: "red",
};

export const TYPE_LABEL: Record<string, string> = {
  general: "General operational request",
  customer_profile_correction: "Customer profile correction",
  commission_dispute: "Commission dispute",
};

export const CATEGORY_LABEL: Record<string, string> = {
  ACCESS: "Access or permission", DATA_FIX: "Data fix", PROCESS_EXCEPTION: "Process exception", DOCUMENT: "Document", OTHER: "Other",
};

export const DISPUTE_LABEL: Record<string, string> = {
  AMOUNT: "Wrong amount", RATE: "Wrong rate", SPLIT: "Wrong split between producers", MISSING_RECEIPT: "Missing premium receipt", OTHER: "Other",
};

export const OPEN_STATUSES: ReviewStatus[] = ["SUBMITTED", "IN_REVIEW", "NEEDS_INFORMATION"];

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  return <Badge tone={REVIEW_TONE[status]}>{tx(REVIEW_LABEL[status])}</Badge>;
}

export function ExecutionBadge({ status }: { status: ExecutionStatus }) {
  if (status === "NOT_APPLICABLE") return null;
  return <Badge tone={EXECUTION_TONE[status]} dot={false}>{tx(EXECUTION_LABEL[status])}</Badge>;
}

export function PriorityText({ priority }: { priority: PriorityCode }) {
  return <Priority value={priority} />;
}

/** A small icon per request type, so lists can be scanned by type. */
export function TypeIcon({ type }: { type: string }) {
  const common = "h-4 w-4";
  const paths: Record<string, JSX.Element> = {
    general: <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z" />,
    customer_profile_correction: <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z" />,
    commission_dispute: <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  };
  const tone: Record<string, string> = {
    general: "bg-slate-100 text-slate-600", customer_profile_correction: "bg-blue-50 text-blue-600", commission_dispute: "bg-emerald-50 text-emerald-600",
  };
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone[type] ?? tone.general}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={common}>{paths[type] ?? paths.general}</svg>
    </span>
  );
}
