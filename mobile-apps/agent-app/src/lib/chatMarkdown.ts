import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });
type Token = ReturnType<typeof parser.parse>[number];

export interface MarkdownNode {
  type: string;
  tag: string;
  content: string;
  attrs: Record<string, string>;
  hidden: boolean;
  children: MarkdownNode[];
}

function tree(tokens: Token[]): MarkdownNode[] {
  const root: MarkdownNode = { type: 'root', tag: '', content: '', attrs: {}, hidden: false, children: [] };
  const stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: MarkdownNode = {
      type: token.type, tag: token.tag, content: token.content,
      attrs: Object.fromEntries((token.attrs || []).map(([key, value]) => [key, String(value)])), hidden: token.hidden,
      children: token.children ? tree(token.children) : [],
    };
    stack[stack.length - 1].children.push(node);
    if (token.nesting === 1) stack.push(node);
  }
  return root.children;
}

export function parseChatMarkdown(text: string): MarkdownNode[] {
  return tree(parser.parse(text, {}));
}

export function isCopyableLink(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(href);
}
