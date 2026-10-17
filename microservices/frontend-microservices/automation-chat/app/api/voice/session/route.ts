import { NextRequest } from 'next/server';
import { proxyVoice } from '@/lib/voice/proxy';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) { return proxyVoice(req, 'session'); }
