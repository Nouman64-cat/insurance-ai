import { NextRequest, NextResponse } from "next/server";
import { callUpstream, csrfOk, forbidden } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!csrfOk(req)) return forbidden();
  const type = req.headers.get("content-type") || "";
  if (!type.startsWith("multipart/form-data")) return NextResponse.json({ error: { code: "VALIDATION", message: "Upload a file", details: {} } }, { status: 422 });
  const up = await callUpstream(req, `/v1/walk-in/pay/${encodeURIComponent(params.token)}/proof`, { method: "POST", body: await req.arrayBuffer(), headers: { "content-type": type } });
  return new NextResponse(await up.text(), { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
