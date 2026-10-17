export type VoiceStatus = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
export interface Caption { id: string; role: 'user' | 'agent'; text: string }
export interface PlatformReply {
  message: string;
  pending?: 'confirm' | 'clarify' | 'client_execute';
  options?: string[];
  error?: string;
}

// Only unambiguous standalone consent can resume a pending mutation. Questions
// and phrases such as "yes, but don't delete it" must never become approval.
export function confirmationAnswer(text: string): 'Yes' | 'Cancel' | null {
  const value = text.trim().toLowerCase().replace(/[.!؟?،,۔]+$/g, '').trim();
  if (['yes', 'confirm', 'yes please', 'go ahead', 'proceed', 'جی', 'جی ہاں', 'ہاں'].includes(value)) return 'Yes';
  if (['no', 'cancel', 'stop', 'نہیں', 'منسوخ', 'رکیں'].includes(value)) return 'Cancel';
  return null;
}

export function describeVoiceError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow microphone access, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found. Connect a microphone and retry.';
  if (name === 'NotReadableError') return 'The microphone is in use by another application. Close it and retry.';
  return error instanceof Error ? error.message : 'Voice connection failed. Please retry.';
}
