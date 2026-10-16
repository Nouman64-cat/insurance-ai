import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness for the Docker health check. Deliberately does not call the gateway.
export function GET() {
  return NextResponse.json({ status: "ok", app: "claims-manager" }, { headers: { "Cache-Control": "no-store" } });
}
