import type { QuickAction } from "./types";

// Actions that only show or fetch something — download a report, open a page
// or the inline case view, upload a document — rather than move the workflow.
// Picking one of a message's buttons normally locks the rest of the group (the
// choice is made); these are exempt both ways: clicking them never locks the
// group, and they stay usable after a real choice has been made.
const PASSIVE_TYPES: ReadonlySet<QuickAction["actionType"]> = new Set<QuickAction["actionType"]>(["download", "navigate", "embed", "upload", "family_report"]);

export const isPassiveAction = (action: QuickAction): boolean => PASSIVE_TYPES.has(action.actionType);

// A reply that asks for a date in prose ("What is the date of death? Please use
// YYYY-MM-DD") without calling a tool has no picker of its own; offer one so the
// date is picked, not typed. Past events can't be in the future, so those are capped at today.
const ASKS_FOR_DATE = /yyyy-mm-dd|\b(?:what|which)\s+(?:is|was)\s+the\s+(?:[\w-]+\s+){0,3}date\b|\bwhen\s+did\b[^?]*\?/i;
const PAST_EVENT = /death|incident|event|accident|admission|birth|loss|injury/i;

export function dateAskAction(text: string | undefined): QuickAction | null {
  if (!text || !ASKS_FOR_DATE.test(text)) return null;
  const named = text.match(/\b((?:[\w-]+\s+)?date(?:\s+of\s+[\w-]+)?)\b/i)?.[1];
  const label = named && !/^(?:the|a|this|that|valid)\s/i.test(named)
    ? named.charAt(0).toUpperCase() + named.slice(1).toLowerCase()
    : text.match(/\bdate\s+of\s+[\w-]+/i)?.[0].replace(/^d/, "D") ?? "Date";
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return {
    label,
    actionType: "date",
    payload: `${label}: {value}`,
    ...(PAST_EVENT.test(text) ? { max: today } : {}),
  };
}
