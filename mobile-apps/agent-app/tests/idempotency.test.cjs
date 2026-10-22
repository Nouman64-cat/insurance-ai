const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.resolve(__dirname, '../src/lib/idempotency.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module_ = { exports: {} };
vm.runInThisContext(`(function(module,exports){${code}\n})`, { filename: file })(module_, module_.exports);
const { createOperations } = module_.exports;

// One key per user intent: kept through uncertain failures, consumed by success or a final refusal.
test('an uncertain failure keeps the key; success and a refusal consume it', async () => {
  const state = new Map();
  const store = { getItem: async (k) => state.get(k) ?? null, setItem: async (k, v) => void state.set(k, v), removeItem: async (k) => void state.delete(k) };
  const ops = createOperations(store, async () => 'tenant:agent');
  let first;
  await assert.rejects(ops.run('ipp-confirm:1', async (h) => { first = h['Idempotency-Key']; throw new Error('timeout'); }));
  await ops.run('ipp-confirm:1', async (h) => { assert.equal(h['Idempotency-Key'], first); return 'paid'; });
  assert.equal(state.size, 0);
  await ops.run('ipp-confirm:1', async (h) => assert.notEqual(h['Idempotency-Key'], first));
  let refused;
  await assert.rejects(ops.run('s', async (h) => { refused = h['Idempotency-Key']; throw Object.assign(new Error('x'), { response: { status: 422, data: { detail: 'bad' } } }); }));
  await ops.run('s', async (h) => assert.notEqual(h['Idempotency-Key'], refused));
  let kept;
  await assert.rejects(ops.run('t', async (h) => { kept = h['Idempotency-Key']; throw Object.assign(new Error('x'), { response: { status: 503, data: {} } }); }));
  await ops.run('t', async (h) => assert.equal(h['Idempotency-Key'], kept));
});
