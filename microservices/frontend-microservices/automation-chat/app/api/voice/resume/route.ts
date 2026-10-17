import { NextRequest } from 'next/server';
import { proxyVoiceChat } from '@/lib/voice/proxy';
export async function POST(req: NextRequest) { return proxyVoiceChat(req, 'resume'); }
