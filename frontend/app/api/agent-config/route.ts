import { NextResponse } from 'next/server';

export async function GET() {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!deepgramApiKey || !groqApiKey) {
    return NextResponse.json({ error: 'Missing required API keys in environment' }, { status: 500 });
  }

  // Note: For a production app, do NOT expose GROQ_API_KEY to the client.
  // Deepgram Agent allows bringing your own LLM, but requires passing the endpoint & headers 
  // from the client when establishing the WS connection.
  return NextResponse.json({
    deepgramApiKey,
    groqApiKey
  });
}
