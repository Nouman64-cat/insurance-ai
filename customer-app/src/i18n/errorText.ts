import { ApiError } from '../api/client';
import { getCmBase } from '../lib/server';
import { messages } from './messages';

/** Same lookup as the web portal's errorText(): by backend error code, with a generic fallback. */
export function errorText(e: unknown): string {
  const code = (e as ApiError | undefined)?.code;
  // A timeout reads as the same thing to the customer as no connection.
  const key = code === 'TIMEOUT' ? 'NETWORK' : code;
  let text = (key && messages[`error.${key}`]) || messages['error.generic'] || 'Something went wrong. Please try again.';
  // While developing, say which address was tried: a wrong or stale server address is the usual cause of "cannot reach the server".
  if (__DEV__ && key === 'NETWORK') text += `\n(${getCmBase()})`;
  return text;
}

export function passwordProblems(e: unknown): string[] {
  const p = (e as ApiError | undefined)?.details?.problems;
  return Array.isArray(p) ? p.map((c: string) => messages[`password.problem.${c}`] ?? c) : [];
}
