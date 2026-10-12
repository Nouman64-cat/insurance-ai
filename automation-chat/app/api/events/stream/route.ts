import { NextRequest } from "next/server";

// Server-side proxy to api-gateway's GET /events/stream — live case events
// (e.g. the customer submitting their e-application) for the signed-in user's
// tenant. Same internal-network reasoning as ../../chat/stream/route.ts. The
// browser's abort signal is passed upstream so closing the tab releases the
// gateway's subscription instead of leaving it open until the next heartbeat.
const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const upstream = await fetch(`${API_GATEWAY_INTERNAL_URL}/events/stream`, {
    headers: {
      Authorization: req.headers.get("authorization") || "",
      "X-Tenant-Id": req.headers.get("x-tenant-id") || "",
    },
    signal: req.signal,
    cache: "no-store",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
