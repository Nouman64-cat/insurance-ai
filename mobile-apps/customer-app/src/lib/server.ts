import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL as DEFAULT_URL } from '../config';

/**
 * Which API gateway the app talks to. Normally that is the address worked out in config.ts. While developing, it can be overridden
 * from the sign-in screens ("Check connection"), so a wrong or changed computer address never needs a restart of Metro or a rebuild.
 * The override is only read in development builds; a release build always uses its configured address.
 */
const KEY = 'dev_api_url';
let override: string | null = null;
let loaded = false;

export async function loadServerOverride(): Promise<void> {
  if (loaded) return;
  loaded = true;
  if (!__DEV__) return;
  try { override = (await AsyncStorage.getItem(KEY)) || null; } catch { override = null; }
}

export const getApiUrl = (): string => override ?? DEFAULT_URL;
export const getCmBase = (): string => `${getApiUrl()}/customer-management/v1`;
export const hasServerOverride = (): boolean => override !== null;
export const defaultApiUrl = DEFAULT_URL;

/** Accepts "192.168.18.85", "192.168.18.85:8010" or a full http(s) URL; returns a clean origin or null if it is not usable. */
export function normalizeServerUrl(input: string): string | null {
  let v = input.trim().replace(/\/+$/, '');
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  if (!/^https?:\/\/[^\s/:]+(:\d{1,5})?$/i.test(v)) return null;
  if (!/:\d{1,5}$/.test(v)) v += ':8010';
  return v;
}

export async function setServerOverride(url: string | null): Promise<void> {
  override = url;
  try { url ? await AsyncStorage.setItem(KEY, url) : await AsyncStorage.removeItem(KEY); } catch { /* kept in memory for this run */ }
}
