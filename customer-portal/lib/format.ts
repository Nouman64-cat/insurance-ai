import type { Locale } from "./i18n/config";

// Digits stay Latin in both languages (as on the rest of the platform); month names and grouping follow the language.
const NUM = "en-PK";
const dateLocale = (l: Locale) => (l === "ur" ? "ur-PK-u-nu-latn" : "en-GB");

export function money(value: number | null | undefined, _locale?: Locale): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `PKR ${new Intl.NumberFormat(NUM, { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

export function moneyExact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `PKR ${new Intl.NumberFormat(NUM, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

export function compactMoney(value: number | null | undefined): string {
  if (value == null) return "—";
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return `PKR ${(value / 10_000_000).toFixed(2).replace(/\.?0+$/, "")} Cr`;
  if (abs >= 100_000) return `PKR ${(value / 100_000).toFixed(2).replace(/\.?0+$/, "")} Lac`;
  return money(value);
}

export function date(value: string | null | undefined, locale: Locale = "en"): string {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(dateLocale(locale), { day: "numeric", month: "short", year: "numeric" }).format(d);
}

export function dateTime(value: string | null | undefined, locale: Locale = "en"): string {
  if (!value) return "—";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;   // the API sends UTC without a zone suffix
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(dateLocale(locale), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function initials(name: string | null | undefined): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** A fresh key per user action; reused for retries of the same action so a repeat can never be processed twice. */
export function newIdempotencyKey(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  return c?.randomUUID ? c.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
