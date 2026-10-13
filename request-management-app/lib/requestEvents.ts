// Live status updates from Request Management: a Server-Sent Events stream (GET /v1/events, see the service's
// app/live.py). Read with fetch rather than EventSource so the session token travels in the Authorization header,
// never in a URL. One stream per tab (opened by RequestsShell); it reconnects with backoff and, after a reconnect,
// tells listeners to reload because changes may have been missed.
import { sessionExpired } from "@/lib/sso";
import { BASE } from "@/lib/requestsApi";

export type LiveEvent =
  | { type: "request"; request_id: string; reference_no: string; version: number; review_status: string; execution_status: string }
  | { type: "queue" }       // a request in your team's queue changed, but you may no longer open it (someone claimed it)
  | { type: "resync" };     // changes may have been missed: reload what you show

type Handlers = { onEvent: (e: LiveEvent) => void; onLive: (live: boolean) => void };

function parse(block: string): { event: string; data: any } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return null;
  try {
    return { event, data: data.length ? JSON.parse(data.join("\n")) : {} };
  } catch {
    return null;
  }
}

/** Open the stream. Returns a function that closes it for good. */
export function connectRequestEvents({ onEvent, onLive }: Handlers): () => void {
  const abort = new AbortController();
  let stopped = false;
  let attempt = 0;
  let connectedBefore = false;

  const run = async () => {
    while (!stopped) {
      const token = localStorage.getItem("jwt_token");
      if (!token) return;
      try {
        const res = await fetch(`${BASE}/events`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, cache: "no-store", signal: abort.signal,
        });
        if (res.status === 401) { sessionExpired(); return; }
        if (res.status === 403) return;                     // no access to requests: nothing to stream
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replace(/\r\n?/g, "\n");
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const msg = parse(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 2);
            if (!msg) continue;
            if (msg.event === "ready") {
              attempt = 0;
              onLive(true);
              if (connectedBefore) onEvent({ type: "resync" });
              connectedBefore = true;
            } else if (msg.event === "end") {
              // The server ended the stream because the session is no longer valid: don't reconnect.
              onLive(false);
              reader.cancel().catch(() => undefined);
              if (msg.data?.code === "UNAUTHENTICATED") sessionExpired();
              return;
            } else if (msg.event === "request") {
              onEvent({ type: "request", ...msg.data });
            } else if (msg.event === "queue" || msg.event === "resync") {
              onEvent({ type: msg.event });
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      onLive(false);
      // 1 s, 2 s, 4 s … up to 30 s, with jitter so a restart doesn't bring every tab back at once.
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  };

  run();
  return () => { stopped = true; abort.abort(); };
}
