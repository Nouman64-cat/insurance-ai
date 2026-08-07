import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Point EXPO_PUBLIC_API_URL at the API gateway (port 8010). The fallback is a
// LAN address, since a physical device cannot reach the host's localhost.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://192.168.1.83:8010';

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
    return Promise.reject(new Error(readErrorMessage(err)));
  }
);

export default api;
