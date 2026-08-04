import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Replace with actual API URL or use environment variables
// Using the machine's local IP (192.168.1.212) and API gateway port (8010) for physical device testing
const API_BASE_URL = 'http://192.168.1.212:8010'; 

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 10000,
});

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('jwt_token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401) {
      await AsyncStorage.multiRemove(['jwt_token', 'tenant_id', 'user_email', 'agent_id']);
      // Should redirect to login here
    }
    const detail = err.response?.data?.detail;
    let message = 'An unexpected error occurred.';
    if (detail) {
      if (typeof detail === 'string') message = detail;
      else if (Array.isArray(detail)) message = detail.map((d: any) => d.msg || JSON.stringify(d)).join(', ');
      else message = JSON.stringify(detail);
    } else if (err.message) {
      message = err.message;
    }
    return Promise.reject(new Error(message));
  }
);

export default api;
