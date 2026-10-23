const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const storage = new Map();
const receipts = new Map();
const calls = [];
let loseResponse = false, rejectProposal = false, created = 0;
const api = {post: async (url, body, config) => {
  const key = config?.headers?.['Idempotency-Key'];
  assert.ok(key, 'every customer/proposal POST must carry a key');
  calls.push({url, key});
  if (url.endsWith('/policies')) {
    if (rejectProposal) throw Object.assign(new Error('Proposal rejected'), {response: {status: 422}});
    return {data: {id: 'proposal'}};
  }
  if (!receipts.has(key)) receipts.set(key, {id: `customer-${++created}`});
  if (loseResponse) { loseResponse = false; throw new Error('Connection lost after commit'); }
  return {data: receipts.get(key)};
}};
const globals = {
  crypto: require('node:crypto').webcrypto,
  atob: value => Buffer.from(value, 'base64').toString(),
  localStorage: {getItem: key => key === 'tenant_id' ? 'tenant' : `x.${Buffer.from(JSON.stringify({sub:'admin'})).toString('base64')}.x`},
  sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value), removeItem: key => storage.delete(key)},
  Error,
};
function load(file, deps = {}) {
  const context = {...globals, exports: {}, require: name => { assert.ok(name in deps, name); return deps[name]; }};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(code, context);
  return context.exports;
}
const helpers = load('lib/idempotency.ts');
const loadService = () => load('app/services/customerCreation.ts', {'./api': {default: api}, '@/lib/idempotency': helpers});
(async () => {
  let service = loadService();
  for (const form of ['full', 'quick']) {
    loseResponse = true;
    await assert.rejects(service.createCustomer('tenant', {first_name: 'Test'}, null, form));
    const firstKey = calls.at(-1).key;
    const count = created;
    service = loadService(); // retry after a reload uses session storage
    const result = await service.createCustomer('tenant', {first_name: 'Test'}, null, form);
    assert.equal(calls.at(-1).key, firstKey);
    assert.equal(result.id, `customer-${count}`);
    assert.equal(created, count);
    await service.createCustomer('tenant', {first_name: 'Next'}, null, form);
    assert.notEqual(calls.at(-1).key, firstKey);
  }
  rejectProposal = true;
  await assert.rejects(service.createCustomer('tenant', {}, {coverage_amount: 100}));
  const customerKey = calls.at(-2).key, proposalKey = calls.at(-1).key, count = created;
  rejectProposal = false;
  await service.createCustomer('tenant', {}, {coverage_amount: 200});
  assert.equal(calls.at(-2).key, customerKey);
  assert.equal(calls.at(-1).key, proposalKey);
  assert.equal(created, count);
  assert.equal(storage.size, 0);
  console.log('PASS: both forms send keys; lost responses/reloads reuse them; new submissions get new keys; proposal retry reuses the customer');
})().catch(error => { console.error(error); process.exitCode = 1; });
