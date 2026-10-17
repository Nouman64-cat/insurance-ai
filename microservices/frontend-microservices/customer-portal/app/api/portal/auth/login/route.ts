import { NextRequest } from "next/server";
import { callUpstream, csrfOk, forbidden, relayAuth } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const body = await req.text();
  const up = await callUpstream(req, "/v1/auth/login", { method: "POST", body, headers: { "content-type": "application/json" } });
  return relayAuth(up);
}
