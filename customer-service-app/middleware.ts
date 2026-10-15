import { NextResponse, type NextRequest } from "next/server";
import { requirePortalSession } from "@/lib/satellite/middleware";
// The open desk has no sign-in, so there is no session to require; every other deployment requires the portal's.
export function middleware(req: NextRequest) { return process.env.NEXT_PUBLIC_OPEN_DESK === "true" ? NextResponse.next() : requirePortalSession(req, "cs_sso_bounces"); }
export const config = { matcher: ["/((?!api/|_next/|sso-problem|favicon\\.ico).*)"] };
