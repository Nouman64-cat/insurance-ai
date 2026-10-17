import { NextRequest, NextResponse } from "next/server";
import { callUpstream } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// The secure payment link: the token in the URL is the only credential, and it reaches one payment.
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const up = await callUpstream(req, `/v1/walk-in/pay/${encodeURIComponent(params.token)}`);
  return new NextResponse(await up.text(), { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
