import type { QuickAction } from "./types";

// Actions that only show or fetch something — download a report, open a page
// or the inline case view, upload a document — rather than move the workflow.
// Picking one of a message's buttons normally locks the rest of the group (the
// choice is made); these are exempt both ways: clicking them never locks the
// group, and they stay usable after a real choice has been made.
const PASSIVE_TYPES: ReadonlySet<QuickAction["actionType"]> = new Set<QuickAction["actionType"]>(["download", "navigate", "embed", "upload"]);

export const isPassiveAction = (action: QuickAction): boolean => PASSIVE_TYPES.has(action.actionType);
