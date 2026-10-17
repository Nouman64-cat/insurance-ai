import { NextRequest } from "next/server";

// Server-side proxy to the API gateway's GET /events/stream: live case events for the signed-in user's tenant, read
// by the shared lib/agent/useCaseEvents.ts. Same as the portal's route of the same path. The browser's abort signal
// is passed upstream, so closing the tab releases the gateway's subscription.
const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let upstream: Response;
  try {
    upstream = await fetch(`${API_GATEWAY_INTERNAL_URL}/events/stream`, {
      headers: {
        Authorization: req.headers.get("authorization") || "",
        "X-Tenant-Id": req.headers.get("x-tenant-id") || "",
      },
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    // The hook retries with backoff.
    return new Response("Event stream unavailable", { status: 503 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
