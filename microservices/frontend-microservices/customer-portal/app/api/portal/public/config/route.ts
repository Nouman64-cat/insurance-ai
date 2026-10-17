import { NextRequest, NextResponse } from "next/server";
import { callUpstream } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// Whether the walk-in sign-up is in demo mode (no verification code). Public: it reveals nothing but that.
export async function GET(req: NextRequest) {
  const up = await callUpstream(req, "/v1/walk-in/config");
  return new NextResponse(up.ok ? await up.text() : JSON.stringify({ demo: false }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
