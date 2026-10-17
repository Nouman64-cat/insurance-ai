import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { renewSession } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { currentSession, loadSession } from '../lib/tokens';
import { StreamHandle, openStream } from './stream';

/**
 * The app's single live connection to the server (Server-Sent Events).
 *
 * When staff change something that the customer is looking at (an advisor moves a lead along, a policy is issued, a claim is
 * decided, a premium is collected) the backend sends a `refresh` nudge and every screen showing server data re-reads it: no manual
 * reload. The stream is open only while signed in and the app is in the foreground. After any reconnect, and whenever the app
 * returns to the foreground, listeners get `resync` ("re-read everything"), so nothing missed while offline stays stale.
 */
export type LiveEvent = 'refresh' | 'resync';
type Listener = (e: LiveEvent) => void;

interface Ctx { connected: boolean; subscribe: (l: Listener) => () => void }
const LiveContext = createContext<Ctx>({ connected: false, subscribe: () => () => undefined });

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => { listeners.current.delete(l); };
  }, []);
  const emit = useCallback((e: LiveEvent) => {
    for (const l of Array.from(listeners.current)) {
      try { l(e); } catch { /* one broken subscriber must not starve the rest */ }
    }
  }, []);

  useEffect(() => {
    const path = state === 'customer' ? '/events' : state === 'walkIn' ? '/walk-in/events' : null;
    if (!path) { setConnected(false); return; }

    let stream: StreamHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let opened = false;                 // the very first connection needs no resync: screens have just loaded
    let disposed = false;
    let active = AppState.currentState === 'active';

    const schedule = () => {
      if (disposed || !active || timer) return;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** failures) * (0.75 + Math.random() * 0.5); // jitter: no thundering herd
      failures += 1;
      timer = setTimeout(() => { timer = null; connect(); }, delay);
    };

    const connect = async () => {
      if (disposed || !active || stream) return;
      const session = (await loadSession()) ?? currentSession();
      if (!session || (state === 'customer' && session.scope !== 'full') || (state === 'walkIn' && session.scope !== 'walk_in')) return;
      stream = openStream(path, session.accessToken, (evt) => {
        if (evt.type === 'ready') {
          failures = 0; setConnected(true);
          if (opened) emit('resync'); opened = true;
        } else if (evt.type === 'refresh') emit('refresh');
        // 'end' = the server's periodic re-authentication; the close handler below reconnects.
      }, async (_reason, status) => {
        stream = null; setConnected(false);
        if (status === 401) {
          // Expired access token: renew it and reconnect. A walk-in session cannot be renewed, and a refused renewal means the session
          // is over; either way the next API call signs the person out, so stop retrying here (coming back to the app retries).
          if (state !== 'customer' || !(await renewSession().catch(() => false))) return;
        }
        if (status === 0 || status >= 500 || status === 401 || status === 200) schedule();
      });
    };

    const sub = AppState.addEventListener('change', (s) => {
      active = s === 'active';
      if (active) { failures = 0; connect(); }
      else { stream?.close(); stream = null; setConnected(false); if (timer) { clearTimeout(timer); timer = null; } }
    });
    connect();

    return () => {
      disposed = true; sub.remove();
      if (timer) clearTimeout(timer);
      stream?.close(); stream = null; setConnected(false);
    };
  }, [state, emit]);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

/** Runs `fn` whenever the server says something changed (or after a reconnect). */
export function useLiveRefresh(fn: (e: LiveEvent) => void) {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}
