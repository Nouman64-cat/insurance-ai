import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onSignedOut } from '../api/client';
import * as authApi from '../api/auth';
import { clearSession, loadSession, Scope } from '../lib/tokens';

/**
 * Which app the person sees. It follows the stored session scope, which is the same rule the web portal's middleware uses
 * (customer-portal/middleware.ts): nobody → sign-in / walk-in start; walk_in → prospect screens only; pwd_change → forced
 * password change; full → the policyholder app.
 */
export type AuthState = 'loading' | 'signedOut' | 'passwordChange' | 'customer' | 'walkIn';

interface AuthContextValue {
  state: AuthState;
  /** Reads the stored session again (after a login, a first-password change, or a walk-in verification). */
  adopt: (scope: Scope) => void;
  signOut: () => Promise<void>;
  /** Set when the session ended on its own, so sign-in can say why. */
  expired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const fromScope = (s: Scope | undefined): AuthState =>
  s === 'full' ? 'customer' : s === 'pwd_change' ? 'passwordChange' : s === 'walk_in' ? 'walkIn' : 'signedOut';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>('loading');
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let alive = true;
    loadSession().then((s) => alive && setState(fromScope(s?.scope)));
    const off = onSignedOut(() => { setExpired(true); setState('signedOut'); });
    return () => { alive = false; off(); };
  }, []);

  const adopt = useCallback((scope: Scope) => { setExpired(false); setState(fromScope(scope)); }, []);

  const signOut = useCallback(async () => {
    const walkIn = state === 'walkIn';
    await authApi.logout(walkIn).catch(() => clearSession());
    setExpired(false);
    setState('signedOut');
  }, [state]);

  const value = useMemo(() => ({ state, adopt, signOut, expired }), [state, adopt, signOut, expired]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
