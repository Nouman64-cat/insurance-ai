import { NextRequest } from "next/server";

// Server-side proxy to api-gateway's /chat/stream — runs inside the frontend
// container, so it reaches api-gateway over the internal docker network
// (NEXT_PUBLIC_API_URL is a browser-facing host-port URL and isn't reachable
// from here). Forwards the browser's Authorization/X-Tenant-Id headers
// through unchanged and pipes the SSE body straight back.
const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const upstream = await fetch(`${API_GATEWAY_INTERNAL_URL}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("authorization") || "",
      "X-Tenant-Id": req.headers.get("x-tenant-id") || "",
    },
    body,
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
