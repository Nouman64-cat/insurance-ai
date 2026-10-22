/** One identity per user intent ("slot"), kept through failures and app restarts, consumed by success or a final refusal.
 *
 * A write that times out or hits a 5xx may or may not have happened, so the retry must carry the SAME Idempotency-Key; the server then
 * answers with the original outcome instead of doing it twice. A refusal (validation, permission, business rule) ends the attempt: the
 * next intent gets a fresh key. Only random keys are stored -- never request bodies or personal data.
 */
export interface KeyStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function newKey(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const rnd = () => Math.random().toString(36).slice(2, 12);
  return `k${Date.now().toString(36)}${rnd()}${rnd()}`;
}

/** True when the server answered and refused for good; false for network errors, 5xx and in-flight/uncertain states. */
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

export function createOperations(store: KeyStore, scope: () => Promise<string>) {
  async function run<T>(slot: string, action: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    const storageKey = `getinsuredai:operation:v1:${await scope()}:${slot}`;
    let key = await store.getItem(storageKey);
    if (!key) {
      key = newKey();
      await store.setItem(storageKey, key);
    }
    try {
      const result = await action({ 'Idempotency-Key': key });
      if ((await store.getItem(storageKey)) === key) await store.removeItem(storageKey);
      return result;
    } catch (error) {
      if (isFinalRejection(error) && (await store.getItem(storageKey)) === key) await store.removeItem(storageKey);
      throw error;
    }
  }
  return { run };
}
