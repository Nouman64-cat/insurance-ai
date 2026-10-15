import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { CM_BASE } from '../config';
import { clearSession, currentSession, loadSession, saveSession, Scope } from '../lib/tokens';

/** Customer Management answers every failure as {"error": {"code", "message", "details"}}. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, any> = {},
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const http = axios.create({ baseURL: CM_BASE, timeout: 20000, headers: { 'Content-Type': 'application/json' } });

/** Fires when the session can no longer be used (expired, revoked, refresh refused), so the UI returns to sign-in. */
const signedOutHandlers = new Set<() => void>();
export const onSignedOut = (h: () => void) => {
  signedOutHandlers.add(h);
  return () => signedOutHandlers.delete(h);
};

http.interceptors.request.use(async (config) => {
  const s = (await loadSession()) ?? null;
  if (s && config.headers && !(config as any).skipAuth) config.headers.Authorization = `Bearer ${s.accessToken}`;
  return config;
});

// One refresh at a time: the refresh token rotates, so two parallel refreshes would invalidate each other.
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const s = currentSession();
  if (!s?.refreshToken || s.scope === 'walk_in') return false;
  try {
    const { data } = await axios.post(`${CM_BASE}/auth/refresh`, { refresh_token: s.refreshToken }, { timeout: 20000 });
    await saveSession({ accessToken: data.access_token, refreshToken: data.refresh_token, scope: data.scope as Scope });
    return true;
  } catch {
    return false;
  }
}

/** Renews the access token from the refresh token (one renewal at a time, shared with the request interceptor). */
export function renewSession(): Promise<boolean> {
  refreshing ??= refreshSession().finally(() => { refreshing = null; });
  return refreshing;
}

function toApiError(err: AxiosError<any>): ApiError {
  const body = err.response?.data?.error;
  if (body) {
    const retry = Number(err.response?.headers?.['retry-after']);
    return new ApiError(err.response!.status, body.code, body.message, body.details, Number.isFinite(retry) ? retry : undefined);
  }
  if (err.code === 'ECONNABORTED') return new ApiError(0, 'TIMEOUT', 'The server took too long to respond.');
  if (!err.response) return new ApiError(0, 'NETWORK', 'No connection. Check your network and try again.');
  return new ApiError(err.response.status, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again shortly.');
}

http.interceptors.response.use(
  (r) => r,
  async (err: AxiosError<any>) => {
    const original = err.config as (AxiosRequestConfig & { _retried?: boolean; skipAuth?: boolean }) | undefined;
    const isAuthCall = original?.url?.startsWith('/auth/') ?? false;
    if (err.response?.status === 401 && original && !original.skipAuth && !isAuthCall) {
      const had = currentSession();
      if (had && !original._retried && had.refreshToken) {
        refreshing ??= refreshSession().finally(() => { refreshing = null; });
        if (await refreshing) {
          original._retried = true;
          return http(original);
        }
      }
      if (had) {
        await clearSession();
        signedOutHandlers.forEach((h) => h());
      }
    }
    return Promise.reject(toApiError(err));
  },
);

export default http;
export const publicCall = { skipAuth: true } as AxiosRequestConfig;
