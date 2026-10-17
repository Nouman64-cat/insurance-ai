import { NextRequest } from "next/server";
import { AT, callUpstream, csrfOk, forbidden, relayAuth } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const token = req.cookies.get(AT)?.value;
  const up = await callUpstream(req, "/v1/auth/password/first-change", { method: "POST", token, body: await req.text(), headers: { "content-type": "application/json" } });
  return relayAuth(up);
}
