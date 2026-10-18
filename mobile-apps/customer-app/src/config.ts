// Use the deployed gateway by default; development builds may configure another backend.
const fromEnv = (process.env.EXPO_PUBLIC_API_URL || '').trim();
const envUsable = /^https?:\/\/[^\s/:]+(:\d{1,5})?(\/.*)?$/i.test(fromEnv);

export const API_URL = (envUsable ? fromEnv : 'https://api.getinsuredai.com').replace(/\/+$/, '');

// Customer Management is reached through the gateway's versioned route, the same one the customer web portal's server uses
// (customer-portal/lib/server/session.ts).
export const CM_BASE = `${API_URL}/customer-management/v1`;

// "Fill demo data" buttons, as in the web portal (NEXT_PUBLIC_WALKIN_DEMO). On by default; set EXPO_PUBLIC_DEMO=false for production.
export const DEMO = process.env.EXPO_PUBLIC_DEMO !== 'false';
