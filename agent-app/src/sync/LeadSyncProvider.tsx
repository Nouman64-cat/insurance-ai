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
import { fetchLeads, UnifiedLead, LeadScope } from '../api/leads';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { entityLabel, statusLabel } from '../theme/palette';

/**
 * Leads live in one shared database that both the portal and this app read and
 * write. This provider is the app's single reader: it polls that shared state,
 * diffs each snapshot against the last, and turns the differences into
 * notifications — so a lead created in the portal (or by another agent) surfaces
 * here without the user refreshing anything, and vice-versa.
 *
 * Screens read `leads` from here rather than fetching their own copy, which is
 * what keeps the Dashboard and the Leads board from disagreeing.
 */

/** How often to re-read while the app is in the foreground. */
const POLL_INTERVAL_MS = 15_000;
/**
 * After a failure, back off so a flaky connection or a sleeping backend does
 * not get hammered. Doubles per consecutive failure up to the ceiling.
 */
const BACKOFF_BASE_MS = 20_000;
const BACKOFF_MAX_MS = 120_000;
/**
 * How long a locally-made change suppresses its own notification. Long enough
 * to cover the write plus the next poll, short enough that a genuine remote
 * edit to the same lead moments later still gets announced.
 */
const SELF_CHANGE_TTL_MS = 30_000;

interface LeadSyncContextValue {
  leads: UnifiedLead[];
  /** True only during the very first load, so screens can show skeletons. */
  loading: boolean;
  /** True during any background or manual refresh. */
  syncing: boolean;
  error: string | null;
  lastSyncedAt: number | null;
  scope: LeadScope;

  /** Manual refresh — pull-to-refresh and post-write reconciliation. */
  refresh: () => Promise<void>;
  /**
   * Marks a lead as changed by this device so the next poll does not announce
   * the user's own edit back to them. Call right after a successful write.
   */
  markLocalChange: (leadId: string) => void;
  /** Applies an optimistic local change ahead of the next poll. */
  applyLocal: (leadId: string, patch: Partial<UnifiedLead>) => void;
  /** Removes a lead locally after a successful delete. */
  removeLocal: (leadId: string) => void;
}

const LeadSyncContext = createContext<LeadSyncContextValue>({
  leads: [],
  loading: true,
  syncing: false,
  error: null,
  lastSyncedAt: null,
  scope: 'mine',
  refresh: async () => {},
  markLocalChange: () => {},
  applyLocal: () => {},
  removeLocal: () => {},
});

interface LeadSnapshot {
  status: string;
  assignedAgentId?: string | null;
  name: string;
  /**
   * Roll-up policy status for family/corporate leads. Tracked so a lead moving
   * from "Pending" to "Active" in the portal reaches the owning agent, even
   * though its `profile_status` never changes.
   */
  groupPolicyStatus?: string | null;
}

const snapshotOf = (leads: UnifiedLead[]): Map<string, LeadSnapshot> =>
  new Map(
    leads.map((l) => [
      l.id,
      {
        status: l.status,
        assignedAgentId: l.assignedAgentId ?? null,
        name: l.name,
        groupPolicyStatus: l.groupPolicyStatus ?? null,
      },
    ])
  );

/**
 * How a `profile_status` change reads to the agent who owns the lead. The
 * portal drives these transitions; the agent only ever observes them.
 */
const STAGE_ANNOUNCEMENT: Record<string, { title: string; body: string }> = {
  PROSPECT: {
    title: 'moved to Proposal',
    body: 'A quotation is being prepared for this lead.',
  },
  UNDERWRITING_READY: {
    title: 'entered Underwriting',
    body: 'Risk assessment and medical checks are under way.',
  },
  POLICYHOLDER: {
    title: 'is now a Policyholder',
    body: 'The policy has been issued and cover is live.',
  },
  NOT_INTERESTED: {
    title: 'was marked Not Interested',
    body: 'This lead has been moved out of the active pipeline.',
  },
  LEAD: {
    title: 'was reopened',
    body: 'This lead is back in the new-leads stage.',
  },
};

