// Request Management API (services/request-management-service), reached through the API gateway at
// /request-management/v1. The signed-in user's token (stored by the SSO gate) is sent as a Bearer header; the
// service verifies it and decides everything about tenant, role and permissions itself.
import axios, { AxiosError } from "axios";
import { sessionExpired } from "@/lib/sso";

export const BASE = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8010").replace(/\/+$/, "")}/request-management/v1`;

export class RequestsError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, any> = {}) {
    super(message);
  }
  /** Field-level problems from a VALIDATION error, keyed by field name. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of (this.details?.fields as { field: string; message: string }[] | undefined) ?? []) out[f.field.replace(/^payload\./, "")] = f.message;
    if (this.details?.field) out[this.details.field] = this.message;
    return out;
  }
}

const http = axios.create({ baseURL: BASE, timeout: 60_000 });

http.interceptors.request.use((config) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("jwt_token") : null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (res) => res,
  (err: AxiosError<any>) => {
    const status = err.response?.status ?? 0;
    const body = err.response?.data?.error;
    if (status === 401) {
      sessionExpired();
    }
    if (!err.response) {
      return Promise.reject(new RequestsError(0, "NETWORK", "Can't reach Request Management. Check your connection and try again."));
    }
    return Promise.reject(new RequestsError(status, body?.code ?? `HTTP_${status}`, body?.message ?? "Something went wrong.", body?.details ?? {}));
  },
);

/** A fresh key per user action; reused if that action is retried, so the server acts once. */
export function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type ReviewStatus = "DRAFT" | "SUBMITTED" | "IN_REVIEW" | "NEEDS_INFORMATION" | "APPROVED" | "REJECTED" | "CANCELLED";
export type ExecutionStatus = "NOT_APPLICABLE" | "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type Action =
  | "edit_draft" | "submit" | "resubmit" | "start_review" | "release" | "request_information"
  | "approve" | "reject" | "cancel" | "reassign" | "retry_execution" | "reopen_for_review";

export interface RequestType {
  code: string;
  label: string;
  description: string;
  executes: boolean;
  can_submit: boolean;
  approve_resolutions: string[];
  reject_resolutions: string[];
  review_roles: string[];
  default_sla_hours: number;
  categories?: string[];
  fields?: { key: string; label: string }[];
  dispute_kinds?: string[];
}

export interface RequestRow {
  id: string;
  reference_no: string;
  request_type: string;
  title: string;
  priority: Priority;
  review_status: ReviewStatus;
  execution_status: ExecutionStatus;
  requester_name: string;
  assignee_name: string | null;
  queue_role: string | null;
  subject_label: string | null;
  branch_id: string | null;
  due_at: string | null;
  overdue: boolean;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Page<T> { items: T[]; total: number; page: number; page_size: number }

export interface Revision { revision_no: number; payload: any; subject_snapshot: any; frozen_at: string | null; created_at: string }

export interface RequestDetail extends RequestRow {
  requester_id: string;
  requester_role: string;
  assignee_user_id: string | null;
  subject_kind: "NONE" | "CUSTOMER" | "COMMISSION_EARNING" | "POLICY" | "CASE";
  subject_id: string | null;
  current_revision_no: number;
  submitted_revision_no: number | null;
  closed_reason: string | null;
  version: number;
  type: { code: string; label: string; executes: boolean; approve_resolutions: string[]; reject_resolutions: string[] };
  viewer: { is_requester: boolean; is_assignee: boolean; in_queue: boolean; is_admin: boolean; sees_internal: boolean };
  allowed_actions: Action[];
  reviewed_revision: Revision | null;
  current_revision: Revision | null;
  revisions: { revision_no: number; frozen_at: string | null; created_at: string }[];
  changes: { field: string; label: string; before: string | null; after: string | null }[] | null;
  decision: { revision_no: number; decision: string; reason: string; resolution: string | null; decided_by_name: string; created_at: string } | null;
  execution: {
    status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
    attempts: number;
    max_attempts: number;
    last_error_code: string | null;
    last_error: string | null;
    revision_no: number;
    updated_at: string;
    completed_at: string | null;
    next_attempt_at: string | null;
    result: any;
    attempt_log: { attempt_no: number; started_at: string; finished_at: string | null; outcome: string | null; error_code: string | null; error_message: string | null }[];
  } | null;
  routing: Record<string, any> | null;
  comments: { id: string; author_name: string; visibility: "REQUESTER" | "INTERNAL"; body: string; created_at: string }[];
  attachments: { id: string; file_name: string; content_type: string; size_bytes: number; visibility: "REQUESTER" | "INTERNAL"; uploaded_by_name: string; created_at: string }[];
}

export interface TimelineEvent {
  event_type: string;
  actor_name: string;
  actor_role: string | null;
  revision_no: number | null;
  from_review_status: string | null;
  to_review_status: string | null;
  from_execution_status: string | null;
  to_execution_status: string | null;
  reason: string | null;
  data: Record<string, any>;
  created_at: string;
}

export interface Summary {
  my_drafts: number; my_open: number; my_needs_information: number; assigned_to_me: number; queue_unclaimed: number;
  overdue_for_me: number; tenant_open?: number; tenant_overdue?: number; tenant_failed_executions?: number;
  unread_notifications: number; can_review: boolean; is_admin: boolean;
}

export interface Notification { id: string; request_id: string | null; kind: string; title: string; body: string; read_at: string | null; created_at: string }

export interface RoutingRule {
  id: string; request_type: string; branch_id: string | null; target_kind: "USER" | "ROLE"; target_user_id: string | null;
  target_role: string | null; target_label: string; sla_hours: number; description: string; is_active: boolean; version: number; updated_at: string;
}

export interface Reviewer { id: string; full_name: string; role_name: string; branch_id: string | null }

/** Where a new request of a type would go, and whom the requester may name (only people in that team). */
export interface RoutePreview {
  configured: boolean; target_kind?: "USER" | "ROLE"; target_label?: string; queue_role?: string | null; sla_hours?: number;
  reviewers: Pick<Reviewer, "id" | "full_name" | "role_name">[]; administrators?: string[];
}

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);
const idem = (key?: string) => (key ? { headers: { "Idempotency-Key": key } } : undefined);

