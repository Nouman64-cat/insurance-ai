// The currency money is SHOWN in, one choice for the whole studio. Money is recorded once, in US dollars; this only changes how a figure reads. Single figures use the rate in force today
// (the Costs & Budgets charts convert each day at that day's own rate and say so). No React in here except the subscription hook, so the integration test can drive it.
import { useSyncExternalStore } from "react";

export interface Display { currency: string; rates: Record<string, number> }          // rates: units per US dollar, in force today, by currency code
const KEY = "evalCostsCurrency";
let state: Display = { currency: "USD", rates: {} };
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try { const c = window.localStorage.getItem(KEY); if (c && /^[A-Z]{3}$/.test(c)) state = { ...state, currency: c }; } catch { /* no storage: the choice is simply not remembered */ }
}

/** The current choice, with a currency that has no recorded rate treated as US dollars (nothing is ever converted at a guessed rate). */
export function getDisplay(): { currency: string; rate: number | null } {
  start();
  const rate = state.currency !== "USD" ? state.rates[state.currency] ?? null : null;
  return rate === null ? { currency: "USD", rate: null } : { currency: state.currency, rate };
}
export function chosenCurrency(): string { start(); return state.currency; }
export function setRates(rates: Record<string, number>): void { state = { ...state, rates }; emit(); }
export function setCurrency(code: string): void {
  start();
  const c = code.toUpperCase();
  state = { ...state, currency: c };
  try { window.localStorage.setItem(KEY, c); } catch { /* private window */ }
  emit();
}
export function resetDisplay(): void { state = { currency: "USD", rates: {} }; started = true; emit(); }
export const subscribeDisplay = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Re-renders a component when the choice or the rates change. */
export function useDisplayCurrency(): Display {
  return useSyncExternalStore(subscribeDisplay, () => { start(); return state; }, () => state);
}

/** How an amount in the chosen currency reads: tiny sums keep decimals, large rupee sums have none. */
export function formatIn(amount: number, currency: string): string {
  if (currency === "USD") return amount === 0 ? "$0" : Math.abs(amount) < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (amount === 0) return `0 ${currency}`;
  return Math.abs(amount) >= 100 ? `${Math.round(amount).toLocaleString("en-US")} ${currency}` : `${amount.toFixed(2)} ${currency}`;
}

/** A US-dollar amount as it should be shown now: in the chosen currency at today's rate, or in dollars when no rate is recorded. Unknown stays unknown. */
export function showUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return "unknown";
  const d = getDisplay();
  return d.rate === null ? formatIn(usd, "USD") : formatIn(usd * d.rate, d.currency);
}
