import { NextRequest } from "next/server";

const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const upstream = await fetch(`${API_GATEWAY_INTERNAL_URL}/chat/resume`, {
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
