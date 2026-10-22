import { NextRequest, NextResponse } from "next/server";
import { callUpstream, csrfOk, forbidden } from "@/lib/server/session";

/** The browser's Idempotency-Key for this payment declaration, passed on untouched (the payment link is the credential). */
function keyHeader(req: NextRequest): Record<string, string> {
  const key = req.headers.get("idempotency-key");
  return key ? { "idempotency-key": key } : {};
}

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!csrfOk(req)) return forbidden();
  const type = req.headers.get("content-type") || "";
  if (!type.startsWith("multipart/form-data")) return NextResponse.json({ error: { code: "VALIDATION", message: "Upload a file", details: {} } }, { status: 422 });
  const up = await callUpstream(req, `/v1/walk-in/pay/${encodeURIComponent(params.token)}/proof`, { method: "POST", body: await req.arrayBuffer(), headers: { "content-type": type, ...keyHeader(req) } });
  return new NextResponse(await up.text(), { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
