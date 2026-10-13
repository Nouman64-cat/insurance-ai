import { NextRequest, NextResponse } from "next/server";
import { RT, callUpstream, clearSession, csrfOk, forbidden, relayAuth } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const rt = req.cookies.get(RT)?.value;
  if (!rt) {
    const res = NextResponse.json({ error: { code: "SESSION_EXPIRED", message: "Please sign in again.", details: {} } }, { status: 401 });
    clearSession(res);
    return res;
  }
  const up = await callUpstream(req, "/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token: rt }), headers: { "content-type": "application/json" } });
  const res = await relayAuth(up);
  if (up.status === 401) clearSession(res);   // a dead session: drop the cookies so the middleware sends the user to /login
  return res;
}
