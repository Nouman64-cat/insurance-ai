import { CM_BASE } from '../config';

/** One frame from /v1/events (policyholder) or /v1/walk-in/events (prospect). `data:` JSON, e.g. {"type":"refresh"}. */
export interface StreamEvent { type: 'ready' | 'refresh' | 'end'; reason?: string }

export interface StreamHandle { close: () => void }

/**
 * The server sends a keep-alive comment every 15 s. If nothing at all has arrived for this long the connection is dead even though
 * the OS never said so (a phone's Wi-Fi going to sleep leaves the socket half-open), so it is dropped and reopened instead of
 * waiting for events that can no longer arrive.
 */
const STALL_AFTER_MS = 40_000;
const STALL_CHECK_MS = 10_000;

/**
 * Opens a Server-Sent Events stream. React Native's fetch cannot read a response body incrementally, but XMLHttpRequest exposes
 * the growing `responseText` as it arrives, which is all SSE needs. `onClose` fires exactly once, when the connection ends for any
 * reason other than `close()`; `status` is the HTTP status when the server refused the connection (401 = token expired).
 */
export function openStream(path: string, token: string, onEvent: (e: StreamEvent) => void, onClose: (reason: string, status: number) => void): StreamHandle {
  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let buffer = '';
  let closed = false;
  let lastActivity = Date.now();

  const finish = (reason: string) => {
    clearInterval(watchdog);
    if (closed) return;
    closed = true;
    onClose(reason, xhr.status || 0);
  };

  const watchdog = setInterval(() => {
    if (closed || Date.now() - lastActivity < STALL_AFTER_MS) return;
    finish('stalled');
    xhr.abort();
  }, STALL_CHECK_MS);

  const drain = () => {
    const text = xhr.responseText || '';
    if (text.length <= consumed) return;
    lastActivity = Date.now(); // any bytes, keep-alive comments included
    buffer += text.slice(consumed);
    consumed = text.length;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue; // comment lines (": keep-alive") and "retry:" carry no data
      try { onEvent(JSON.parse(data)); } catch { /* a malformed frame must not kill the stream */ }
    }
  };

  xhr.open('GET', `${CM_BASE}${path}`);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  xhr.setRequestHeader('Cache-Control', 'no-cache');
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.onreadystatechange = () => {
    if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED && xhr.status >= 400) {
      const status = xhr.status;
      finish(`HTTP ${status}`);
      xhr.abort();
      return;
    }
    if (xhr.readyState === XMLHttpRequest.LOADING || xhr.readyState === XMLHttpRequest.DONE) drain();
    if (xhr.readyState === XMLHttpRequest.DONE) finish(xhr.status ? `ended (${xhr.status})` : 'network error');
  };
  xhr.onerror = () => finish('network error');
  xhr.send();

  return { close: () => { closed = true; clearInterval(watchdog); xhr.abort(); } };
}
