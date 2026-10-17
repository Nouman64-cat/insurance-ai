import * as SecureStore from 'expo-secure-store';

/**
 * Customer sessions. Tokens live in the OS keychain/keystore (expo-secure-store), never in AsyncStorage.
 *
 *  - `full`       signed-in policyholder (access + rotating refresh token)
 *  - `pwd_change` temporary password still in place: only the password-change calls are accepted
 *  - `walk_in`    email-verified prospect: access token only, no refresh token, ~2 h life
 *
 * A walk-in token is a different audience from a policyholder token; they are never mixed.
 */
export type Scope = 'full' | 'pwd_change' | 'walk_in';

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  scope: Scope;
}

const K_ACCESS = 'cm_access';
const K_REFRESH = 'cm_refresh';
const K_SCOPE = 'cm_scope';

let cache: Session | null = null;
let loaded = false;

export async function loadSession(): Promise<Session | null> {
  if (loaded) return cache;
  try {
    const [accessToken, refreshToken, scope] = await Promise.all([
      SecureStore.getItemAsync(K_ACCESS),
      SecureStore.getItemAsync(K_REFRESH),
      SecureStore.getItemAsync(K_SCOPE),
    ]);
    cache = accessToken && scope ? { accessToken, refreshToken, scope: scope as Scope } : null;
  } catch {
    cache = null; // keystore unavailable or corrupted: behave as signed out
  }
  loaded = true;
  return cache;
}

export function currentSession(): Session | null {
  return cache;
}

export async function saveSession(s: Session): Promise<void> {
  cache = s;
  loaded = true;
  await Promise.all([
    SecureStore.setItemAsync(K_ACCESS, s.accessToken),
    SecureStore.setItemAsync(K_SCOPE, s.scope),
    s.refreshToken ? SecureStore.setItemAsync(K_REFRESH, s.refreshToken) : SecureStore.deleteItemAsync(K_REFRESH),
  ]);
}

export async function clearSession(): Promise<void> {
  cache = null;
  loaded = true;
  await Promise.all([K_ACCESS, K_REFRESH, K_SCOPE].map((k) => SecureStore.deleteItemAsync(k).catch(() => undefined)));
}
