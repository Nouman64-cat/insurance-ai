import http from './client';

/** Thin helpers over the Customer Management client (paths are the same as the web portal's /api/portal/v1/<path>). */
interface Opts { key?: string }

const headers = (o?: Opts) => (o?.key ? { 'Idempotency-Key': o.key } : undefined);

export const post = async <T = any>(path: string, body?: unknown, o?: Opts): Promise<T> => (await http.post<T>(path, body ?? {}, { headers: headers(o) })).data;
export const patch = async <T = any>(path: string, body?: unknown, o?: Opts): Promise<T> => (await http.patch<T>(path, body ?? {}, { headers: headers(o) })).data;

/** Multipart upload. The explicit content type lets React Native add the boundary itself. */
export const upload = async <T = any>(path: string, form: FormData, config: Record<string, unknown> = {}): Promise<T> =>
  (await http.post<T>(path, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000, ...config })).data;