export const requestsApi = {
  types: () => data<RequestType[]>(http.get("/request-types")),
  summary: () => data<Summary>(http.get("/summary")),
  list: (params: Record<string, string | number | undefined>) => data<Page<RequestRow>>(http.get("/requests", { params })),
  get: (id: string) => data<RequestDetail>(http.get(`/requests/${id}`)),
  timeline: (id: string) => data<TimelineEvent[]>(http.get(`/requests/${id}/timeline`)),
  create: (body: { request_type: string; title: string; priority: Priority; payload: any }, key?: string) =>
    data<RequestDetail>(http.post("/requests", body, idem(key))),
  updateDraft: (id: string, body: Record<string, any>) => data<RequestDetail>(http.put(`/requests/${id}/draft`, body)),
  action: (id: string, action: string, body: Record<string, any>, key?: string) =>
    data<RequestDetail>(http.post(`/requests/${id}/${action}`, body, idem(key))),
  comment: (id: string, body: string, visibility: "REQUESTER" | "INTERNAL") =>
    data<RequestDetail>(http.post(`/requests/${id}/comments`, { body, visibility })),
  upload: (id: string, file: File, visibility: "REQUESTER" | "INTERNAL") => {
    const form = new FormData();
    form.append("file", file);
    form.append("visibility", visibility);
    return data<RequestDetail>(http.post(`/requests/${id}/attachments`, form));
  },
  attachmentBlob: (id: string, attachmentId: string) =>
    http.get(`/requests/${id}/attachments/${attachmentId}/content`, { responseType: "blob" }).then((r) => r.data as Blob),
  notifications: () => data<{ items: Notification[]; unread: number }>(http.get("/notifications")),
  readNotification: (id: string) => data(http.post(`/notifications/${id}/read`, {})),
  readAll: () => data(http.post("/notifications/read-all", {})),
  rules: () => data<RoutingRule[]>(http.get("/routing-rules")),
  createRule: (body: Record<string, any>) => data<RoutingRule>(http.post("/routing-rules", body)),
  updateRule: (id: string, body: Record<string, any>) => data<RoutingRule>(http.put(`/routing-rules/${id}`, body)),
  deactivateRule: (id: string, reason: string) => data<RoutingRule>(http.post(`/routing-rules/${id}/deactivate`, { reason })),
  routePreview: (requestType: string) => data<RoutePreview>(http.get("/route-preview", { params: { request_type: requestType } })),
  reviewers: (requestType: string, excludeRequester?: string) =>
    data<Reviewer[]>(http.get("/reviewers", { params: { request_type: requestType, exclude_requester: excludeRequester } })),
};
