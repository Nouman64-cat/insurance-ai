import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function proxy(request: NextRequest, {params}: {params:{path:string[]}}) {
  const path=params.path.join("/");
  if (!/^(health|analyze|results|results\/[0-9a-f-]{36})$/.test(path) || (request.method === "POST" && path !== "analyze") || (request.method === "GET" && path === "analyze")) return new Response(null,{status:404});
  const authorization=request.headers.get("authorization");
  if (!authorization) return Response.json({detail:"Admin sign-in required"},{status:401});
  try {
    const base=process.env.API_GATEWAY_INTERNAL_URL || "http://localhost:8010";
    const options:RequestInit & {duplex?:"half"}={method:request.method,headers:{Authorization:authorization,"Content-Type":request.headers.get("content-type") || "application/json"},cache:"no-store",signal:AbortSignal.timeout(650000)};
    if (request.method === "POST") {options.body=request.body;options.duplex="half";}
    const upstream=await fetch(`${base}/document-intelligence/${path}${request.nextUrl.search}`,options);
    return new Response(upstream.body,{status:upstream.status,headers:{"Content-Type":upstream.headers.get("content-type") || "application/json","Cache-Control":"no-store"}});
  } catch {return Response.json({detail:"Document Intelligence is unavailable. Check saved history before retrying an interrupted upload."},{status:503});}
}
export const GET=proxy;
export const POST=proxy;
