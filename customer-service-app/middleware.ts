import type { NextRequest } from "next/server";
import { requirePortalSession } from "@/lib/satellite/middleware";
export function middleware(req: NextRequest){return requirePortalSession(req,"cs_sso_bounces");}
export const config={matcher:["/((?!api/|_next/|sso-problem|favicon\\.ico).*)"]};
