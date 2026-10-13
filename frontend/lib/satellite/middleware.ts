import { NextRequest, NextResponse } from "next/server";

// The sign-in check for apps that sign in through the portal (the Underwriting Workbench, Request Management), run as
// each app's Next.js middleware before any page renders. Without the portal's single sign-on cookie the user is sent
// to the portal's login and brought back to the exact URL afterwards, so a deep link opened in a new tab lands where
// it should. With it, components/satellite/SsoGate.tsx still verifies the token with the gateway before rendering:
// the cookie being present is not trusted on its own.
const COOKIE_NAME = process.env.SSO_COOKIE_NAME || "insurance_sso";
const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000").replace(/\/+$/, "");

// If the portal keeps sending the user back without a cookie we can read (SSO_COOKIE_DOMAIN not matching the hosts,
// cookies blocked), stop after a few rounds and explain (/sso-problem) instead of bouncing between the apps forever.
const BOUNCE_LIMIT = 3;

/** The URL the browser asked for, as the browser sees it (behind Docker port mapping or an HTTPS proxy). */
function requestedUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

/** `bounceCookie` is per app, so one app's sign-in trouble doesn't count against another. */
export function requirePortalSession(req: NextRequest, bounceCookie: string): NextResponse {
  if (req.cookies.get(COOKIE_NAME)?.value) {
    const res = NextResponse.next();
    if (req.cookies.get(bounceCookie)) res.cookies.set(bounceCookie, "", { path: "/", maxAge: 0 });
    return res;
  }

  const bounces = Number(req.cookies.get(bounceCookie)?.value) || 0;
  if (bounces >= BOUNCE_LIMIT) {
    return NextResponse.rewrite(new URL("/sso-problem", req.url));
  }

  const login = new URL("/login", PORTAL_URL);
  login.searchParams.set("next", requestedUrl(req));
  const res = NextResponse.redirect(login);
  res.cookies.set(bounceCookie, String(bounces + 1), { path: "/", maxAge: 60, httpOnly: true, sameSite: "lax" });
  return res;
}
