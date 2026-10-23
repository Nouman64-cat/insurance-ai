import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Use the deployed gateway unless a development backend is explicitly configured.
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL?.trim() || 'https://api.getinsuredai.com').replace(/\/+$/, '');

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

/**
 * Notifies the app when the server rejects our token, so the session layer can
 * drop to the login screen. Without this the storage is cleared but React state
 * still believes it is signed in, and every subsequent request 401s silently.
 */
type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

export const onUnauthorized = (handler: UnauthorizedHandler) => {
  unauthorizedHandlers.add(handler);
  return () => {
    unauthorizedHandlers.delete(handler);
  };
};

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('jwt_token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Turns FastAPI's several `detail` shapes into one readable sentence. */
const readErrorMessage = (err: any): string => {
  const detail = err.response?.data?.detail;
  if (detail) {
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((d: any) => d.msg || JSON.stringify(d)).join(', ');
    }
    return typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
  }
  if (err.code === 'ECONNABORTED') return 'The server took too long to respond.';
  if (err.message === 'Network Error') return 'No connection. Check your network and try again.';
  return err.message || 'An unexpected error occurred.';
};

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401) {
      await AsyncStorage.multiRemove([
        'jwt_token',
        'tenant_id',
        'user_email',
        'user_role',
        'agent_id',
        'agent_name',
      ]);
      unauthorizedHandlers.forEach((handler) => handler());
    }
    // Keep the HTTP response on the error: src/lib/idempotency.ts needs the status to tell a refused write (fresh key next time) from an
    // uncertain one (same key on retry).
    return Promise.reject(Object.assign(new Error(readErrorMessage(err)), { response: err.response }));
  }
);

import { createOperations } from '../lib/idempotency';

/** Writes carrying one Idempotency-Key per user intent. `slot` names the intent (e.g. `ipp-confirm:<caseId>`). */
const operations = createOperations(AsyncStorage, async () => {
  const [tenant, agent] = await Promise.all([AsyncStorage.getItem('tenant_id'), AsyncStorage.getItem('agent_id')]);
  return `${tenant ?? 'platform'}:${agent ?? 'anonymous'}`;
});

export function keyedPost<T = any>(slot: string, url: string, body?: unknown, config: Record<string, any> = {}): Promise<{ data: T }> {
  return operations.run(slot, (headers) => api.post<T>(url, body, { ...config, headers: { ...(config.headers ?? {}), ...headers } }));
}

export default api;
