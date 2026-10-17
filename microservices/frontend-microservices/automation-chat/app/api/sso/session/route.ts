import { NextRequest, NextResponse } from "next/server";
import { API_GATEWAY_INTERNAL_URL, SSO_COOKIE_NAME } from "@/lib/sso";

export const dynamic = "force-dynamic";

// The signed-in user, from the cookie the portal set. The token is checked with the API gateway every time, so a
// token that expired or was revoked is never handed to the page. 401 means "send them to the portal to sign in".
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SSO_COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ detail: "Not signed in" }, { status: 401 });

  let me: Response;
  try {
    me = await fetch(`${API_GATEWAY_INTERNAL_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  } catch {
    return NextResponse.json({ detail: "Sign-in service unreachable" }, { status: 503 });
  }
  if (!me.ok) {
    const res = NextResponse.json({ detail: "Session expired" }, { status: 401 });
    res.cookies.set(SSO_COOKIE_NAME, "", { path: "/", maxAge: 0, domain: process.env.SSO_COOKIE_DOMAIN || undefined });
    return res;
  }
  return NextResponse.json({ token, user: await me.json() }, { headers: { "Cache-Control": "no-store" } });
}

// Signing out here signs out of the portal as well, because they share the one cookie.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SSO_COOKIE_NAME, "", { path: "/", maxAge: 0, domain: process.env.SSO_COOKIE_DOMAIN || undefined });
  return res;
}
