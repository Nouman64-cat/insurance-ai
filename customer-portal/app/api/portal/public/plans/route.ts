import { NextRequest, NextResponse } from "next/server";
import { callUpstream } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// The catalogue of active plans (no pricing) is public: choosing a plan never requires an account.
export async function GET(req: NextRequest) {
  const up = await callUpstream(req, "/v1/walk-in/plans");
  return new NextResponse(await up.text(), { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
