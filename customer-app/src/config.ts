// Point EXPO_PUBLIC_API_URL at the API gateway (port 8010). A physical device cannot reach the host's localhost,
// so use a LAN address. Customer Management is reached through the gateway's versioned route, the same one the
// customer web portal's server uses (customer-portal/lib/server/session.ts).
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://192.168.1.212:8010').replace(/\/$/, '');
export const CM_BASE = `${API_URL}/customer-management/v1`;

// "Fill demo data" buttons, as in the web portal (NEXT_PUBLIC_WALKIN_DEMO). On by default; set EXPO_PUBLIC_DEMO=false for production.
export const DEMO = process.env.EXPO_PUBLIC_DEMO !== 'false';
