import axios from "axios";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
const OCR_BASE_URL = process.env.NEXT_PUBLIC_OCR_URL ?? "http://localhost:8014";

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const message =
      err.response?.data?.detail ?? err.message ?? "An unexpected error occurred.";
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
    const message =
      err.response?.data?.detail ?? err.message ?? "OCR processing failed.";
    return Promise.reject(new Error(message));
  },
);

export default api;
