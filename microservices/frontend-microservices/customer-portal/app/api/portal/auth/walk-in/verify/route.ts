import { NextRequest, NextResponse } from "next/server";
import { callUpstream, csrfOk, forbidden, setWalkInSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// Turns the one-time-code check into a walk-in session cookie. The token never reaches page JavaScript.
export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const up = await callUpstream(req, "/v1/walk-in/otp/verify", { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } });
  let json: any = null;
  try { json = await up.json(); } catch { /* not JSON */ }
  if (!up.ok || !json?.access_token) {
    return NextResponse.json(json ?? { error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable.", details: {} } }, { status: up.ok ? 502 : up.status });
  }
  const { access_token, ...rest } = json;
  const res = NextResponse.json(rest);
  setWalkInSession(res, access_token);
  return res;
}
