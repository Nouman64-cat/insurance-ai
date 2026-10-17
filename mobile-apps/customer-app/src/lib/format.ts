// Same output as customer-portal/lib/format.ts and dateDisplay.ts.
export function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `PKR ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

export function compactMoney(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return `PKR ${(value / 10_000_000).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (abs >= 100_000) return `PKR ${(value / 100_000).toFixed(2).replace(/\.?0+$/, '')} Lac`;
  return money(value);
}

function parts(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(d);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  return `${get('day')} ${get('month')}, ${get('year')}`;
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? '—' : parts(d);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`; // the API sends UTC without a zone suffix
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${parts(d)} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/** The customer's own calendar date as YYYY-MM-DD (not UTC). */
export function localISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function newIdempotencyKey(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const rnd = () => Math.random().toString(36).slice(2, 12);
  return `k${Date.now().toString(36)}${rnd()}${rnd()}`;
}

export function initials(name: string | null | undefined): string {
  return (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
}

/** A translation if the key exists, else the raw value (labels the backend may add later). */
export function tOr(t: (k: string, v?: any) => string, key: string, fallback: string | null | undefined): string {
  const s = t(key);
  return s !== key ? s : fallback || '—';
}
