import { NextRequest } from "next/server";

// Fixed upstream and resource allowlist. The tenant service enforces SuperAdmin RBAC.
async function proxy(request: NextRequest, {params}: {params:{resource:string}}) {
  if (!["config", "usage", "performance"].includes(params.resource) || (request.method === "PUT" && params.resource !== "config")) return new Response(null,{status:404});
  const authorization = request.headers.get("authorization");
  if (!authorization) return Response.json({detail:"Authentication required"},{status:401});
  const base = process.env.API_GATEWAY_INTERNAL_URL || "http://localhost:8010";
  try {
    const response = await fetch(`${base}/platform/document-forgery/${params.resource}${request.nextUrl.search}`, {
      method:request.method, headers:{Authorization:authorization,"Content-Type":"application/json"},
      body:request.method === "PUT" ? await request.text() : undefined,
      cache:"no-store", signal:AbortSignal.timeout(15000),
    });
    return new Response(await response.text(), {status:response.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
  } catch {return Response.json({detail:"Document Forgery Detection administration is temporarily unavailable"},{status:503});}
}
export const GET = proxy;
export const PUT = proxy;
