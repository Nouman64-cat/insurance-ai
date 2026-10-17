import { NextResponse } from "next/server";
import { contactSchema } from "@/lib/contact-schema";

// Prototype handler: validates and logs the request. Forwarding to the API gateway
// (as a lead with an acquisition source) or to email is not wired up yet.
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = contactSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.flatten().fieldErrors }, { status: 422 });
  }

  const { company, interest } = parsed.data;
  console.info("[marketing-site] demo request received", { company, interest });

  return NextResponse.json({ ok: true });
}
