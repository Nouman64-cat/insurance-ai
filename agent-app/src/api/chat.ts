import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface QuickAction {
  label: string;
  actionType: string;
  payload: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  quickActions?: QuickAction[];
  isStreaming?: boolean;
  /** Set when the turn failed, so the bubble can render in the danger tone. */
  isError?: boolean;
}

export interface ChatInterrupt {
  kind: 'confirm' | 'clarify' | 'client_execute';
  question?: string;
  options?: string[];
  tool_call?: { name: string; args: any };
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onQuickActions?: (actions: QuickAction[]) => void;
  onInterrupt?: (interrupt: ChatInterrupt) => void;
  onError?: (message: string) => void;
}

const authHeaders = async () => {
  const token = await AsyncStorage.getItem('jwt_token');
  const tenantId = (await AsyncStorage.getItem('tenant_id')) || '00000000-0000-0000-0000-000000000001';
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': tenantId,
  };
};

/**
 * Parses the backend's SSE vocabulary (see services/chat-agent/routers/chat.py):
 * token, interrupt, action_completed, quick_actions, navigate, assessment,
 * step, error, done. Only the ones the mobile UI acts on are wired up here —
 * unhandled types (step, navigate, assessment, action_completed) are ignored
 * rather than silently breaking the parse.
 */
const consumeSSE = async (response: Response, callbacks: StreamCallbacks): Promise<void> => {
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const rawText = await response.text();
  const lines = rawText.split('\n\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;

    let json: any;
    try {
      json = JSON.parse(trimmed.slice(6));
    } catch {
      continue; // malformed chunk — skip rather than abort the whole turn
    }

    switch (json.type) {
      case 'token':
        if (json.content) callbacks.onToken(json.content);
        break;
      case 'quick_actions':
        if (json.actions && callbacks.onQuickActions) callbacks.onQuickActions(json.actions);
        break;
      case 'interrupt':
        callbacks.onInterrupt?.({
          kind: json.kind,
          question: json.question,
          options: json.options,
          tool_call: json.tool_call,
        });
        break;
      case 'error':
        callbacks.onError?.(json.message || 'Something went wrong.');
        break;
      default:
        break; // step / navigate / assessment / action_completed / done — no-op on mobile today
    }
  }
};

/** Starts a new conversation turn. */
export const sendChatMessage = async (
  message: string,
  threadId: string,
  callbacks: StreamCallbacks
): Promise<void> => {
  const role = (await AsyncStorage.getItem('user_role')) || 'Agent';
  const headers = await authHeaders();
  const baseURL = api.defaults.baseURL;

  const response = await fetch(`${baseURL}/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_id: threadId, message, role, platform: 'mobile' }),
  });

  await consumeSSE(response, callbacks);
};

/**
 * Answers a paused interrupt (confirm/clarify/client_execute) and continues
 * the same turn. Every mutating tool pauses here first — without this, the
 * graph never gets past "Ready to X — proceed?" and the turn looks stuck.
 */
export const resumeChatThread = async (
  resumeValue: any,
  threadId: string,
  callbacks: StreamCallbacks
): Promise<void> => {
  const headers = await authHeaders();
  const baseURL = api.defaults.baseURL;

  const response = await fetch(`${baseURL}/chat/resume`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_id: threadId, resume_value: resumeValue }),
  });

  await consumeSSE(response, callbacks);
};
