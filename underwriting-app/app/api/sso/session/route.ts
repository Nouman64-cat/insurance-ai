import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// The signed-in user, from the single sign-on cookie the portal set (see the portal's app/api/sso/session). The token
// is checked with the API gateway's /auth/me on every call, so an expired or revoked token is never handed to the
// page, and who the user is (tenant, role, branch) comes from the gateway, not from anything the browser says.
// 401 means "send them to the portal to sign in".
const COOKIE_NAME = process.env.SSO_COOKIE_NAME || "insurance_sso";
const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";

function clearCookie(res: NextResponse) {
  // Same attributes the portal set it with, or the browser keeps it.
  res.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0, domain: process.env.SSO_COOKIE_DOMAIN || undefined });
  return res;
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ detail: "Not signed in" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  let me: Response;
  try {
    me = await fetch(`${API_GATEWAY_INTERNAL_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json({ detail: "Sign-in service unreachable" }, { status: 503 });
  }
  if (me.status === 401 || me.status === 403) {
    return clearCookie(NextResponse.json({ detail: "Session expired" }, { status: 401 }));
  }
  if (!me.ok) return NextResponse.json({ detail: "Sign-in service error" }, { status: 502 });
  return NextResponse.json({ token, user: await me.json() }, { headers: { "Cache-Control": "no-store" } });
}

// Signing out here signs out of the portal and the Automation Chat as well: they share the one cookie.
export async function DELETE() {
  return clearCookie(NextResponse.json({ ok: true }));
}
