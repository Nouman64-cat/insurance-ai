import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { login as apiLogin, logout as apiLogout } from '../api/auth';
import { onUnauthorized } from '../api/api';
import { invalidateAgentDirectory } from '../api/leads';

/**
 * Roles the backend assigns (see tenant-service `routers/auth.py`). Anything
 * unrecognised is treated as an Agent — the least-privileged view — so a new
 * backend role can never accidentally widen what the app shows.
 */
export type UserRole = 'Admin' | 'SuperAdmin' | 'Underwriter' | 'Agent';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  tenantId: string;
}

interface SessionContextValue {
  user: SessionUser | null;
  /** True until the persisted session has been read from storage. */
  initialising: boolean;
  isAuthenticated: boolean;
  /**
   * Whether this user sees every lead in the tenant, or only their own.
   * Drives both the API query and what the notification feed subscribes to.
   */
  canSeeAllLeads: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const STORAGE_KEYS = ['jwt_token', 'tenant_id', 'user_email', 'user_role', 'agent_id', 'agent_name'];

const SessionContext = createContext<SessionContextValue>({
  user: null,
  initialising: true,
  isAuthenticated: false,
  canSeeAllLeads: false,
  signIn: async () => {},
  signOut: async () => {},
});

const normaliseRole = (raw: string | null | undefined): UserRole => {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'admin':
      return 'Admin';
    case 'superadmin':
    case 'super admin':
      return 'SuperAdmin';
    case 'underwriter':
      return 'Underwriter';
    default:
      return 'Agent';
  }
};

/** Admins and underwriters work the whole tenant; agents work their own book. */
export const roleSeesAllLeads = (role: UserRole) => role !== 'Agent';

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [initialising, setInitialising] = useState(true);

  const hydrate = useCallback(async () => {
    const entries = await AsyncStorage.multiGet(STORAGE_KEYS);
    const map = Object.fromEntries(entries) as Record<string, string | null>;

    // A token without a tenant is unusable against every tenant-scoped
    // endpoint, so treat that as signed out rather than half-authenticated.
    if (!map.jwt_token || !map.tenant_id) {
      setUser(null);
      return;
    }

    setUser({
      id: map.agent_id ?? '',
      email: map.user_email ?? '',
      fullName: map.agent_name || map.user_email || 'Agent',
      role: normaliseRole(map.user_role),
      tenantId: map.tenant_id,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    hydrate()
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setInitialising(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // A rejected token has already been cleared from storage by the interceptor;
  // dropping the in-memory user is what actually returns the app to login.
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      // `apiLogin` writes the credentials to storage; re-reading them keeps a
      // single source of truth for how a session is shaped.
      await apiLogin(email, password);
      // The previous user's directory cache would otherwise leak across tenants.
      invalidateAgentDirectory();
      await hydrate();
    },
    [hydrate]
  );

  const signOut = useCallback(async () => {
    // Clear local state first so the UI never renders a stale session while the
    // storage write is still in flight.
    setUser(null);
    invalidateAgentDirectory();
    await apiLogout();
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      initialising,
      isAuthenticated: !!user,
      canSeeAllLeads: user ? roleSeesAllLeads(user.role) : false,
      signIn,
      signOut,
    }),
    [user, initialising, signIn, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = () => useContext(SessionContext);
