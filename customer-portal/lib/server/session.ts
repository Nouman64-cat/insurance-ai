// Server-only helpers for the backend-for-frontend (BFF) routes in app/api/portal. Tokens are held in httpOnly cookies that
// page JavaScript cannot read; nothing here is ever sent to the browser except as a Set-Cookie header.
import { NextRequest, NextResponse } from "next/server";

// Customer Management is reached through the API gateway (versioned route /customer-management/v1/...), server-to-server.
export const API_URL = (process.env.CM_API_URL || "http://api-gateway:8000/customer-management").replace(/\/$/, "");

export const AT = "cp_at";        // short-lived access token
export const RT = "cp_rt";        // refresh token — only ever sent to /api/portal/auth/*
export const SCOPE = "cp_scope";  // "full" | "pwd_change": lets the middleware route without decoding a token
const SESSION_SECONDS = 12 * 60 * 60;

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: "full" | "pwd_change";
}

const secure = () => process.env.COOKIE_SECURE === "true";
const base = { httpOnly: true, sameSite: "lax" as const, secure: secure() };

export function setSession(res: NextResponse, t: Tokens): void {
  // The cookie outlives the JWT on purpose: an expired JWT is answered with 401 and the browser then renews it from the
  // refresh token; the session itself ends by CM's idle / absolute limits.
  const maxAge = t.scope === "pwd_change" ? 30 * 60 : SESSION_SECONDS;
  res.cookies.set(AT, t.access_token, { ...base, path: "/", maxAge });
  res.cookies.set(RT, t.refresh_token, { ...base, path: "/api/portal/auth", maxAge });
  res.cookies.set(SCOPE, t.scope, { ...base, path: "/", maxAge });
}

export function clearSession(res: NextResponse): void {
  for (const [name, path] of [[AT, "/"], [RT, "/api/portal/auth"], [SCOPE, "/"]] as const) {
    res.cookies.set(name, "", { ...base, path, maxAge: 0 });
  }
}

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "").trim() || "unknown";
}

/** CSRF defence for state-changing calls on top of SameSite=Lax cookies: a custom header a cross-site form cannot set,
 *  and an Origin that matches this site when the browser sends one. */
export function csrfOk(req: NextRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers.get("x-requested-with") !== "customer-portal") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function forbidden(): NextResponse {
  return NextResponse.json({ error: { code: "FORBIDDEN", message: "Request rejected", details: {} } }, { status: 403 });
}

export async function callUpstream(req: NextRequest, path: string, init: { method?: string; token?: string; body?: BodyInit | null; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "x-client-ip": clientIp(req),
    "x-client-user-agent": req.headers.get("user-agent") || "",
    ...(init.headers || {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  try {
    return await fetch(`${API_URL}${path}`, { method: init.method || "GET", headers, body: init.body ?? undefined, cache: "no-store" });
  } catch {
    return new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable. Please try again shortly.", details: {} } }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}

/** Relay an upstream JSON answer; on success, optionally turn its tokens into cookies and strip them from the body. */
export async function relayAuth(upstream: Response, opts: { setCookies?: boolean } = {}): Promise<NextResponse> {
  const text = await upstream.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!upstream.ok || !json) {
    const res = NextResponse.json(json ?? { error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable.", details: {} } }, { status: upstream.ok ? 502 : upstream.status });
    const retry = upstream.headers.get("retry-after");
    if (retry) res.headers.set("retry-after", retry);
    return res;
  }
  const { access_token, refresh_token, expires_in, scope, session_id: _s, ...rest } = json;
  const res = NextResponse.json(rest);
  if (opts.setCookies !== false && access_token) setSession(res, { access_token, refresh_token, expires_in, scope });
  return res;
}
