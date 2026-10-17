import { NextRequest } from "next/server";
import { AT, callUpstream, csrfOk, forbidden, relayAuth } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// Changing the password ends every other session and issues a fresh one, so the new tokens replace the cookies.
export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const token = req.cookies.get(AT)?.value;
  const up = await callUpstream(req, "/v1/auth/password/change", { method: "POST", token, body: await req.text(), headers: { "content-type": "application/json" } });
  return relayAuth(up);
}
