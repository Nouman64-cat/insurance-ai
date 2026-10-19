import React, { useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { spacing, typography } from '../theme/tokens';
import { isCopyableLink, MarkdownNode, parseChatMarkdown } from '../lib/chatMarkdown';

interface Props {
  text: string;
  color?: string;
  onLinkPress: (url: string) => void;
}

/** Native Markdown: no WebView, HTML execution, or automatic remote-image loads. */
export default function ChatMarkdown({ text, color, onLinkPress }: Props) {
  const { colors } = useTheme();
  const nodes = useMemo(() => parseChatMarkdown(text), [text]);
  const ink = color || colors.text;
  const firstLetter = text.match(/[A-Za-z\u0600-\u06ff]/)?.[0] || '';
  const rtl = /[\u0600-\u06ff]/.test(firstLetter);
  const body = { ...typography.body, color: ink, writingDirection: rtl ? 'rtl' as const : 'ltr' as const, textAlign: rtl ? 'right' as const : 'left' as const };
  const code = { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', backgroundColor: colors.surfaceSunken };

  const inline = (items: MarkdownNode[], prefix: string): React.ReactNode[] => items.map((node, i) => {
    const key = `${prefix}-${i}`;
    switch (node.type) {
      case 'text': return node.content;
      case 'softbreak': case 'hardbreak': return '\n';
      case 'inline': return <React.Fragment key={key}>{inline(node.children, key)}</React.Fragment>;
      case 'strong_open': return <Text key={key} style={styles.bold}>{inline(node.children, key)}</Text>;
      case 'em_open': return <Text key={key} style={styles.italic}>{inline(node.children, key)}</Text>;
      case 's_open': return <Text key={key} style={styles.strike}>{inline(node.children, key)}</Text>;
      case 'code_inline': return <Text key={key} style={code}>{node.content}</Text>;
      case 'link_open': {
        const href = node.attrs.href || '';
        const active = isCopyableLink(href);
        return <Text key={key} accessibilityRole={active ? 'link' : undefined}
          accessibilityHint={active ? 'Copy link' : undefined}
          onPress={active ? () => onLinkPress(href) : undefined}
          style={active ? { color: colors.tone.accent.on, textDecorationLine: 'underline' } : undefined}>
          {inline(node.children, key)}
        </Text>;
      }
      case 'image': return <Text key={key} style={styles.italic}>{node.content || 'Image'}</Text>;
      default: return node.children.length ? <React.Fragment key={key}>{inline(node.children, key)}</React.Fragment> : node.content;
    }
  });

  const block = (items: MarkdownNode[], prefix: string): React.ReactNode[] => items.map((node, i) => {
    const key = `${prefix}-${i}`;
    switch (node.type) {
      case 'paragraph_open':
        return <Text key={key} selectable style={[body, !node.hidden && styles.paragraph]}>{inline(node.children, key)}</Text>;
      case 'heading_open':
        return <Text key={key} selectable accessibilityRole="header" style={[body, styles.heading,
          node.tag === 'h1' ? typography.title2 : typography.title3]}>{inline(node.children, key)}</Text>;
      case 'bullet_list_open': case 'ordered_list_open': {
        const start = Number(node.attrs.start || 1);
        return <View key={key} style={styles.list}>{node.children.map((item, j) =>
          <View key={`${key}-${j}`} style={[styles.listItem, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
            <Text style={[body, styles.marker]}>{node.type === 'ordered_list_open' ? `${start + j}.` : '•'}</Text>
            <View style={styles.listBody}>{block(item.children, `${key}-${j}`)}</View>
          </View>)}</View>;
      }
      case 'blockquote_open':
        return <View key={key} style={[styles.quote, { borderColor: colors.borderStrong }]}>{block(node.children, key)}</View>;
      case 'fence': case 'code_block':
        return <ScrollView key={key} horizontal style={[styles.codeBlock, { backgroundColor: colors.surfaceSunken }]}>
          <Text selectable style={[body, code, styles.codeText]}>{node.content.replace(/\n$/, '')}</Text>
        </ScrollView>;
      case 'table_open':
        return <ScrollView key={key} horizontal style={styles.tableScroll}>
          <View style={[styles.table, { borderColor: colors.border }]}>{block(node.children, key)}</View>
        </ScrollView>;
      case 'thead_open': case 'tbody_open':
        return <View key={key}>{block(node.children, key)}</View>;
      case 'tr_open':
        return <View key={key} style={styles.tableRow}>{block(node.children, key)}</View>;
      case 'th_open': case 'td_open':
        return <View key={key} style={[styles.cell, { borderColor: colors.border }, node.type === 'th_open' && { backgroundColor: colors.surfaceSunken }]}>
          <Text selectable style={[body, node.type === 'th_open' && styles.bold]}>{inline(node.children, key)}</Text>
        </View>;
      case 'hr': return <View key={key} style={[styles.rule, { backgroundColor: colors.border }]} />;
      case 'inline': return <Text key={key} selectable style={body}>{inline(node.children, key)}</Text>;
      default: return <React.Fragment key={key}>{node.children.length ? block(node.children, key) : <Text selectable style={body}>{node.content}</Text>}</React.Fragment>;
    }
  });

  return <View style={styles.root}>{block(nodes, 'md')}</View>;
}

const styles = StyleSheet.create({
  root: { flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  paragraph: { marginVertical: spacing.xs },
  heading: { marginTop: spacing.sm, marginBottom: spacing.xs },
  bold: { fontWeight: '700' }, italic: { fontStyle: 'italic' }, strike: { textDecorationLine: 'line-through' },
  list: { gap: spacing.xs, marginVertical: spacing.xs },
  listItem: { alignItems: 'flex-start', gap: spacing.sm },
  marker: { minWidth: spacing.xl }, listBody: { flex: 1, minWidth: 0, gap: spacing.xs },
  quote: { borderLeftWidth: 3, paddingLeft: spacing.md, marginVertical: spacing.sm },
  codeBlock: { maxWidth: '100%', borderRadius: spacing.sm, marginVertical: spacing.sm },
  codeText: { padding: spacing.md }, tableScroll: { maxWidth: '100%', marginVertical: spacing.sm },
  table: { borderWidth: StyleSheet.hairlineWidth }, tableRow: { flexDirection: 'row' },
  cell: { width: 150, padding: spacing.sm, borderWidth: StyleSheet.hairlineWidth },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: spacing.md },
});
