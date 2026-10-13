import { NextRequest, NextResponse } from "next/server";

// Routing only. A page is shown when a session cookie exists; the real check is Customer Management verifying the token
// on every data call, so a forged cookie opens an empty shell that cannot load anything.
const PUBLIC = ["/login"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const scope = req.cookies.get("cp_scope")?.value;
  const isPublic = PUBLIC.includes(pathname);

  if (!scope) {
    if (isPublic) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  if (scope === "pwd_change" && pathname !== "/first-login") {
    const url = req.nextUrl.clone();
    url.pathname = "/first-login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (scope === "full" && (isPublic || pathname === "/first-login")) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };
