import { NextRequest } from "next/server";

async function proxy(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return Response.json({detail:"Authentication required"},{status:401});
  try {
    const base = process.env.API_GATEWAY_INTERNAL_URL || "http://localhost:8010";
    const upstream = await fetch(`${base}/audit/v1/archive/config`, {
      method:request.method, headers:{Authorization:authorization,"Content-Type":"application/json"},
      body:request.method === "PUT" ? await request.text() : undefined,
      cache:"no-store", signal:AbortSignal.timeout(15000),
    });
    return new Response(await upstream.text(), {status:upstream.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
  } catch {return Response.json({detail:"Audit configuration is temporarily unavailable"},{status:503});}
}
export const GET = proxy;
export const PUT = proxy;
