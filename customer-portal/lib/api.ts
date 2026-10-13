"use client";
// Browser-side client. It only ever calls this app's own /api/portal/* routes (the BFF); tokens are in httpOnly cookies and
// never visible here. A 401 triggers ONE shared refresh, then the request is repeated once.
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, any> = {}) {
    super(message);
  }
}

const HEADERS = { "x-requested-with": "customer-portal" };

async function parseError(res: Response): Promise<ApiError> {
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const e = body?.error;
  return new ApiError(res.status, e?.code || (res.status >= 500 ? "SERVICE_UNAVAILABLE" : "ERROR"), e?.message || "Something went wrong.", e?.details || {});
}

let refreshing: Promise<boolean> | null = null;

function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch("/api/portal/auth/refresh", { method: "POST", headers: HEADERS, cache: "no-store" });
        if (res.ok) return true;
        if (res.status === 409) { await new Promise((r) => setTimeout(r, 400)); continue; }   // another tab is renewing: retry
        return false;
      }
      return false;
    })().finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  }
  return refreshing;
}

function sessionOver(): never {
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login?expired=1";
  }
  throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended.");
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function send(path: string, o: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...HEADERS };
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.body); }
  if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
  return fetch(`/api/portal/v1/${path}`, { method: o.method || "GET", headers, body, cache: "no-store", signal: o.signal });
}

async function call(path: string, o: RequestOptions): Promise<Response> {
  let res = await send(path, o);
  if (res.status === 401) {
    const err = await parseError(res.clone());
    if (err.code === "SESSION_EXPIRED" || err.code === "UNAUTHENTICATED") {
      if (!(await refresh())) sessionOver();
      res = await send(path, o);
      if (res.status === 401) sessionOver();
    }
  }
  return res;
}

export async function api<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const res = await call(path, o);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await call(path, {});
  if (!res.ok) throw await parseError(res);
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*=utf-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Calls to the auth handlers (they manage cookies, so no refresh-and-retry here). */
export async function authPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/portal/auth/${path}`, {
    method: "POST", headers: { ...HEADERS, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export interface ApiState<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }

/** Loads `path` (skipped while null) and again on reload(). A stale answer never overwrites a newer one. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    const id = ++latest.current;
    setLoading(true);
    api<T>(path)
      .then((d) => { if (id === latest.current) { setData(d); setError(null); } })
      .catch((e) => { if (id === latest.current) setError(e instanceof ApiError ? e : new ApiError(0, "NETWORK", "Could not reach the server.")); })
      .finally(() => { if (id === latest.current) setLoading(false); });
  }, [path, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
