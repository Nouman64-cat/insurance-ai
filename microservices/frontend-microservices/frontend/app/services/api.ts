import axios from "axios";
import { sessionExpired } from "@/lib/sso";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;
export const OCR_BASE_URL = process.env.NEXT_PUBLIC_OCR_URL;
// Summarization uses the authenticated API Gateway, never a public LLM host.
export const SUMMARIZER_BASE_URL = API_BASE_URL;

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 120_000,
});

const getErrorMessage = (err: any, fallbackMessage: string): string => {
  const detail = err.response?.data?.detail;
  if (detail) {
    if (typeof detail === "string") {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail.map((d: any) => d.msg || JSON.stringify(d)).join(", ");
    }
    if (typeof detail === "object" && typeof (detail as any).message === "string") return (detail as any).message;
    return JSON.stringify(detail);
  }
  return err.message ?? fallbackMessage;
};

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      if (typeof window !== "undefined" && window.location.pathname === "/login") {
        return Promise.reject(err);
      }
      // Clears this app's session and sends the user to sign in (the portal's login page, from either app).
      sessionExpired();
      return Promise.reject(new Error("Session expired. Redirecting to login..."));
    }
    const message = getErrorMessage(err, "An unexpected error occurred.");
    return Promise.reject(new Error(message));
  },
);

export const ocrApi = axios.create({
  baseURL: OCR_BASE_URL,
  timeout: 120_000,
});

ocrApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      sessionExpired();
      return Promise.reject(new Error("Session expired. Redirecting to login..."));
    }
    const message = getErrorMessage(err, "OCR processing failed.");
    return Promise.reject(new Error(message));
  },
);

export const summarizerApi = axios.create({
  baseURL: SUMMARIZER_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 120_000,
});

summarizerApi.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("jwt_token");
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

summarizerApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      sessionExpired();
      return Promise.reject(new Error("Session expired. Redirecting to login..."));
    }
    const message = getErrorMessage(err, "Summarization failed.");
    return Promise.reject(new Error(message));
  },
);

export default api;
