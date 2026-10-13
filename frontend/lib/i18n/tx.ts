import { DEFAULT_LOCALE, Locale, localeDir } from "./config";
import en from "./messages/en";
import ur from "./messages/ur";

// The active UI language, for code that is not a React component or would rather not take a hook (page text, toasts,
// confirm() prompts). I18nProvider sets it while rendering, before any page renders; switching language reloads
// the page, so everything is drawn again in the new language.
let current: Locale = DEFAULT_LOCALE;

export function setCurrentLocale(locale: Locale): void {
  current = locale;
}

// The Urdu page text (messages/ur-text.ts) is ~110 KB compressed, so it is not part of the client bundle: the root
// layout loads it on the server only when the language is Urdu and hands it to I18nProvider, which registers it here
// before any page renders. English pages never download it.
let urText: Record<string, string> = {};

export function setUrduText(dictionary: Record<string, string>): void {
  urText = dictionary;
}

export function currentLocale(): Locale {
  return current;
}

export type Vars = Record<string | number, unknown>;

const MESSAGES = { en, ur };

function lookup(messages: unknown, key: string): string | undefined {
  const value = key.split(".").reduce<any>((node, part) => (node == null ? undefined : node[part]), messages);
  return typeof value === "string" ? value : undefined;
}

/** Fills {name} placeholders. With `isolate`, each value is wrapped in a bidi isolate, so a value with its own
 *  direction (an English name ending in "Ltd.") keeps its punctuation in place inside right-to-left text. */
function fill(text: string, vars?: Vars, isolate = false): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in vars)) return match;
    return isolate ? `⁨${vars[name]}⁩` : String(vars[name]);
  });
}

/** Each paragraph takes its direction from its first letter (globals.css), so an Urdu string that opens with a
 *  Latin word ("LLM کنفیگریشن") would be laid out left-to-right: a leading right-to-left mark prevents that. */
function marked(text: string): string {
  return localeDir(current) === "rtl" ? `‏${text}` : text;
}

/** Text for a dotted key ("sidebar.logout") from messages/en.ts and ur.ts. Falls back to English. */
export function t(key: string, vars?: Vars): string {
  return marked(fill(lookup(MESSAGES[current], key) ?? lookup(en, key) ?? key, vars, localeDir(current) === "rtl"));
}

/**
 * Page text, looked up by its English wording ("Advanced Filters", "{count} plan(s) selected") in
 * messages/ur-text.ts. Wording with no translation yet is returned as it is, so it still reads as English.
 */
export function tx(text: string, vars?: Vars): string {
  // Labels looked up from a map (tx(LABELS[code])) can be missing for an unknown code: render nothing, don't throw.
  if (typeof text !== "string") return text == null ? "" : String(text);
  const translated = current === "ur" ? urText[text.trim()] : undefined;
  return translated === undefined ? fill(text, vars) : marked(fill(translated, vars, true));
}
