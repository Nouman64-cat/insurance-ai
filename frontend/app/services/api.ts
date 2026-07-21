import axios from "axios";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;
export const OCR_BASE_URL = process.env.NEXT_PUBLIC_OCR_URL;
export const SUMMARIZER_BASE_URL = process.env.NEXT_PUBLIC_SUMMARIZER_URL;

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
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
      localStorage.removeItem("jwt_token");
      localStorage.removeItem("tenant_id");
      localStorage.removeItem("user_email");
      window.location.href = "/login";
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
      localStorage.removeItem("jwt_token");
      localStorage.removeItem("tenant_id");
      localStorage.removeItem("user_email");
      window.location.href = "/login";
      return Promise.reject(new Error("Session expired. Redirecting to login..."));
    }
    const message = getErrorMessage(err, "OCR processing failed.");
    return Promise.reject(new Error(message));
  },
);

export const summarizerApi = axios.create({
  baseURL: SUMMARIZER_BASE_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 120_000,
});

summarizerApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("jwt_token");
      localStorage.removeItem("tenant_id");
      localStorage.removeItem("user_email");
      window.location.href = "/login";
      return Promise.reject(new Error("Session expired. Redirecting to login..."));
    }
    const message = getErrorMessage(err, "Summarization failed.");
    return Promise.reject(new Error(message));
  },
);

export default api;
