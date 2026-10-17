import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Sets / clears the single-sign-on cookie that the Automation Chat app reads (see automation-chat/app/api/sso/session).
// The token is verified with the API gateway before it is trusted, so the cookie can only ever hold a real session.
const COOKIE_NAME = process.env.SSO_COOKIE_NAME || "insurance_sso";
const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";
const DEFAULT_MAX_AGE_S = 8 * 60 * 60;

function cookieDomain() {
  return process.env.SSO_COOKIE_DOMAIN || undefined;   // unset on localhost: host-only cookies already span ports
}

/** Seconds until the JWT expires, so the cookie never outlives the token. */
function secondsLeft(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (typeof payload.exp === "number") return Math.max(60, Math.floor(payload.exp - Date.now() / 1000));
  } catch { /* not a decodable JWT: use the default */ }
  return DEFAULT_MAX_AGE_S;
}

export async function POST(req: NextRequest) {
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!token) return NextResponse.json({ detail: "token required" }, { status: 400 });

  const me = await fetch(`${API_GATEWAY_INTERNAL_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  if (!me) return NextResponse.json({ detail: "Sign-in service unreachable" }, { status: 503 });
  if (!me.ok) return NextResponse.json({ detail: "Invalid token" }, { status: 401 });

  const secure = process.env.SSO_COOKIE_SECURE === "true" || req.headers.get("x-forwarded-proto") === "https";
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: secondsLeft(token),
    domain: cookieDomain(),
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0, domain: cookieDomain() });
  return res;
}
