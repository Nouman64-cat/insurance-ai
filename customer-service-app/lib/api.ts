// Customer Service API (services/customer-service), through the API gateway at /customer-service/v1. The signed-in
// user's token (stored by the SSO gate) is sent as a Bearer header; the service verifies it with /auth/me.
import axios, { AxiosError } from "axios";
import { sessionExpired } from "@/lib/sso";

export const api = axios.create({
  baseURL: `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8010").replace(/\/+$/, "")}/customer-service/v1`,
  timeout: 15_000,
});

api.interceptors.request.use((config) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("jwt_token") : null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** A readable message from FastAPI's error bodies: a string, or a list of field problems on validation errors. */
function message(err: AxiosError<any>): string {
  const detail = err.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map((d: any) => {
      const field = Array.isArray(d.loc) ? d.loc.filter((p: unknown) => p !== "body").join(" ") : "";
      return field ? `${field.replaceAll("_", " ")}: ${d.msg}` : d.msg;
    }).join(" · ");
  }
  if (!err.response) return "Can't reach Customer Service. Check your connection and try again.";
  return "Customer Service is unavailable. Try again.";
}

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError<any>) => {
    if (err.response?.status === 401) sessionExpired();
    const e = new Error(message(err)) as Error & { status?: number };
    e.status = err.response?.status;
    return Promise.reject(e);
  },
);

export type Status = "OPEN" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED" | "CANCELLED";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type Category = "GENERAL" | "POLICY_SERVICING" | "BILLING" | "CLAIM_ENQUIRY" | "COMPLAINT" | "DOCUMENTS";

export interface TicketEvent { id: number; actor_name: string; kind: string; body: string; internal: boolean; created_at: string }

export interface Ticket {
  id: string; title: string; description: string; status: Status; priority: Priority; category: Category; version: number;
  requester_id?: string; requester_name: string; assignee_id?: string | null; assignee_name: string | null; due_at: string;
  customer_id: string | null; policy_id: string | null; overdue?: boolean; resolution: string | null;
  created_at?: string; updated_at?: string; events?: TicketEvent[];
}

export interface Me { id: string; full_name: string | null; email: string; role_name: string; staff: boolean }

export type View = "" | "active" | "overdue" | "unassigned" | "mine" | "waiting" | "finished";
export interface Summary { active: number; overdue: number; unassigned: number; mine: number; waiting: number; finished: number; total: number }
