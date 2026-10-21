const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const source = fs.readFileSync('lib/idempotency.ts', 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
const state = new Map();
const context = {exports: {}, crypto: require('node:crypto').webcrypto,
  sessionStorage: {getItem: k => state.get(k) ?? null, setItem: (k,v) => state.set(k,v), removeItem: k => state.delete(k)}};
vm.runInNewContext(compiled, context);
(async () => {
  let original;
  await assert.rejects(context.exports.runOperation('tenant:actor', 'payment:1', async key => {original=key; throw new Error('timeout');}));
  // Re-evaluate the module to simulate a page reload, retaining only browser storage.
  context.exports={}; vm.runInNewContext(compiled, context);
  await context.exports.runOperation('tenant:actor','payment:1', async key => {assert.equal(key,original); return 'paid';});
  await context.exports.runOperation('tenant:actor','payment:1', async key => assert.notEqual(key,original));
  await context.exports.runOperation('other-tenant:actor','payment:1', async key => assert.notEqual(key,original));
  assert.equal(state.size,0);
  console.log('PASS: timeout/reload retains identity; completed and cross-tenant operations use new keys');
})().catch(e => {console.error(e); process.exitCode=1;});
