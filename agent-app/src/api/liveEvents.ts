import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';

/**
 * One event from api-gateway's GET /events/stream (see
 * services/api-gateway/case_event_hub.py). `case_event` carries a case
 * milestone ("ACRSubmitted", "EApplicationSubmitted", …) or the generic
 * "DataChanged" tenant-service sends after any write, with
 * `detail.resource` naming what changed ("customers", "cases", …).
 */
export interface LiveEvent {
  type: 'ready' | 'case_event';
  event_id?: string;
  event_type?: string;
  timestamp?: string;
  case_id?: string | null;
  case_number?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * The server sends a keep-alive comment every 15 s. If nothing at all has arrived for this long the
 * connection is dead even though the OS never reported it (a phone's Wi-Fi going to sleep leaves the
 * socket half-open), so it is dropped and re-opened instead of waiting forever for events that
 * can no longer reach the app.
 */
const STALL_AFTER_MS = 40_000;
const STALL_CHECK_MS = 10_000;

export interface EventStreamHandle {
  close: () => void;
}

/**
 * Opens the tenant's live event stream. React Native's fetch can't read a
 * response body incrementally, but XMLHttpRequest exposes the growing
 * `responseText` as it arrives, which is all SSE needs. `onClose` fires once,
 * when the connection ends for any reason other than `close()`.
 */
export const openEventStream = async (
  onEvent: (evt: LiveEvent) => void,
  onClose: (reason: string) => void
): Promise<EventStreamHandle> => {
  const [token, tenantId] = await Promise.all([
    AsyncStorage.getItem('jwt_token'),
    AsyncStorage.getItem('tenant_id'),
  ]);

  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let buffer = '';
  let closed = false;
  let lastActivity = Date.now();

  const watchdog = setInterval(() => {
    if (closed || Date.now() - lastActivity < STALL_AFTER_MS) return;
    clearInterval(watchdog);
    finish('stalled');
    xhr.abort();
  }, STALL_CHECK_MS);

  const finish = (reason: string) => {
    clearInterval(watchdog);
    if (closed) return;
    closed = true;
    onClose(reason);
  };

  const drain = () => {
    const text = xhr.responseText || '';
    if (text.length <= consumed) return;
    lastActivity = Date.now();   // any bytes, keep-alive comments included
    buffer += text.slice(consumed);
    consumed = text.length;

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      // Comment lines (": keep-alive") carry no data.
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // A malformed frame must not kill the stream.
      }
    }
  };

  xhr.open('GET', `${api.defaults.baseURL}/events/stream`);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  xhr.setRequestHeader('Cache-Control', 'no-cache');
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  if (tenantId) xhr.setRequestHeader('X-Tenant-Id', tenantId);

  xhr.onreadystatechange = () => {
    if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED && xhr.status >= 400) {
      finish(`HTTP ${xhr.status}`);
      xhr.abort();
      return;
    }
    if (xhr.readyState === XMLHttpRequest.LOADING || xhr.readyState === XMLHttpRequest.DONE) drain();
    if (xhr.readyState === XMLHttpRequest.DONE) finish(xhr.status ? `ended (${xhr.status})` : 'network error');
  };
  xhr.onerror = () => finish('network error');
  xhr.send();

  return {
    close: () => {
      closed = true;
      clearInterval(watchdog);
      xhr.abort();
    },
  };
};
