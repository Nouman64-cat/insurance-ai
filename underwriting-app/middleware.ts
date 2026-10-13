import type { NextRequest } from "next/server";
import { requirePortalSession } from "@/lib/satellite/middleware";

// Every workbench page needs the portal's sign-in; see lib/satellite/middleware.ts.
export function middleware(req: NextRequest) {
  return requirePortalSession(req, "uw_sso_bounces");
}

export const config = {
  // Pages only: not the API routes (they answer 401 themselves), Next's assets, or the static files in public/.
  matcher: ["/((?!api/|_next/|sso-problem|favicon\\.ico|rizvi\\.png).*)"],
};
