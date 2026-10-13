import { NextRequest, NextResponse } from "next/server";
import { AT, callUpstream, clearSession, csrfOk, forbidden } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const token = req.cookies.get(AT)?.value;
  if (token) await callUpstream(req, "/v1/auth/logout", { method: "POST", token });   // revoke server-side; cookies go regardless
  const res = NextResponse.json({ ok: true });
  clearSession(res);
  return res;
}
