import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import http, { ApiError } from '../api/client';
import { useLiveRefresh } from '../live/LiveProvider';

export interface ApiResult<T> { data: T | null; loading: boolean; error: ApiError | null; reload: () => Promise<void> }

/**
 * GET a Customer Management path. It re-reads by itself when the server pushes a change (live updates, see live/LiveProvider) and,
 * with `pollMs`, on a timer while the screen is focused and the app is in the foreground. The timer is a safety net for data the
 * push does not cover (support tickets are kept by another service) and for when the live connection is down.
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number; live?: boolean } = {}): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  const focused = useIsFocused();

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const r = await http.get<T>(path);
      if (alive.current) { setData(r.data); setError(null); }
    } catch (e) {
      if (alive.current) setError(e as ApiError);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => { alive.current = true; setLoading(!!path); load(); return () => { alive.current = false; }; }, [load, path]);

  // Live updates: when the server says something changed, a screen that is showing re-reads at once; one that is not (another tab,
  // a screen further back in the stack) is marked stale and catches up the moment it is shown again, so no work is wasted.
  const stale = useRef(false);
  useLiveRefresh(() => {
    if (!path || opts.live === false) return;
    if (focused) load(); else stale.current = true;
  });
  useEffect(() => {
    if (focused && stale.current) { stale.current = false; load(); }
  }, [focused, load]);

  useEffect(() => {
    if (!opts.pollMs || !focused) return;
    const id = setInterval(() => { if (AppState.currentState === 'active') load(); }, opts.pollMs);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') load(); });
    return () => { clearInterval(id); sub.remove(); };
  }, [opts.pollMs, focused, load]);

  return { data, loading, error, reload: load };
}
