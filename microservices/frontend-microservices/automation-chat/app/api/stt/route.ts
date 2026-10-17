import { NextRequest } from 'next/server';
import { proxyVoice } from '@/lib/voice/proxy';
export async function POST(req: NextRequest) { return proxyVoice(req, 'transcribe'); }
