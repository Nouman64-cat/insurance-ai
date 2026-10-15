import { ApiError } from '../api/client';
import { messages } from './messages';

/** Same lookup as the web portal's errorText(): by backend error code, with a generic fallback. */
export function errorText(e: unknown): string {
  const code = (e as ApiError | undefined)?.code;
  if (code && messages[`error.${code}`]) return messages[`error.${code}`];
  return messages['error.generic'] ?? 'Something went wrong. Please try again.';
}

export function passwordProblems(e: unknown): string[] {
  const p = (e as ApiError | undefined)?.details?.problems;
  return Array.isArray(p) ? p.map((c: string) => messages[`password.problem.${c}`] ?? c) : [];
}
