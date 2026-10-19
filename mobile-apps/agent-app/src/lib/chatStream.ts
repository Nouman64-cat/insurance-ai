/** Text is keyed by the backend message id so final snapshots replace deltas. */
export interface ChatTextState {
  order: string[];
  messages: Record<string, string>;
}
export interface ChatTextEvent {
  type: string;
  message_id?: string;
  content?: string;
  delta?: boolean;
}
export const emptyChatText = (): ChatTextState => ({ order: [], messages: {} });
export const chatText = (state: ChatTextState): string => state.order.map((id) => state.messages[id]).filter(Boolean).join('\n\n');

export function applyChatTextEvent(state: ChatTextState, event: ChatTextEvent): ChatTextState {
  const id = event.message_id || '__legacy__';
  if (event.type === 'message_discard') {
    const messages = { ...state.messages };
    delete messages[id];
    return { order: state.order.filter((key) => key !== id), messages };
  }
  if (event.type !== 'token' || typeof event.content !== 'string') return state;
  return {
    order: state.order.includes(id) ? state.order : [...state.order, id],
    messages: { ...state.messages, [id]: event.delta === false ? event.content : (state.messages[id] || '') + event.content },
  };
}

/** Handles LF/CRLF framing and optional spaces after the SSE data field. */
export function parseChatEvents(raw: string): any[] {
  return raw.replace(/\r\n/g, '\n').split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return [];
    try {
      const event = JSON.parse(data);
      return event && typeof event === 'object' && !Array.isArray(event) ? [event] : [];
    } catch { return []; }
  });
}
