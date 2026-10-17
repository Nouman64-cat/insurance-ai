import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSession } from '../context/SessionContext';
import { fetchProposals } from '../api/proposals';
import { fetchCaseFolders } from '../api/cases';
import { useLeadSync } from './LeadSyncProvider';
import { useLiveEvents, useLiveRefresh } from './LiveEventsProvider';

/**
 * Which leads, proposals and cases the signed-in user has not opened yet — the
 * source of the tab-bar badges. An item counts as "new" from the moment it
 * appears until the user opens it; the very first load for a user is the
 * baseline (everything already there counts as seen), so installing the app or
 * signing in does not light up every tab.
 *
 * Seen ids are stored per tenant + user, so two people sharing a device keep
 * their own state.
 */

export type SeenKind = 'leads' | 'proposals' | 'cases';
const KINDS: SeenKind[] = ['leads', 'proposals', 'cases'];
const STORAGE_PREFIX = 'seen_items_v1';
/** Fallback refresh for proposals/cases while the live connection is down. */
const POLL_MS = 30_000;
const MAX_STORED_IDS = 2000;

interface SeenItemsContextValue {
  unseen: Record<SeenKind, number>;
  isUnseen: (kind: SeenKind, id: string) => boolean;
  markSeen: (kind: SeenKind, id: string | null | undefined) => void;
}

const SeenItemsContext = createContext<SeenItemsContextValue>({
  unseen: { leads: 0, proposals: 0, cases: 0 },
  isUnseen: () => false,
  markSeen: () => {},
});

type IdSets = Record<SeenKind, Set<string>>;
const emptySets = (): IdSets => ({ leads: new Set(), proposals: new Set(), cases: new Set() });

export const SeenItemsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useSession();
  const { leads } = useLeadSync();
  const { connected } = useLiveEvents();

  const userKey = user ? `${user.tenantId}:${user.id || user.email}` : null;

  const [current, setCurrent] = useState<IdSets>(emptySets);
  /** null per kind until read from storage — nothing counts as new before that. */
  const [seen, setSeen] = useState<Record<SeenKind, Set<string> | null>>({ leads: null, proposals: null, cases: null });
  /** Which kinds have had a successful list load since sign-in (needed for the baseline). */
  const loaded = useRef<Record<SeenKind, boolean>>({ leads: false, proposals: false, cases: false });

  // ── Storage ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setSeen({ leads: null, proposals: null, cases: null });
    setCurrent(emptySets());
    loaded.current = { leads: false, proposals: false, cases: false };
    if (!userKey) return;
    Promise.all(KINDS.map((k) => AsyncStorage.getItem(`${STORAGE_PREFIX}:${userKey}:${k}`).catch(() => null))).then(
      (raws) => {
        if (cancelled) return;
        const next: Record<SeenKind, Set<string> | null> = { leads: null, proposals: null, cases: null };
        KINDS.forEach((k, i) => {
          try {
            const parsed = raws[i] ? JSON.parse(raws[i] as string) : null;
            // No stored set yet = first run for this user: an empty set marked as
            // "baseline pending" (see below) rather than null, so loading can finish.
            next[k] = Array.isArray(parsed) ? new Set(parsed) : new Set(['__baseline__']);
          } catch {
            next[k] = new Set(['__baseline__']);
          }
        });
        setSeen(next);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [userKey]);

  const persist = useCallback(
    (kind: SeenKind, ids: Set<string>) => {
      if (!userKey) return;
      AsyncStorage.setItem(`${STORAGE_PREFIX}:${userKey}:${kind}`, JSON.stringify(Array.from(ids))).catch(
        () => undefined
      );
    },
    [userKey]
  );

  // First load for a user: everything already on the board is the baseline.
  useEffect(() => {
    let changed = false;
    const next = { ...seen };
    for (const k of KINDS) {
      const set = seen[k];
      if (set?.has('__baseline__') && loaded.current[k]) {
        next[k] = new Set(current[k]);
        persist(k, next[k]!);
        changed = true;
      }
    }
    if (changed) setSeen(next);
  }, [current, seen, persist]);

  // ── Current lists ──────────────────────────────────────────────────────────

  const setKind = useCallback((kind: SeenKind, ids: string[]) => {
    loaded.current[kind] = true;
    setCurrent((prev) => ({ ...prev, [kind]: new Set(ids) }));
  }, []);

  // Leads already come from the shared sync provider.
  const leadIds = useMemo(() => leads.map((l) => l.id), [leads]);
  const { lastSyncedAt } = useLeadSync();
  useEffect(() => {
    if (lastSyncedAt) setKind('leads', leadIds);
  }, [leadIds, lastSyncedAt, setKind]);

  const inFlight = useRef(false);
  const loadOthers = useCallback(async () => {
    if (!userKey || inFlight.current) return;
    inFlight.current = true;
    try {
      const [proposals, cases] = await Promise.all([fetchProposals(), fetchCaseFolders()]);
      setKind('proposals', proposals.map((p) => p.id));
      setKind('cases', cases.map((c) => c.id));
    } catch {
      // Keep the last lists; the next event or tick retries.
    } finally {
      inFlight.current = false;
    }
  }, [userKey, setKind]);

  useEffect(() => {
    loadOthers();
  }, [loadOthers]);

  useLiveRefresh(loadOthers, ['customers', 'policies', 'cases', 'families', 'organizations'], 400);

  useEffect(() => {
    if (!userKey || connected) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') loadOthers();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [userKey, connected, loadOthers]);

  // ── API ────────────────────────────────────────────────────────────────────

  const isUnseen = useCallback(
    (kind: SeenKind, id: string) => {
      const set = seen[kind];
      return !!set && !set.has('__baseline__') && current[kind].has(id) && !set.has(id);
    },
    [seen, current]
  );

  const markSeen = useCallback(
    (kind: SeenKind, id: string | null | undefined) => {
      if (!id) return;
      setSeen((prev) => {
        const set = prev[kind];
        if (!set || set.has(id)) return prev;
        const next = new Set(set);
        next.add(id);
        // Sets keep insertion order, so trimming from the front drops the oldest ids
        // and keeps storage bounded.
        while (next.size > MAX_STORED_IDS) next.delete(next.values().next().value as string);
        persist(kind, next);
        return { ...prev, [kind]: next };
      });
    },
    [persist]
  );

  const unseen = useMemo(() => {
    const count = (kind: SeenKind) => {
      const set = seen[kind];
      if (!set || set.has('__baseline__')) return 0;
      let n = 0;
      current[kind].forEach((id) => {
        if (!set.has(id)) n += 1;
      });
      return n;
    };
    return { leads: count('leads'), proposals: count('proposals'), cases: count('cases') };
  }, [seen, current]);

  const value = useMemo(() => ({ unseen, isUnseen, markSeen }), [unseen, isUnseen, markSeen]);
  return <SeenItemsContext.Provider value={value}>{children}</SeenItemsContext.Provider>;
};

export const useSeenItems = () => useContext(SeenItemsContext);
