import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness for the Docker health check: the server is up and answering. Deliberately does not call the gateway, so
// a backend restart doesn't mark this container unhealthy.
export function GET() {
  return NextResponse.json({ status: "ok", app: "request-management" }, { headers: { "Cache-Control": "no-store" } });
}
