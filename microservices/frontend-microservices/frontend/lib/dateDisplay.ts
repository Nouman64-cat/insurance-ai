/** Consistent user-facing dates; ISO values used by forms and APIs stay unchanged. */
export function displayDate(value: string | number | Date | null | undefined, options: Intl.DateTimeFormatOptions = {}): string {
  if (value == null || value === '') return '—';
  const parsed = value instanceof Date ? value : new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00' : value);
  if (Number.isNaN(parsed.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: options.timeZone }).formatToParts(parsed);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const date = part('day') + ' ' + part('month') + ', ' + part('year');
  if (options.hour || options.minute || options.timeStyle) {
    return date + ' · ' + parsed.toLocaleTimeString('en-GB', { hour: options.hour ?? '2-digit', minute: options.minute ?? '2-digit', second: options.second, hour12: options.hour12, timeZone: options.timeZone });
  }
  return date;
}
export function displayDateTime(value: string | number | Date | null | undefined, options: Intl.DateTimeFormatOptions = {}): string {
  return displayDate(value, { hour: '2-digit', minute: '2-digit', ...options });
}
