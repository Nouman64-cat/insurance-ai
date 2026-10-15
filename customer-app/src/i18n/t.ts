import { messages } from './messages';

/** t('walkin.status.submitted', { date }) – the portal's wording, with {placeholder} substitution. Unknown keys return the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = messages[key];
  if (s === undefined) return key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`)) : s;
}
