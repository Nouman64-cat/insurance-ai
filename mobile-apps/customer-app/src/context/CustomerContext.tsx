import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import http from '../api/client';
import { useLiveRefresh } from '../live/LiveProvider';
import type { FamilyGroupSummary, Notice } from '../api/portalTypes';

/**
 * Two small pieces of account-wide state the policyholder screens share:
 *  - whether the customer belongs to a family with issued policies (it adds the Individual / Family switch and "My Family"),
 *  - the unread-notification count for the tab badge. It follows the live updates (live/LiveProvider) and also refreshes on a
 *    timer and whenever the app returns to the foreground, as a safety net.
 */
interface Ctx {
  families: FamilyGroupSummary[]; hasFamily: boolean; reloadFamilies: () => void;
  unread: number; refreshNotices: () => void;
}
const C = createContext<Ctx>({ families: [], hasFamily: false, reloadFamilies: () => undefined, unread: 0, refreshNotices: () => undefined });

const POLL_MS = 60_000;

export function CustomerProvider({ children }: { children: React.ReactNode }) {
  const [families, setFamilies] = useState<FamilyGroupSummary[]>([]);
  const [unread, setUnread] = useState(0);

  const reloadFamilies = useCallback(() => {
    http.get<{ items: FamilyGroupSummary[] }>('/family').then((r) => setFamilies(r.data.items ?? [])).catch(() => undefined);
  }, []);
  const refreshNotices = useCallback(() => {
    http.get<{ items: Notice[]; unread: number }>('/notifications').then((r) => setUnread(r.data.unread ?? 0)).catch(() => undefined);
  }, []);

  useEffect(() => {
    reloadFamilies(); refreshNotices();
    const id = setInterval(() => { if (AppState.currentState === 'active') refreshNotices(); }, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refreshNotices(); });
    return () => { clearInterval(id); sub.remove(); };
  }, [reloadFamilies, refreshNotices]);

  useLiveRefresh(() => { refreshNotices(); reloadFamilies(); });   // a policy issued or a claim decided changes the badge and the family section

  const value = useMemo(() => ({ families, hasFamily: families.length > 0, reloadFamilies, unread, refreshNotices }), [families, reloadFamilies, unread, refreshNotices]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useCustomer = () => useContext(C);
