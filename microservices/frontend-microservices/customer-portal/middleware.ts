import { NextRequest, NextResponse } from "next/server";

// Routing only. A page is shown when a session cookie exists; the real check is Customer Management verifying the token
// on every data call, so a forged cookie opens an empty shell that cannot load anything.
//
// Three kinds of visitor: nobody (login / walk-in start only), a walk-in (confined to /walk-in/*), a customer (everything else).
const PUBLIC = ["/login", "/walk-in/start"];

function to(req: NextRequest, pathname: string, search = ""): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = search;
  return NextResponse.redirect(url);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const scope = req.cookies.get("cp_scope")?.value;
  const isPublic = PUBLIC.includes(pathname);
  const inWalkIn = pathname === "/walk-in" || pathname.startsWith("/walk-in/");
  // The emailed payment link opens for anyone who holds it, signed in or not: its token is the credential.
  if (pathname.startsWith("/walk-in/pay/")) return NextResponse.next();

  if (!scope) {
    if (isPublic) return NextResponse.next();
    if (inWalkIn) return to(req, "/walk-in/start");
    return to(req, "/login", pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`);
  }
  if (scope === "walk_in") {
    if (pathname === "/walk-in/start" || pathname === "/walk-in") return to(req, "/walk-in/apply");
    return inWalkIn ? NextResponse.next() : to(req, "/walk-in/apply");        // a walk-in can never open a customer page
  }
  if (inWalkIn && pathname !== "/walk-in/start") return to(req, scope === "full" ? "/dashboard" : "/first-login");
  if (scope === "pwd_change" && pathname !== "/first-login") return to(req, "/first-login");
  if (scope === "full" && (isPublic || pathname === "/first-login")) return to(req, "/dashboard");
  return NextResponse.next();
}

export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };
