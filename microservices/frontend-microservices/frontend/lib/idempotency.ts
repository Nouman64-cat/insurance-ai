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
  const result = await action(key);
  if (sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey);
  return result;
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
