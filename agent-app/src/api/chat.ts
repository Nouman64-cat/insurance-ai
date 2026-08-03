import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  quickActions?: Array<{ label: string; actionType: string; payload: string }>;
  isStreaming?: boolean;
}

export const sendChatMessage = async (
  message: string,
  threadId: string,
  onToken: (token: string) => void,
  onQuickActions?: (actions: any[]) => void
): Promise<string> => {
  const token = await AsyncStorage.getItem('jwt_token');
  const tenantId = await AsyncStorage.getItem('tenant_id') || '00000000-0000-0000-0000-000000000001';
  const role = await AsyncStorage.getItem('user_role') || 'Agent';

  // Get base URL from api instance defaults
  const baseURL = api.defaults.baseURL;

  const response = await fetch(`${baseURL}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
    body: JSON.stringify({
      thread_id: threadId,
      message,
      role,
    }),
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const rawText = await response.text();
  let fullResponse = '';

  const lines = rawText.split('\n\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ')) {
      try {
        const json = JSON.parse(trimmed.slice(6));
        if (json.type === 'token' && json.content) {
          fullResponse += json.content;
          onToken(json.content);
        } else if (json.type === 'quick_actions' && json.actions && onQuickActions) {
          onQuickActions(json.actions);
        }
      } catch (e) {
        // Skip malformed chunk
      }
    }
  }

  return fullResponse || 'Action completed.';
};
