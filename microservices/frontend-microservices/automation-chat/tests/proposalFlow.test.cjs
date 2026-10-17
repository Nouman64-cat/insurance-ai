const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual UI action selectors, including callbacks scoped inside the chat component.
function selectors(path, names, sandbox = {}) {
  const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const snippets = [];
  const found = new Set();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) snippets.push(node.getText(source));
    if (ts.isVariableStatement(node)) {
      const matched = node.declarationList.declarations.map(d => d.name.getText(source)).filter(n => names.includes(n) && !found.has(n));
      if (matched.length) { snippets.push(node.getText(source)); matched.forEach(n => found.add(n)); }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const code = ts.transpileModule(snippets.join('\n'), {compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS}}).outputText;
  vm.createContext(sandbox);
  return vm.runInContext(`${code}\n;({${names.join(',')}})`, sandbox);
}
const portal = selectors('../frontend/app/proposal/page.tsx', ['getAvailableActions', 'proposalSteps', 'proposalProgress', 'STEP_SUBMIT', 'STEP_PAYMENT', 'STEP_UNDERWRITING']);
const sandbox = {role: 'Admin'};
sandbox.localStorage = {getItem: () => sandbox.role};
const chat = selectors('components/CopilotInterface.tsx', ['PROPOSAL_STEPS', 'PROPOSAL_OPTIONS', 'PAYMENT_NEXT', 'proposalNext', 'stepChip', 'paymentActions', 'proposalActions', 'canHandOffToUnderwriting'], sandbox);
const values = actions => Array.from(actions, a => a.value);
const steps = actions => Array.from(actions, a => JSON.parse(a.payload).step);

test('submitted and legacy review proposals collect payment before offering underwriting', () => {
  for (const status of ['Proposed', 'UnderReview']) {
    const due = values(portal.getAvailableActions(status, false, false, true, false, 'due'));
    assert.ok(due.includes('payment_request'));
    assert.ok(!due.includes('underwriting'));
    assert.ok(!due.includes('status:UnderReview'));
    assert.ok(values(portal.getAvailableActions(status, false, false, true, false, 'paid')).includes('underwriting'));
    assert.equal(portal.getAvailableActions(status, false, false, false, true, 'paid').length, 0);
  }
});
test('progress has three individual steps and two group/family steps', () => {
  assert.deepEqual(Array.from(portal.proposalSteps(true), s => s.label), ['Submit proposal', 'Initial payment', 'Send to underwriting']);
  assert.equal(portal.proposalSteps(false).length, 2);
  for (const status of ['Proposed', 'UnderReview']) {
    assert.equal(portal.proposalProgress(status, true, false).current, 2);
    assert.equal(portal.proposalProgress(status, true, true).current, 3);
    assert.equal(portal.proposalProgress(status, false, false).current, 2);
  }
});
test('chat submission offers initial premium without an intermediate review mutation', () => {
  sandbox.role = 'Admin';
  for (const state of ['submitted', 'review']) {
    assert.ok(steps(chat.proposalActions(state, {hasMissing:false, payment:'due'})).includes('payment_request'));
    assert.ok(!steps(chat.proposalActions(state, {hasMissing:false, payment:'due'})).includes('underwrite'));
    assert.ok(steps(chat.proposalActions(state, {hasMissing:false, payment:'paid'})).includes('underwrite'));
  }
  assert.equal(chat.PROPOSAL_STEPS.submit.to, 'submitted');
  assert.equal(chat.PROPOSAL_STEPS.review.status, 'Proposed'); // stale chips cannot restore the removed step
  assert.equal(chat.PROPOSAL_STEPS.return_review.status, 'Proposed');
  assert.ok(!chat.PROPOSAL_OPTIONS.info.ids.includes('return_review'));
});
test('chat agent role cannot collect premiums or send submitted proposals to underwriting', () => {
  sandbox.role = 'Agent';
  for (const state of ['submitted', 'review']) {
    assert.ok(chat.proposalActions(state, {payment:'due'}).every(a => a.actionType !== 'proposal_step'));
    assert.equal(chat.proposalNext(state, 'due'), '');
  }
});
