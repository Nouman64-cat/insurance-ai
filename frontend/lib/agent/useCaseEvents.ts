"use client";

import { useEffect, useRef, useState } from "react";

// A case event pushed by api-gateway's GET /events/stream (see
// services/api-gateway/case_event_hub.py).
export interface CaseEvent {
  type: "case_event";
  event_id: string;
  event_type: string; // e.g. "EApplicationSubmitted"
  timestamp: string;
  case_id: string;
  case_number?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  detail?: Record<string, unknown> | null;
}

// Keeps one SSE connection open while `enabled`, reconnecting with backoff.
// fetch() rather than EventSource because the stream needs the Bearer header.
// Returns whether the stream is currently connected.
export function useCaseEvents(onEvent: (evt: CaseEvent) => void, enabled = true): boolean {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const controller = new AbortController();
    let retryMs = 1000;

    const connect = async () => {
      while (!controller.signal.aborted) {
        const token = localStorage.getItem("jwt_token");
        if (!token) return;
        const tenantId = localStorage.getItem("tenant_id");
        try {
          const res = await fetch("/api/events/stream", {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
            },
            signal: controller.signal,
          });
          if (res.status === 401 || res.status === 403) return; // signed out — don't hammer
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          retryMs = 1000;
          setConnected(true);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                  const evt = JSON.parse(line.slice(5).trim());
                  if (evt?.type === "case_event") onEventRef.current(evt as CaseEvent);
                } catch { /* malformed frame — skip */ }
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        } finally {
          setConnected(false);
        }
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, 30000);
      }
    };
    connect();
    return () => controller.abort();
  }, [enabled]);

  return connected;
}
