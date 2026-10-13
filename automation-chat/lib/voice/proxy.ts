import { NextRequest } from 'next/server';
import { API_GATEWAY_INTERNAL_URL, SSO_COOKIE_NAME } from '@/lib/sso';

export async function proxyVoice(req: NextRequest, path: 'session' | 'transcribe') {
  const token = req.cookies.get(SSO_COOKIE_NAME)?.value || req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return Response.json({detail: 'Sign in to use voice'}, {status: 401});
  try {
    const response = await fetch(`${API_GATEWAY_INTERNAL_URL}/chat/voice/${path}`, {
      method: 'POST', cache: 'no-store', signal: req.signal,
      headers: {'Content-Type': req.headers.get('content-type') || 'application/json', Authorization: `Bearer ${token}`,
        'X-Tenant-Id': req.headers.get('x-tenant-id') || ''}, body: await req.arrayBuffer(),
    });
    return new Response(response.body, {status: response.status, headers: {
      'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store',
    }});
  } catch {
    return Response.json({detail: 'Voice service is temporarily unavailable. Please retry.'}, {status: 503});
  }
}

/** Verify identity before forwarding voice requests into the text graph. The
 * browser/model cannot grant itself a role by changing the request payload. */
export async function proxyVoiceChat(req: NextRequest, path: 'stream' | 'resume') {
  const token = req.cookies.get(SSO_COOKIE_NAME)?.value || req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return Response.json({detail: 'Sign in to use voice'}, {status: 401});
  try {
    const auth = await fetch(`${API_GATEWAY_INTERNAL_URL}/auth/me`, {headers: {Authorization: `Bearer ${token}`}, cache: 'no-store', signal: req.signal});
    if (!auth.ok) return Response.json({detail: 'Session expired. Sign in again.'}, {status: 401});
    const user = await auth.json();
    if (!user.is_active || user.status !== 'ACTIVE') return Response.json({detail: 'Account is inactive'}, {status: 403});
    const tenant = req.headers.get('x-tenant-id') || '';
    if (user.role_name !== 'SuperAdmin' && user.tenant_id !== tenant) return Response.json({detail: 'Tenant access denied'}, {status: 403});
    const body = await req.json();
    body.role = user.role_name; body.platform = 'web';
    const upstream = await fetch(`${API_GATEWAY_INTERNAL_URL}/chat/${path}`, {method: 'POST', cache: 'no-store', signal: req.signal,
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenant}, body: JSON.stringify(body)});
    return new Response(upstream.body, {status: upstream.status, headers: {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'}});
  } catch {
    return Response.json({detail: 'The platform is temporarily unavailable. Please retry.'}, {status: 503});
  }
}
