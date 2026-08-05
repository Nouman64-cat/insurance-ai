import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii, typography, hitTarget } from '../theme/tokens';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { sendChatMessage, ChatMessage } from '../api/chat';
import { Screen, ScreenHeader, Text, Pressable, ConfirmDialog } from '../components/ui';

const newThreadId = () => Math.random().toString(36).slice(2, 9);

const WELCOME: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  text: "I'm your underwriting copilot. I can onboard applicants, run risk assessments, or pull up case details. What would you like to do?",
  quickActions: [
    { label: 'Add a customer', actionType: 'submit', payload: 'Add a new customer' },
    { label: 'Start underwriting', actionType: 'submit', payload: 'Start underwriting journey for a customer' },
    { label: 'Create a proposal', actionType: 'submit', payload: 'Create a proposal for a customer' },
    { label: 'Pending cases', actionType: 'submit', payload: 'Show me all pending cases' },
    { label: 'Run risk assessment', actionType: 'submit', payload: 'Run risk assessment' },
  ],
};

export default function ChatScreen() {
  const { colors, shadow } = useTheme();
  const { isCompact } = useResponsive();
  const { user } = useSession();

  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [threadId, setThreadId] = useState(newThreadId);
  const [confirmClear, setConfirmClear] = useState(false);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  // Guards the auto-scroll from firing after the screen unmounts mid-stream.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const scrollToEnd = useCallback(() => {
    // A frame's delay lets the new row lay out before we measure the offset.
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const send = useCallback(
    async (textToSend?: string) => {
      const query = (textToSend ?? input).trim();
      if (!query || sending) return;

      if (!textToSend) setInput('');

      const userMessage: ChatMessage = { id: `u_${Date.now()}`, role: 'user', text: query };
      const replyId = `a_${Date.now() + 1}`;
      const placeholder: ChatMessage = { id: replyId, role: 'assistant', text: '', isStreaming: true };

      setMessages((prev) => [...prev, userMessage, placeholder]);
      setSending(true);
      scrollToEnd();

      try {
        let accumulated = '';
        let actions: any[] | undefined;

        await sendChatMessage(
          query,
          threadId,
          (token) => {
            accumulated += token;
            if (!mounted.current) return;
            setMessages((prev) =>
              prev.map((m) => (m.id === replyId ? { ...m, text: accumulated } : m))
            );
          },
          (received) => {
            actions = received;
          }
        );

        if (!mounted.current) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? {
                  ...m,
                  text: accumulated || 'Done.',
                  isStreaming: false,
                  quickActions: actions,
                }
              : m
          )
        );
      } catch (err: any) {
        if (!mounted.current) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? {
                  ...m,
                  text: err?.message ?? 'Could not reach the copilot.',
                  isStreaming: false,
                  isError: true,
                }
              : m
          )
        );
      } finally {
        if (mounted.current) {
          setSending(false);
          scrollToEnd();
        }
      }
    },
    [input, sending, threadId, scrollToEnd]
  );

  const startNewThread = useCallback(() => {
    setThreadId(newThreadId());
    setMessages([WELCOME]);
    setConfirmClear(false);
  }, []);

  const renderMessage = ({ item }: { item: ChatMessage & { isError?: boolean } }) => {
    const isUser = item.role === 'user';
    const errored = !!item.isError;

    return (
      <View style={[styles.row, isUser ? styles.rowUser : styles.rowBot]}>
        {!isUser ? (
          <View
            style={[
              styles.avatar,
              {
                backgroundColor: errored ? colors.tone.danger.soft : colors.tone.accent.soft,
                borderColor: errored ? colors.tone.danger.softBorder : colors.tone.accent.softBorder,
              },
            ]}
          >
            <Ionicons
              name={errored ? 'alert-circle-outline' : 'chatbubble-ellipses-outline'}
              size={15}
              color={errored ? colors.tone.danger.on : colors.tone.accent.on}
            />
          </View>
        ) : null}

        <View style={[styles.bubbleColumn, isCompact ? styles.bubbleNarrow : styles.bubbleWide]}>
          <View
            style={[
              styles.bubble,
              isUser
                ? { backgroundColor: colors.tone.brand.solid, borderColor: 'transparent' }
                : {
                    backgroundColor: errored ? colors.tone.danger.soft : colors.surface,
                    borderColor: errored ? colors.tone.danger.softBorder : colors.border,
                  },
              isUser ? styles.bubbleUser : styles.bubbleBot,
              shadow(isUser ? 1 : 0),
            ]}
          >
            {item.text ? (
              <Text
                variant="body"
                style={
                  isUser
                    ? { color: colors.tone.brand.onSolid }
                    : errored
                    ? { color: colors.tone.danger.on }
                    : undefined
                }
              >
                {item.text}
              </Text>
            ) : item.isStreaming ? (
              <View style={styles.thinking}>
                <ActivityIndicator size="small" color={colors.tone.accent.solid} />
                <Text variant="callout" color="muted">
                  Thinking…
                </Text>
              </View>
            ) : null}
          </View>

          {item.quickActions && item.quickActions.length > 0 && !item.isStreaming ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              style={styles.chipsScroll}
            >
              {item.quickActions.map((action, index) => (
                <Pressable
                  key={`${item.id}_${index}`}
                  onPress={() => send(action.payload || action.label)}
                  disabled={sending}
                  pressedScale={0.95}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.tone.brand.softBorder,
                      opacity: sending ? 0.5 : 1,
                    },
                  ]}
                >
                  <Text variant="captionStrong" style={{ color: colors.tone.brand.on }}>
                    {action.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    );
  };

  const canSend = input.trim().length > 0 && !sending;

  return (
    <Screen
      scrollable={false}
      padded={false}
      header={
        <ScreenHeader
          title="Copilot"
          subtitle={sending ? 'Thinking…' : `Underwriting assistant for ${user?.fullName ?? 'you'}`}
          leading="menu"
          actions={[
            {
              icon: 'add-circle-outline',
              onPress: () => setConfirmClear(true),
              accessibilityLabel: 'Start a new conversation',
            },
          ]}
        />
      }
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        // Clears the bottom tab bar, which the keyboard otherwise overlaps.
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={scrollToEnd}
        />

        <View
          style={[
            styles.composer,
            { backgroundColor: colors.surface, borderTopColor: colors.border },
          ]}
        >
          <View
            style={[
              styles.inputWrap,
              { backgroundColor: colors.surfaceSunken, borderColor: colors.border },
            ]}
          >
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask the copilot…"
              placeholderTextColor={colors.textSubtle}
              style={[styles.input, typography.body, { color: colors.text }]}
              multiline
              // Caps growth at roughly five lines so the composer never eats
              // the conversation.
              maxLength={2000}
              editable={!sending}
              onSubmitEditing={() => send()}
              accessibilityLabel="Message the copilot"
            />
          </View>

          <Pressable
            onPress={() => send()}
            disabled={!canSend}
            pressedScale={0.92}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend, busy: sending }}
            style={[
              styles.sendButton,
              {
                backgroundColor: canSend ? colors.tone.brand.solid : colors.surfaceSunken,
              },
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Ionicons
                name="arrow-up"
                size={20}
                color={canSend ? colors.tone.brand.onSolid : colors.textSubtle}
              />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmClear}
        title="Start a new conversation?"
        message="The current thread will be cleared. Nothing you have already saved is affected."
        confirmLabel="Start new"
        icon="add-circle-outline"
        onConfirm={startNewThread}
        onCancel={() => setConfirmClear(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  list: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowBot: {
    justifyContent: 'flex-start',
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  bubbleColumn: {
    flexShrink: 1,
  },
  bubbleNarrow: {
    maxWidth: '84%',
  },
  bubbleWide: {
    maxWidth: 560,
  },
  bubble: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  // Squaring off the corner nearest the sender is what makes a bubble read as
  // pointing at its author.
  bubbleUser: {
    borderBottomRightRadius: radii.xs,
  },
  bubbleBot: {
    borderBottomLeftRadius: radii.xs,
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chipsScroll: {
    marginTop: spacing.sm,
  },
  chips: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputWrap: {
    flex: 1,
    borderRadius: radii.xl,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm,
    minHeight: hitTarget.comfortable,
    justifyContent: 'center',
  },
  input: {
    maxHeight: 120,
    padding: 0,
  },
  sendButton: {
    width: hitTarget.comfortable,
    height: hitTarget.comfortable,
    borderRadius: hitTarget.comfortable / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
