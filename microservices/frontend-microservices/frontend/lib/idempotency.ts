/** One identity per UI operation, retained through failures and page reloads.
 * Store only random keys; never persist request payloads, credentials or PII.
 * `slot` identifies a pending UI workflow, not a hash of its request body.
 * A successful operation consumes the key so the next intent gets a fresh UUID.
 */
export async function runOperation<T>(
  scope: string,
  slot: string,
  action: (key: string) => Promise<T>,
): Promise<T> {
  const storageKey = `getinsuredai:operation:v1:${scope}:${slot}`;
  // Fail before sending if durable browser state is unavailable. Silently creating
  // a new key after a reload would make an uncertain payment unsafe to retry.
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
  }
  let result: T;
  try {
    result = await action(key);
  } catch (error) {
    // A definitive rejection (validation, permission, business rule, changed content) ends this attempt: the next intent
    // gets a fresh key. Timeouts, 5xx, "still processing" and "reconciliation required" keep it, so a retry is the SAME operation.
    if (isFinalRejection(error) && sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey);
    throw error;
  }
  if (sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey);
  return result;
}

/** True when the server answered and refused the request for good; false for network errors, 5xx and in-flight/uncertain states. */
export function isFinalRejection(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { detail?: unknown } } } | undefined)?.response;
  const status = response?.status;
  if (!status || status < 400 || status >= 500) return false;
  if ([408, 423, 425, 429].includes(status)) return false;
  const detail = response?.data?.detail as { code?: string } | string | undefined;
  const code = typeof detail === 'object' && detail ? detail.code : undefined;
  if (status === 409 && (code === 'IDEMPOTENCY_PROCESSING' || code === 'IDEMPOTENCY_RECONCILIATION_REQUIRED')) return false;
  return true;
}

/** One keyed request: `send` receives the Idempotency-Key header; the key is reused until the operation succeeds or is refused. */
export function operation<T>(slot: string, send: (headers: Record<string, string>) => Promise<{ data: T }>): Promise<T> {
  return runOperation(browserOperationScope(), slot, async key => (await send(operationHeaders(key))).data);
}

export function operationHeaders(key: string) {
  return { 'Idempotency-Key': key };
}

/** The JWT subject is used only to namespace local pending IDs, never for auth. */
export function browserOperationScope(): string {
  const token = localStorage.getItem('jwt_token');
  if (!token) throw new Error('Sign in before starting this operation.');
  const payload = token.split('.')[1];
  const identity = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  if (!identity.sub) throw new Error('The current session has no operation identity.');
  return `${localStorage.getItem('tenant_id') ?? 'platform'}:${identity.sub}`;
}

type Poster<T> = { post: (url: string, body?: unknown, config?: Record<string, unknown>) => Promise<{ data: T }> };

/** POST with one Idempotency-Key per UI operation (`slot` = the workflow, e.g. `premium-collect:<policy>:<installment>`). */
export function keyedPost<T = any>(client: Poster<T>, slot: string, url: string, body?: unknown, config: Record<string, unknown> = {}): Promise<T> {
  return operation<T>(slot, headers => client.post(url, body, { ...config, headers: { ...((config.headers as Record<string, string>) ?? {}), ...headers } }));
}

/** Any mutating call (PUT, PATCH, DELETE or POST) with one Idempotency-Key per UI operation; see keyedPost. */
export function keyedRequest<T = any>(client: { request: (config: Record<string, unknown>) => Promise<{ data: T }> }, method: 'post' | 'put' | 'patch' | 'delete',
                                      slot: string, url: string, body?: unknown, config: Record<string, unknown> = {}): Promise<T> {
  return operation<T>(slot, headers => client.request({ ...config, method, url, data: body, headers: { ...((config.headers as Record<string, string>) ?? {}), ...headers } }));
}
