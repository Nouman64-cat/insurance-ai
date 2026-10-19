const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');

function load(relative) {
  const file = path.resolve(__dirname, '../src/lib', relative);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(createRequire(file), module, module.exports);
  return module.exports;
}
const { parseChatMarkdown, isCopyableLink } = load('chatMarkdown.ts');
const { emptyChatText, applyChatTextEvent, chatText, parseChatEvents } = load('chatStream.ts');
const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);
const textOf = (node) => node.children.length ? node.children.map(textOf).join('') : node.content;

// The fields in the reported screenshot must be rendered as list items and bold spans.
test('copilot requirements parse as an ordered list with actual bold labels', () => {
  const nodes = flatten(parseChatMarkdown('Please share:\n\n1. **First name** (required)\n2. **Last name** (optional)\n3. **Phone number** (required)'));
  assert.equal(nodes.filter((n) => n.type === 'ordered_list_open').length, 1);
  assert.equal(nodes.filter((n) => n.type === 'list_item_open').length, 3);
  assert.deepEqual(nodes.filter((n) => n.type === 'strong_open').map(textOf), ['First name', 'Last name', 'Phone number']);
  assert(!nodes.filter((n) => n.type === 'text').some((n) => n.content.includes('**')));
});

test('headings, nested lists, quotes, tables, code, and Urdu are preserved', () => {
  const source = '# خلاصہ\n\n- Main\n  - *Nested*\n\n> Note\n\n| Plan | Term |\n|---|---|\n| A | 10 |\n\n```js\nconst a = 1;\n```';
  const nodes = flatten(parseChatMarkdown(source));
  for (const type of ['heading_open', 'bullet_list_open', 'em_open', 'blockquote_open', 'table_open', 'fence']) {
    assert(nodes.some((n) => n.type === type), type);
  }
  assert(nodes.some((n) => n.content === 'خلاصہ'));
  assert(nodes.some((n) => n.type === 'fence' && n.content.includes('const a = 1;')));
});

test('Markdown links and bare URLs retain destinations without displaying the syntax', () => {
  const links = flatten(parseChatMarkdown('[Open plan](https://example.com/plan) and https://example.com/help')).filter((n) => n.type === 'link_open');
  assert.deepEqual(links.map((n) => n.attrs.href), ['https://example.com/plan', 'https://example.com/help']);
  assert.equal(textOf(links[0]), 'Open plan');
  assert(isCopyableLink(links[0].attrs.href));
  assert(!isCopyableLink('javascript:alert(1)'));
  assert(!isCopyableLink('file:///private/example'));
});

test('HTML is treated as text and never rendered as HTML nodes', () => {
  const nodes = flatten(parseChatMarkdown('<script>alert(1)</script>'));
  assert(!nodes.some((n) => n.type.startsWith('html_')));
});

test('a final snapshot replaces token chunks instead of duplicating the answer', () => {
  let state = emptyChatText();
  for (const event of [
    { type: 'token', message_id: 'reply', content: 'Please ', delta: true },
    { type: 'token', message_id: 'reply', content: 'share your name.', delta: true },
    { type: 'token', message_id: 'reply', content: 'Please share your name.', delta: false },
    { type: 'token', message_id: 'reply', content: 'Please share your name.', delta: false },
  ]) state = applyChatTextEvent(state, event);
  assert.equal(chatText(state), 'Please share your name.');
});

test('discarded provider attempts disappear without deleting another message', () => {
  let state = emptyChatText();
  for (const event of [
    { type: 'token', message_id: 'old', content: 'Abandoned', delta: true },
    { type: 'token', message_id: 'final', content: '**First name**', delta: false },
    { type: 'message_discard', message_id: 'old' },
  ]) state = applyChatTextEvent(state, event);
  assert.equal(chatText(state), '**First name**');
});

test('multiple messages stay ordered and legacy text events still work', () => {
  let state = emptyChatText();
  for (const event of [
    { type: 'token', message_id: 'one', content: 'First', delta: false },
    { type: 'token', message_id: 'two', content: 'Second', delta: false },
  ]) state = applyChatTextEvent(state, event);
  assert.equal(chatText(state), 'First\n\nSecond');
  state = emptyChatText();
  state = applyChatTextEvent(state, { type: 'token', content: 'Hello ' });
  state = applyChatTextEvent(state, { type: 'token', content: 'world' });
  assert.equal(chatText(state), 'Hello world');
});

test('SSE accepts CRLF and keeps quick actions and interrupts while skipping invalid frames', () => {
  const events = parseChatEvents('data: {"type":"token","content":"Hello"}\r\n\r\ndata:{"type":"quick_actions","actions":[]}\r\n\r\ndata: broken\r\n\r\ndata: null\r\n\r\ndata: {"type":"interrupt","kind":"clarify","question":"Name?"}\r\n\r\n');
  assert.deepEqual(events.map((e) => e.type), ['token', 'quick_actions', 'interrupt']);
  assert.equal(events[2].question, 'Name?');
});
