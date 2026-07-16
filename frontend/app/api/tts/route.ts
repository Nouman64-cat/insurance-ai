import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Deepgram API Key is missing' }, { status: 500 });
    }

    const { text } = await req.json();

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    // Call Deepgram TTS Aura (Asteria - English Female)
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Deepgram TTS Error:', err);
      return NextResponse.json({ error: 'Deepgram API Error' }, { status: response.status });
    }

    // Return the raw audio buffer
    const arrayBuffer = await response.arrayBuffer();
    
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': arrayBuffer.byteLength.toString(),
      },
    });

  } catch (error: any) {
    console.error('TTS Route Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