export const LeadSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthenticated, canSeeAllLeads } = useSession();
  const { notify } = useNotifications();

  const [leads, setLeads] = useState<UnifiedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const scope: LeadScope = canSeeAllLeads ? 'all' : 'mine';

  // ── Refs the poll loop reads without re-subscribing ────────────────────────

  const previous = useRef<Map<string, LeadSnapshot> | null>(null);
  const selfChanges = useRef<Map<string, number>>(new Map());
  const consecutiveFailures = useRef(0);
  /** Guards against two polls overlapping when one runs long. */
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  /** So a persistent outage raises one notification, not one per attempt. */
  const errorAnnounced = useRef(false);

  const markLocalChange = useCallback((leadId: string) => {
    selfChanges.current.set(leadId, Date.now() + SELF_CHANGE_TTL_MS);
  }, []);

  const isSelfChange = useCallback((leadId: string) => {
    const expiry = selfChanges.current.get(leadId);
    if (!expiry) return false;
    if (expiry < Date.now()) {
      selfChanges.current.delete(leadId);
      return false;
    }
    return true;
  }, []);

  // ── Diffing ────────────────────────────────────────────────────────────────

  const announceChanges = useCallback(
    (incoming: UnifiedLead[]) => {
      const prev = previous.current;
      const next = snapshotOf(incoming);

      // The first successful load is the baseline. Announcing it would fire a
      // notification for every existing lead on launch.
      if (!prev) {
        previous.current = next;
        return;
      }

      for (const lead of incoming) {
        const before = prev.get(lead.id);
        const mine = !!user && lead.assignedAgentId === user.id;

        if (!before) {
          if (isSelfChange(lead.id)) continue;
          notify({
            kind: 'lead.created',
            title: mine ? 'New lead assigned to you' : 'New lead added',
            body: `${lead.name} · ${entityLabel[lead.type] ?? lead.type}${
              lead.city ? ` · ${lead.city}` : ''
            }`,
            actorName: lead.assignedAgentName ?? undefined,
            target: { screen: 'LeadDetail', params: { leadId: lead.id } },
            data: { leadId: lead.id, type: lead.type },
            // Only interrupt for leads that land on the user's own book.
            popup: mine,
          });
          continue;
        }

        if (isSelfChange(lead.id)) continue;

        if (before.status !== lead.status) {
          const announcement = STAGE_ANNOUNCEMENT[lead.status];
          notify({
            kind: 'lead.updated',
            title: announcement
              ? `${lead.name} ${announcement.title}`
              : `${lead.name} moved to ${statusLabel[lead.status] ?? lead.status}`,
            body: announcement
              ? announcement.body
              : `Was ${statusLabel[before.status] ?? before.status}.`,
            target: { screen: 'LeadDetail', params: { leadId: lead.id } },
            data: { leadId: lead.id },
            // The agent who owns the lead is the one who needs to act on a
            // stage change, so interrupt them; others just get the feed entry.
            popup: mine,
          });
        }

        // Family and corporate leads progress through their group policy while
        // `profile_status` stays put, so that transition is announced too.
        if ((before.groupPolicyStatus ?? null) !== (lead.groupPolicyStatus ?? null)) {
          const now = lead.groupPolicyStatus;
          notify({
            kind: 'lead.updated',
            title: `${lead.name} policy is now ${now ?? 'unset'}`,
            body:
              now === 'Active'
                ? 'The group policy is live — cover has started.'
                : now === 'Pending'
                ? 'A group policy has been set up and is awaiting activation.'
                : 'The group policy status changed.',
            target: { screen: 'LeadDetail', params: { leadId: lead.id } },
            data: { leadId: lead.id },
            popup: mine && now === 'Active',
          });
        }

        if ((before.assignedAgentId ?? null) !== (lead.assignedAgentId ?? null)) {
          notify({
            kind: 'lead.assigned',
            title: mine ? `${lead.name} was assigned to you` : `${lead.name} was reassigned`,
            body: lead.assignedAgentName ? `Now owned by ${lead.assignedAgentName}.` : 'Owner cleared.',
            actorName: lead.assignedAgentName ?? undefined,
            target: { screen: 'LeadDetail', params: { leadId: lead.id } },
            data: { leadId: lead.id },
            popup: mine,
          });
        }
      }

      // Anything that was there last time and is not now was deleted or moved
      // out of scope (converted to a policyholder, reassigned away).
      for (const [id, before] of prev) {
        if (next.has(id) || isSelfChange(id)) continue;
        notify({
          kind: 'lead.deleted',
          title: `${before.name} left your pipeline`,
          body: 'It was deleted, converted, or reassigned to someone else.',
          silent: true,
        });
      }

      previous.current = next;
    },
    [notify, user, isSelfChange]
  );

  // ── Polling ────────────────────────────────────────────────────────────────

  const runSync = useCallback(
    async (options: { manual?: boolean } = {}) => {
      if (!isAuthenticated || inFlight.current) return;
      inFlight.current = true;
      setSyncing(true);

      try {
        const incoming = await fetchLeads({ scope });
        if (!mounted.current) return;

        setLeads(incoming);
        announceChanges(incoming);
        setError(null);
        setLastSyncedAt(Date.now());
        consecutiveFailures.current = 0;
        errorAnnounced.current = false;
      } catch (err: any) {
        if (!mounted.current) return;
        const message = err?.message ?? 'Could not sync with the server.';
        setError(message);
        consecutiveFailures.current += 1;

        // Tell the user once when sync breaks — and only if they asked for it
        // or it has failed repeatedly, so a single blip stays quiet.
        if (!errorAnnounced.current && (options.manual || consecutiveFailures.current >= 3)) {
          errorAnnounced.current = true;
          notify({
            kind: 'sync.error',
            title: 'Sync paused',
            body: 'We could not reach the server. Retrying automatically.',
          });
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) {
          setSyncing(false);
          setLoading(false);
        }
      }
    },
    [isAuthenticated, scope, announceChanges, notify]
  );

  const scheduleNext = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const failures = consecutiveFailures.current;
    const delay =
      failures === 0
        ? POLL_INTERVAL_MS
        : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);

    timer.current = setTimeout(async () => {
      // Polling in the background burns battery and data for updates nobody can
      // see; the foreground listener catches up the moment the app returns.
      if (AppState.currentState === 'active') {
        await runSync();
      }
      if (mounted.current) scheduleNext();
    }, delay);
  }, [runSync]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Signing out must reset everything, or the next user inherits the previous
  // one's baseline and gets a notification for every lead on their board.
  useEffect(() => {
    if (isAuthenticated) return;
    if (timer.current) clearTimeout(timer.current);
    previous.current = null;
    selfChanges.current.clear();
    consecutiveFailures.current = 0;
    errorAnnounced.current = false;
    setLeads([]);
    setError(null);
    setLastSyncedAt(null);
    setLoading(true);
  }, [isAuthenticated]);

  // Restart the loop whenever the identity or scope changes.
  useEffect(() => {
    if (!isAuthenticated) return;
    previous.current = null;
    setLoading(true);
    runSync();
    scheduleNext();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [isAuthenticated, scope, user?.id, runSync, scheduleNext]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const onChange = (state: AppStateStatus) => {
      // Coming back to the foreground is the moment the user most expects to
      // see current data, so sync immediately rather than waiting for the tick.
      if (state === 'active') runSync();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [isAuthenticated, runSync]);

  // ── Optimistic local mutations ─────────────────────────────────────────────

  const applyLocal = useCallback((leadId: string, patch: Partial<UnifiedLead>) => {
    markLocalChange(leadId);
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, ...patch } : l)));
    // Keep the diff baseline in step, otherwise the next poll reads the
    // optimistic change as a remote one and notifies the user about their own
    // action.
    const snap = previous.current?.get(leadId);
    if (snap) {
      previous.current!.set(leadId, {
        ...snap,
        status: (patch.status as string) ?? snap.status,
        assignedAgentId:
          patch.assignedAgentId !== undefined ? patch.assignedAgentId : snap.assignedAgentId,
        name: patch.name ?? snap.name,
      });
    }
  }, [markLocalChange]);

  const removeLocal = useCallback((leadId: string) => {
    markLocalChange(leadId);
    setLeads((prev) => prev.filter((l) => l.id !== leadId));
    previous.current?.delete(leadId);
  }, [markLocalChange]);

  const refresh = useCallback(() => runSync({ manual: true }), [runSync]);

  const value = useMemo<LeadSyncContextValue>(
    () => ({
      leads,
      loading,
      syncing,
      error,
      lastSyncedAt,
      scope,
      refresh,
      markLocalChange,
      applyLocal,
      removeLocal,
    }),
    [leads, loading, syncing, error, lastSyncedAt, scope, refresh, markLocalChange, applyLocal, removeLocal]
  );

  return <LeadSyncContext.Provider value={value}>{children}</LeadSyncContext.Provider>;
};

export const useLeadSync = () => useContext(LeadSyncContext);
