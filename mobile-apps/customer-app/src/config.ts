import { NativeModules } from 'react-native';

const GATEWAY_PORT = 8010;

/**
 * In development the phone loaded this app from the Metro server on the developer's computer, and the API gateway runs on that
 * same computer. React Native knows the Metro address (the URL the JavaScript bundle came from), so use its host: the API address
 * then never goes stale when the computer's IP changes, and nothing has to be typed. Returns null in a release build.
 */
function metroHost(): string | null {
  try {
    const rn: any = require('react-native');
    const scriptURL: string | undefined =
      rn.TurboModuleRegistry?.get?.('SourceCode')?.getConstants?.()?.scriptURL ?? (NativeModules as any).SourceCode?.scriptURL;
    const m = scriptURL?.match(/^https?:\/\/([^:/]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const detected = metroHost();

/**
 * The API gateway. EXPO_PUBLIC_API_URL wins when set (a deployed backend, or a gateway on another machine). Otherwise the
 * development computer's address, found automatically. A physical phone cannot reach "localhost", which is why a fixed address
 * would not work.
 */
// An address with no host in it (for example "http://:8010", which is what a shell gives when the IP variable was never set) is
// ignored, so a typo in the start command cannot break the app: it falls back to the automatic address.
const fromEnv = (process.env.EXPO_PUBLIC_API_URL || '').trim();
const envUsable = /^https?:\/\/[^\s/:]+(:\d{1,5})?(\/.*)?$/i.test(fromEnv);

export const API_URL = (envUsable ? fromEnv : `http://${detected ?? 'localhost'}:${GATEWAY_PORT}`).replace(/\/$/, '');

// Customer Management is reached through the gateway's versioned route, the same one the customer web portal's server uses
// (customer-portal/lib/server/session.ts).
export const CM_BASE = `${API_URL}/customer-management/v1`;

// "Fill demo data" buttons, as in the web portal (NEXT_PUBLIC_WALKIN_DEMO). On by default; set EXPO_PUBLIC_DEMO=false for production.
export const DEMO = process.env.EXPO_PUBLIC_DEMO !== 'false';
