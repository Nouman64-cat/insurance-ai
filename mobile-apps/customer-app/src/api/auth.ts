import http from './client';
import { saveSession, clearSession, Scope } from '../lib/tokens';

// Endpoints: services/customer-management/app/routers/auth.py and walk_in.py (reached via the gateway).
const noAuth = { skipAuth: true } as any;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope: Scope;
  must_change_password?: boolean;
}

async function store(d: TokenResponse): Promise<Scope> {
  await saveSession({ accessToken: d.access_token, refreshToken: d.refresh_token ?? null, scope: d.scope });
  return d.scope;
}

export async function login(username: string, password: string, tenantCode?: string): Promise<Scope> {
  const { data } = await http.post<TokenResponse>('/auth/login',
    { username: username.trim(), password, ...(tenantCode?.trim() ? { tenant_code: tenantCode.trim() } : {}) }, noAuth);
  return store(data);
}

export async function firstChange(currentPassword: string, newPassword: string): Promise<Scope> {
  const { data } = await http.post<TokenResponse>('/auth/password/first-change', { current_password: currentPassword, new_password: newPassword });
  return store(data);
}

export interface Me { account_id: string; username: string; display_name: string; language: string; tenant_code: string; must_change_password: boolean; scope: string }
export async function me(): Promise<Me> {
  return (await http.get<Me>('/me')).data;
}

/** Ends the server session when we can, and always clears the device. */
export async function logout(walkIn: boolean): Promise<void> {
  try { await http.post(walkIn ? '/walk-in/logout' : '/auth/logout'); } catch { /* the device is cleared regardless */ }
  await clearSession();
}

// ── walk-in ──
export async function walkInConfig(): Promise<{ demo: boolean }> {
  return (await http.get('/walk-in/config', noAuth)).data;
}

export async function walkInMe(): Promise<{ email: string; display_name: string; language: string }> {
  return (await http.get('/walk-in/me')).data;
}

export async function walkInRequestOtp(email: string): Promise<{ sent: boolean; demo?: boolean; dev_mode?: boolean; expires_in: number }> {
  return (await http.post('/walk-in/otp/request', { email: email.trim() }, noAuth)).data;
}

export async function walkInVerify(email: string, code?: string): Promise<Scope> {
  const { data } = await http.post<TokenResponse>('/walk-in/otp/verify', { email: email.trim(), ...(code ? { code: code.trim() } : {}) }, noAuth);
  return store({ ...data, scope: 'walk_in' });
}
