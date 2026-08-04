import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { sendChatMessage, ChatMessage } from '../api/chat';

const DEFAULT_WELCOME: ChatMessage = {
  id: 'welcome-1',
  role: 'assistant',
  text: 'Hello! I am your AI Underwriting Copilot. I can help you onboard applicants, run risk assessments, or check case details. What would you like to do today?',
  quickActions: [
    { label: 'Add a customer', actionType: 'submit', payload: 'Add a new customer' },
    { label: 'Start underwriting', actionType: 'submit', payload: 'Start underwriting journey for a customer' },
    { label: 'Create a proposal', actionType: 'submit', payload: 'Create a proposal for a customer' },
    { label: 'Check pending cases', actionType: 'submit', payload: 'Show me all pending cases' },
    { label: 'Run risk assessment', actionType: 'submit', payload: 'Run risk assessment' },
    { label: 'Test with demo data', actionType: 'submit', payload: 'Test the full workflow with demo data' },
  ],
};

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([DEFAULT_WELCOME]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [threadId, setThreadId] = useState(() => Math.random().toString(36).substring(2, 9));
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    flatListRef.current?.scrollToEnd({ animated: true });
  }, [messages, loading]);

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend || input).trim();
    if (!query || loading) return;

    if (!textToSend) setInput('');

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: query,
    };

    const assistantMsgId = (Date.now() + 1).toString();
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setLoading(true);

    try {
      let accumulated = '';
      let receivedActions: any[] | undefined = undefined;

      await sendChatMessage(
        query,
        threadId,
        (token) => {
          accumulated += token;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId ? { ...msg, text: accumulated } : msg
            )
          );
        },
        (actions) => {
          receivedActions = actions;
        }
      );

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
              ...msg,
              text: accumulated || 'Request processed successfully.',
              isStreaming: false,
              quickActions: receivedActions,
            }
            : msg
        )
      );
    } catch (err: any) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
              ...msg,
              text: `⚠️ Error: ${err.message || 'Could not connect to AI Copilot.'}`,
              isStreaming: false,
            }
            : msg
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setThreadId(Math.random().toString(36).substring(2, 9));
    setMessages([DEFAULT_WELCOME]);
  };

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.msgWrapper, isUser ? styles.userMsgWrapper : styles.botMsgWrapper]}>
        {!isUser && (
          <View style={styles.avatar}>
            <Ionicons name="sparkles" size={16} color="#ffffff" />
          </View>
        )}
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.botBubble]}>
          <Text style={[styles.msgText, isUser ? styles.userMsgText : styles.botMsgText]}>
            {item.text || (item.isStreaming ? 'Thinking...' : '')}
          </Text>

          {item.isStreaming && !item.text && (
            <ActivityIndicator size="small" color="#1d4ed8" style={{ marginTop: 4 }} />
          )}

          {item.quickActions && item.quickActions.length > 0 && !item.isStreaming && (
            <View style={styles.quickActionsContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {item.quickActions.map((action, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.actionChip}
                    onPress={() => handleSend(action.payload || action.label)}
                  >
                    <Text style={styles.actionChipText}>{action.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <View style={styles.headerIcon}>
            <Ionicons name="chatbubbles" size={20} color="#1d4ed8" />
          </View>
          <View>
            <Text style={styles.title}>AI Copilot</Text>
            <Text style={styles.subtitle}>Underwriting & Case Assistant</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
          <Ionicons name="refresh-outline" size={20} color="#64748b" />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        />

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="Ask AI Copilot..."
            placeholderTextColor="#94a3b8"
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => handleSend()}
            returnKeyType="send"
            editable={!loading}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
            onPress={() => handleSend()}
            disabled={!input.trim() || loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Ionicons name="send" size={18} color="#ffffff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
  },
  clearBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 16,
  },
  msgWrapper: {
    flexDirection: 'row',
    marginVertical: 4,
    maxWidth: '85%',
  },
  userMsgWrapper: {
    alignSelf: 'flex-end',
    justifyContent: 'flex-end',
  },
  botMsgWrapper: {
    alignSelf: 'flex-start',
    gap: 8,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1d4ed8',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  bubble: {
    borderRadius: 16,
    padding: 12,
  },
  userBubble: {
    backgroundColor: '#1d4ed8',
    borderBottomRightRadius: 4,
  },
  botBubble: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderBottomLeftRadius: 4,
  },
  msgText: {
    fontSize: 15,
    lineHeight: 22,
  },
  userMsgText: {
    color: '#ffffff',
  },
  botMsgText: {
    color: '#1e293b',
  },
  quickActionsContainer: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  actionChip: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  actionChipText: {
    color: '#1d4ed8',
    fontSize: 13,
    fontWeight: '600',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#f1f5f9',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0f172a',
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1d4ed8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: '#94a3b8',
  },
});
