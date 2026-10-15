import { NextRequest } from "next/server";
import { AT, clientIp } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Live updates for the signed-in customer (Server-Sent Events). The browser cannot send an Authorization header on an EventSource, so
// this route reads the session cookie and opens the stream to Customer Management on the browser's behalf, passing the bytes through.
// It connects to Customer Management directly: the API gateway buffers whole responses, which would hold an event stream back.
const STREAM_URL = (process.env.CM_STREAM_URL || "http://customer-management:8009").replace(/\/$/, "");

export async function GET(req: NextRequest) {
  const token = req.cookies.get(AT)?.value;
  if (!token) return Response.json({ error: { code: "SESSION_EXPIRED", message: "Please sign in again.", details: {} } }, { status: 401 });
  let up: Response;
  try {
    up = await fetch(`${STREAM_URL}/v1/stream/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "x-client-ip": clientIp(req) }, cache: "no-store", signal: req.signal,
    });
  } catch {
    return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Live updates are unavailable.", details: {} } }, { status: 502 });
  }
  if (!up.ok || !up.body) return new Response(await up.text(), { status: up.status === 200 ? 502 : up.status, headers: { "content-type": "application/json" } });
  return new Response(up.body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" } });
}
