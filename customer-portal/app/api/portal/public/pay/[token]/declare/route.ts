import { NextRequest, NextResponse } from "next/server";
import { callUpstream, csrfOk, forbidden } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// "I have paid", without a receipt. Same credential as the rest of the link: the token in the URL.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!csrfOk(req)) return forbidden();
  const up = await callUpstream(req, `/v1/walk-in/pay/${encodeURIComponent(params.token)}/declare`, { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } });
  return new NextResponse(await up.text(), { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
