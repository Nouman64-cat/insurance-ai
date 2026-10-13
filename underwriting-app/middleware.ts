import { NextRequest, NextResponse } from "next/server";

// Every workbench page needs the portal's single sign-on cookie. Without it the user is sent to the portal's login
// straight away (before any page code loads) and brought back to the exact URL afterwards, so a case link opened in a
// new tab lands on that case. With it, components/workbench/SsoGate.tsx still verifies the token with the gateway
// before rendering anything: the cookie being present is not trusted on its own.
const COOKIE_NAME = process.env.SSO_COOKIE_NAME || "insurance_sso";
const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000").replace(/\/+$/, "");

// If the portal keeps sending the user back without a cookie we can read (SSO_COOKIE_DOMAIN not matching the two
// hosts, cookies blocked), stop after a few rounds and explain instead of bouncing between the apps forever.
const BOUNCE_COOKIE = "uw_sso_bounces";
const BOUNCE_LIMIT = 3;

/** The URL the browser asked for, as the browser sees it (behind Docker port mapping or an HTTPS proxy). */
function requestedUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

export function middleware(req: NextRequest) {
  if (req.cookies.get(COOKIE_NAME)?.value) {
    const res = NextResponse.next();
    if (req.cookies.get(BOUNCE_COOKIE)) res.cookies.set(BOUNCE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  const bounces = Number(req.cookies.get(BOUNCE_COOKIE)?.value) || 0;
  if (bounces >= BOUNCE_LIMIT) {
    return NextResponse.rewrite(new URL("/sso-problem", req.url));
  }

  const login = new URL("/login", PORTAL_URL);
  login.searchParams.set("next", requestedUrl(req));
  const res = NextResponse.redirect(login);
  res.cookies.set(BOUNCE_COOKIE, String(bounces + 1), { path: "/", maxAge: 60, httpOnly: true, sameSite: "lax" });
  return res;
}

export const config = {
  // Pages only: not the API routes (they answer 401 themselves), Next's assets, or the static files in public/.
  matcher: ["/((?!api/|_next/|sso-problem|favicon\\.ico|rizvi\\.png).*)"],
};
