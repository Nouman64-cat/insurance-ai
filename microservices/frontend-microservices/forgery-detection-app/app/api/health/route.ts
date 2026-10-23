export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const backend = process.env.DOCS_FORGERY_URL || "http://localhost:8032";
    const response = await fetch(`${backend.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Backend unavailable");
    const capabilities = await response.json();
    return Response.json({
      service: "forgery-detection-app",
      status: "healthy",
      backend: "healthy",
      pixel_forensics: capabilities.pixel_forensics,
      analysis_policy: capabilities.analysis_policy,
      platform_configuration: capabilities.platform_configuration,
    });
  } catch {
    return Response.json(
      {
        service: "forgery-detection-app",
        status: "degraded",
        backend: "unavailable",
      },
      { status: 503 },
    );
  }
}
