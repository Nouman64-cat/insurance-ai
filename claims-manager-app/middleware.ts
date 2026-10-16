import type { NextRequest } from "next/server";
import { requirePortalSession } from "@/lib/satellite/middleware";

// Every page needs the portal's sign-in; see lib/satellite/middleware.ts.
export function middleware(req: NextRequest) {
  return requirePortalSession(req, "cm_sso_bounces");
}

export const config = {
  matcher: ["/((?!api/|_next/|sso-problem|favicon\\.ico).*)"],
};
