import { NextRequest, NextResponse } from "next/server";
import { callUpstream, csrfOk, forbidden } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const up = await callUpstream(req, "/v1/walk-in/otp/request", { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } });
  const res = new NextResponse(await up.text(), { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const retry = up.headers.get("retry-after");
  if (retry) res.headers.set("retry-after", retry);
  return res;
}
