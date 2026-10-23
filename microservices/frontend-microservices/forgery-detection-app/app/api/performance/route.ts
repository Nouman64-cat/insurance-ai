export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const backend = process.env.DOCS_FORGERY_URL || "http://localhost:8032";
    const response = await fetch(`${backend.replace(/\/$/, "")}/performance`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Service unavailable");
    return Response.json(await response.json(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        detail:
          "Performance metrics are unavailable. Check the backend service.",
      },
      { status: 503 },
    );
  }
}
