export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return Response.json(
      { detail: "Upload a document as multipart form data." },
      { status: 415 },
    );
  }
  try {
    const backend = process.env.DOCS_FORGERY_URL || "http://localhost:8032";
    // Stream multipart bytes without decoding/re-encoding or buffering the file.
    const options: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: request.body,
      duplex: "half",
      cache: "no-store",
      signal: AbortSignal.timeout(600_000),
    };
    const upstream = await fetch(
      `${backend.replace(/\/$/, "")}/analyze`,
      options,
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const timeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return Response.json(
      {
        detail: timeout
          ? "Analysis took too long. Try fewer pages or use file checks only."
          : "The analysis service is unavailable. Check that docs-forgery is running and try again.",
      },
      { status: timeout ? 504 : 503 },
    );
  }
}
