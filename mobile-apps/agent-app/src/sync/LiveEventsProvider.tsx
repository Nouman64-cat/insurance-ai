import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { openEventStream, EventStreamHandle, LiveEvent } from '../api/liveEvents';
import { useSession } from '../context/SessionContext';

/**
 * The app's single live connection to the server (SSE, GET /events/stream).
 *
 * Every write in the portal, the copilot or another device publishes an event
 * here, so screens re-read their data the moment it changes instead of on a
 * manual refresh. The stream is open only while signed in and in the
 * foreground; on every (re)connect subscribers get a `ready` event, which they
 * treat as "re-read everything" so nothing missed while offline is lost.
 */

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

type Listener = (evt: LiveEvent) => void;

interface LiveEventsContextValue {
  /** True while the stream is open and has said `ready`. */
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
}

const LiveEventsContext = createContext<LiveEventsContextValue>({
  connected: false,
  subscribe: () => () => {},
});

export const LiveEventsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useSession();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const emit = useCallback((evt: LiveEvent) => {
    for (const l of Array.from(listeners.current)) {
      try {
        l(evt);
      } catch {
        // One broken subscriber must not starve the rest.
      }
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    let stream: EventStreamHandle | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let active = AppState.currentState === 'active';
    let disposed = false;

    const connect = async () => {
      if (disposed || !active || stream) return;
      try {
        stream = await openEventStream(
          (evt) => {
            if (evt.type === 'ready') {
              failures = 0;
              setConnected(true);
            }
            emit(evt);
          },
          () => {
            stream = null;
            setConnected(false);
            scheduleReconnect();
          }
        );
        if (disposed || !active) {
          stream?.close();
          stream = null;
        }
      } catch {
        stream = null;
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (disposed || !active || retry) return;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_MAX_MS);
      failures += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    const disconnect = () => {
      if (retry) clearTimeout(retry);
      retry = null;
      stream?.close();
      stream = null;
      setConnected(false);
    };

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      active = state === 'active';
      if (active) {
        failures = 0;
        connect();
      } else {
        disconnect();
      }
    });

    connect();
    return () => {
      disposed = true;
      sub.remove();
      disconnect();
    };
  }, [isAuthenticated, user?.id, emit]);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
};

export const useLiveEvents = () => useContext(LiveEventsContext);

/** What a DataChanged / case event touched — `resource` for writes, else "cases". */
const resourceOf = (evt: LiveEvent): string | null => {
  if (evt.type !== 'case_event') return null;
  if (evt.event_type === 'DataChanged') return (evt.detail?.resource as string | undefined) ?? null;
  return 'cases';
};

/**
 * Calls `onChange` (debounced) whenever the server reports a change to any of
 * `resources` — or to anything, when `resources` is omitted — and after every
 * reconnect. A burst of writes (a family with five members) becomes one reload.
 */
export function useLiveRefresh(onChange: () => void, resources?: string[], debounceMs = 600) {
  const { subscribe } = useLiveEvents();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const key = resources?.join('|') ?? '*';

  useEffect(() => {
    const wanted = resources ? new Set(resources) : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((evt) => {
      const resource = resourceOf(evt);
      const relevant = evt.type === 'ready' || (resource !== null && (!wanted || wanted.has(resource)));
      if (!relevant) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChangeRef.current();
      }, debounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    // `key` stands in for `resources`, which callers pass as a fresh array literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, key, debounceMs]);
}
