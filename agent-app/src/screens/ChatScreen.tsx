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
import * as Clipboard from 'expo-clipboard';
import { useNavigation, useRoute, RouteProp, CompositeNavigationProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii, typography, hitTarget } from '../theme/tokens';
import { useResponsive } from '../hooks/useResponsive';
import { useSession } from '../context/SessionContext';
import { useNotifications } from '../notifications/NotificationContext';
import { sendChatMessage, resumeChatThread, ChatMessage, ChatInterrupt, QuickAction } from '../api/chat';
import { Screen, ScreenHeader, Text, Pressable, ConfirmDialog } from '../components/ui';
import { RootStackParamList, MainTabParamList } from '../navigation/AppNavigator';

type ChatNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Chat'>,
  NativeStackNavigationProp<RootStackParamList>
>;

// Splits message text on URLs so each link can be rendered as its own
// tappable-to-copy span instead of being stuck inside unselectable body text.
// (Deliberately a non-global regex for the per-part .test() below — a global
// regex's `lastIndex` state would make alternating calls flip-flop wrongly.)
const URL_PATTERN = /https?:\/\/[^\s]+/;
const splitTextAndLinks = (text: string): Array<{ text: string; isLink: boolean }> => {
  const parts = text.split(new RegExp(`(${URL_PATTERN.source})`, 'g'));
  return parts.filter(Boolean).map((part) => ({ text: part, isLink: URL_PATTERN.test(part) }));
};

// This app doesn't have a native form for tools that need one (e.g. the
// Agent Confidential Report) — decline gracefully instead of hanging on a
// client_execute interrupt the mobile UI can't render.
const CLIENT_EXECUTE_FALLBACK = {
  success: false,
  message: "Filling this out isn't available in the mobile app yet — please complete this step from the web portal.",
};

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
  const { toast } = useNotifications();
  const navigation = useNavigation<ChatNavigationProp>();
  const route = useRoute<RouteProp<MainTabParamList, 'Chat'>>();

  const copyLink = useCallback(
    async (url: string) => {
      await Clipboard.setStringAsync(url);
      toast('Link copied', { tone: 'success', icon: 'copy-outline' });
    },
    [toast]
  );

  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [threadId, setThreadId] = useState(newThreadId);
  const [confirmClear, setConfirmClear] = useState(false);
  // A paused turn awaiting a yes/no, a typed clarification, etc. While this is
  // set, the next send() answers the interrupt (via /chat/resume) instead of
  // starting a fresh turn.
  const [pendingInterrupt, setPendingInterrupt] = useState<ChatInterrupt | null>(null);

  // Another screen (e.g. Pre-Underwriting) can hand off a ready-to-send
  // command — load it into the composer once, then clear the param so
  // re-focusing this tab later doesn't refill it again.
  useEffect(() => {
    if (route.params?.prefillMessage) {
      setInput(route.params.prefillMessage);
      navigation.setParams({ prefillMessage: undefined });
    }
  }, [route.params?.prefillMessage, navigation]);

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

  // Drives one leg of a turn — either a fresh /chat/stream message or a
  // /chat/resume answer to a paused interrupt — updating the same message
  // bubble as events arrive. Recurses once, automatically, when the backend
  // pauses on a client_execute interrupt this app can't render a form for.
  const runStream = useCallback(
    async (mode: 'send' | 'resume', payload: any, replyId: string): Promise<void> => {
      let accumulated = '';
      let actions: QuickAction[] | undefined;
      let interrupt: ChatInterrupt | null = null;
      let streamError: string | null = null;

      const callbacks = {
        onToken: (token: string) => {
          accumulated += token;
          if (!mounted.current) return;
          setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, text: accumulated } : m)));
        },
        onQuickActions: (received: QuickAction[]) => {
          actions = received;
        },
        onInterrupt: (received: ChatInterrupt) => {
          interrupt = received;
        },
        onError: (message: string) => {
          streamError = message;
        },
      };

      if (mode === 'send') {
        await sendChatMessage(payload.message, threadId, callbacks);
      } else {
        await resumeChatThread(payload.resumeValue, threadId, callbacks);
      }

      if (streamError) {
        if (!mounted.current) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === replyId ? { ...m, text: streamError!, isStreaming: false, isError: true } : m))
        );
        return;
      }

      if (interrupt) {
        const paused = interrupt as ChatInterrupt;
        if (paused.kind === 'client_execute') {
          if (paused.tool_call?.name === 'submit_agent_confidential_report') {
            const args = paused.tool_call.args || {};
            if (!mounted.current) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === replyId
                  ? { ...m, text: 'Opening the Agent Confidential Report form…', isStreaming: false }
                  : m
              )
            );
            navigation.navigate('AgentConfidentialReport', {
              caseId: args.case_id,
              applicantName: args.case_number,
              onResolved: (result) => {
                runStream('resume', { resumeValue: result }, replyId);
              },
            });
            return;
          }
          await runStream('resume', { resumeValue: CLIENT_EXECUTE_FALLBACK }, replyId);
          return;
        }

        setPendingInterrupt(paused);
        const chips: QuickAction[] =
          paused.kind === 'confirm'
            ? (paused.options || ['Yes', 'Cancel']).map((label) => ({ label, actionType: 'confirm', payload: label }))
            : (paused.options || []).map((label) => ({ label, actionType: 'submit', payload: label }));

        if (!mounted.current) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? { ...m, text: accumulated || paused.question || '', isStreaming: false, quickActions: chips }
              : m
          )
        );
        return;
      }

      if (!mounted.current) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === replyId ? { ...m, text: accumulated || 'Done.', isStreaming: false, quickActions: actions } : m))
      );
    },
    [threadId]
  );

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

      const resuming = pendingInterrupt;
      setPendingInterrupt(null);

      try {
        if (resuming?.kind === 'confirm') {
          const lower = query.toLowerCase();
          await runStream('resume', { resumeValue: lower === 'yes' || lower === 'y' }, replyId);
        } else if (resuming?.kind === 'clarify') {
          await runStream('resume', { resumeValue: query }, replyId);
        } else {
          await runStream('send', { message: query }, replyId);
        }
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
    [input, sending, threadId, pendingInterrupt, runStream, scrollToEnd]
  );

  const startNewThread = useCallback(() => {
    setThreadId(newThreadId());
    setMessages([WELCOME]);
    setPendingInterrupt(null);
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
                {splitTextAndLinks(item.text).map((part, index) =>
                  part.isLink ? (
                    <Text
                      key={index}
                      variant="body"
                      onPress={() => copyLink(part.text)}
                      accessibilityRole="button"
                      accessibilityLabel={`Copy link ${part.text}`}
                      style={[
                        styles.link,
                        { color: isUser ? colors.tone.brand.onSolid : colors.tone.accent.on },
                      ]}
                    >
                      {part.text}
                    </Text>
                  ) : (
                    <React.Fragment key={index}>{part.text}</React.Fragment>
                  )
                )}
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
      contentContainerStyle={{ paddingBottom: 0 }}
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
  link: {
    textDecorationLine: 'underline',
    fontWeight: '600',
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
