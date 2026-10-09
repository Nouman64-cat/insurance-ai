import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { fetchACRRequests, ACRRequest } from '../api/confidentialReport';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';

/**
 * The Agent's Confidential Reports the pipeline has asked this user to file.
 *
 * When an individual, family or corporate case reaches Gate 2, the portal sends
 * the request to the case's acquisition source (agent, broker, bank desk…).
 * This provider polls for those requests while the app is in the foreground and
 * raises a notification for each new one; filing it from the ACR screen
 * publishes `ACRSubmitted`, which moves the portal's workflow on by itself.
 */

const POLL_INTERVAL_MS = 15_000;

const SEGMENT_LABEL: Record<ACRRequest['segment'], string> = {
  individual: 'Individual',
  family: 'Family',
  organization: 'Corporate',
};

interface ACRRequestsContextValue {
  /** Requests still to be filed (Requested or Draft), newest first. */
  requests: ACRRequest[];
  loading: boolean;
  refresh: () => Promise<void>;
}

const ACRRequestsContext = createContext<ACRRequestsContextValue>({
  requests: [],
  loading: true,
  refresh: async () => {},
});

export const ACRRequestsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthenticated } = useSession();
  const { notify } = useNotifications();

  const [requests, setRequests] = useState<ACRRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // null until the first load: that load is the baseline, not news.
  const seen = useRef<Set<string> | null>(null);
  const inFlight = useRef(false);
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const load = useCallback(async () => {
    if (!isAuthenticated || inFlight.current) return;
    inFlight.current = true;
    try {
      const incoming = await fetchACRRequests();
      setRequests(incoming);

      const prev = seen.current;
      if (prev) {
        for (const r of incoming) {
          if (prev.has(r.case_id) || r.status !== 'Requested') continue;
          const group = r.group_name ? ` · ${r.group_name}` : '';
          notifyRef.current({
            kind: 'acr.requested',
            title: `Confidential report requested for ${r.applicant_name || r.case_number || 'a case'}`,
            body: `${SEGMENT_LABEL[r.segment] ?? 'Case'}${group} · ${r.case_number ?? ''}${
              r.requested_by_name ? ` · from ${r.requested_by_name}` : ''
            }`,
            target: {
              screen: 'AgentConfidentialReport',
              params: { caseId: r.case_id, applicantName: r.applicant_name ?? undefined },
            },
            data: { caseId: r.case_id },
            popup: true,
          });
        }
      }
      seen.current = new Set(incoming.map((r) => r.case_id));
    } catch {
      // A failed poll keeps the last list; the next tick retries.
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [isAuthenticated]);

  // Reset the baseline when the signed-in user changes.
  useEffect(() => {
    seen.current = null;
    setRequests([]);
    setLoading(true);
    if (isAuthenticated) load();
  }, [isAuthenticated, user?.id, load]);

  // Poll only while the app is in the foreground.
  useEffect(() => {
    if (!isAuthenticated) return;
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, POLL_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        load();
        if (!timer) timer = setInterval(load, POLL_INTERVAL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [isAuthenticated, load]);

  const value = useMemo(() => ({ requests, loading, refresh: load }), [requests, loading, load]);
  return <ACRRequestsContext.Provider value={value}>{children}</ACRRequestsContext.Provider>;
};

export const useACRRequests = () => useContext(ACRRequestsContext);
