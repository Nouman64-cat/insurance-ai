import { NextResponse } from 'next/server';

export async function GET() {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

  // The live voice agent only needs the Deepgram key — it opens the browser
  // WebSocket to Deepgram's Voice Agent (which hosts the STT / LLM / TTS legs).
  // (An earlier version also required GROQ_API_KEY, but the client never used
  //  it — the agent's `think` provider is Deepgram-hosted, not Groq.)
  if (!deepgramApiKey) {
    return NextResponse.json({ error: 'Live voice is not configured (missing DEEPGRAM_API_KEY).' }, { status: 500 });
  }

  return NextResponse.json({ deepgramApiKey });
}
