// Saved views of the Evaluation Studio: a name for a page the way it looked (the mode, the filters, the window, the open item), kept in this browser. They are a personal convenience, not
// shared state: nothing here is sent anywhere, and a browser that blocks storage simply has none. Every read and write is guarded, so the page works without them.
import { STUDIO_ROOT } from "@/lib/evalStudio";

export interface SavedView { name: string; href: string; saved_at: string }
export const VIEWS_KEY = "studioSavedViews";
export const MAX_VIEWS = 20;

/** Only an address inside the studio can be saved or opened: a stored value is never trusted to be one. */
export const isStudioHref = (href: unknown): href is string => typeof href === "string" && (href === STUDIO_ROOT || href.startsWith(`${STUDIO_ROOT}?`));

export function parseViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is SavedView => !!x && typeof x.name === "string" && x.name.trim() !== "" && isStudioHref(x.href) && typeof x.saved_at === "string").slice(0, MAX_VIEWS);
  } catch { return []; }
}

/** The list with this view added; a name already used is replaced, the newest first, and no more than MAX_VIEWS are kept. */
export function withView(list: SavedView[], name: string, href: string, now = new Date()): SavedView[] {
  const clean = name.trim().slice(0, 60);
  if (!clean || !isStudioHref(href)) return list;
  return [{ name: clean, href, saved_at: now.toISOString() }, ...list.filter((v) => v.name.toLowerCase() !== clean.toLowerCase())].slice(0, MAX_VIEWS);
}
export const withoutView = (list: SavedView[], name: string): SavedView[] => list.filter((v) => v.name !== name);

export function loadViews(): SavedView[] {
  try { return parseViews(window.localStorage.getItem(VIEWS_KEY)); } catch { return []; }
}
/** False when the browser would not store them (private window, blocked site data): the caller says so rather than pretending. */
export function storeViews(list: SavedView[]): boolean {
  try { window.localStorage.setItem(VIEWS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
