import { NextRequest, NextResponse } from "next/server";
import { AT, callUpstream, csrfOk, forbidden } from "@/lib/server/session";

export const dynamic = "force-dynamic";

// Only the customer-facing data routes are relayed. Auth has its own handlers (they manage cookies) and /internal is never
// reachable from here.
const ALLOWED = ["me", "dashboard", "policies", "payments", "claims", "documents", "profile", "notifications", "family", "walk-in"];
const FORWARD = ["content-type", "idempotency-key", "accept-language"];
const RETURN = ["content-type", "content-disposition", "retry-after"];

async function handle(req: NextRequest, { params }: { params: { path: string[] } }) {
  const path = params.path || [];
  if (!ALLOWED.includes(path[0]) || path.some((p) => p === ".." || p === "." || p.includes("\\"))) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found", details: {} } }, { status: 404 });
  }
  if (!csrfOk(req)) return forbidden();
  const token = req.cookies.get(AT)?.value;
  if (!token) return NextResponse.json({ error: { code: "SESSION_EXPIRED", message: "Please sign in again.", details: {} } }, { status: 401 });

  const headers: Record<string, string> = {};
  for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers[h] = v; }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const up = await callUpstream(req, `/v1/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`, {
    method: req.method, token, headers, body: hasBody ? await req.arrayBuffer() : undefined,
  });
  const out = new NextResponse(up.body, { status: up.status });
  for (const h of RETURN) { const v = up.headers.get(h); if (v) out.headers.set(h, v); }
  out.headers.set("cache-control", "no-store");
  return out;
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
