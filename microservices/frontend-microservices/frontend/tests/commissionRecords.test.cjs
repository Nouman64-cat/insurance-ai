const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function client() {
  const calls = [];
  const api = {
    get: async (...args) => { calls.push(['GET', ...args]); return {data: {items: [], total: 0}}; },
    patch: async (...args) => { calls.push(['PATCH', ...args]); return {data: {id: 'earning', snapshot: {adjustment_revision: 1}}}; },
  };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app/services/commissionEarnings.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
  const mod = {exports: {}};
  new Function('require', 'exports', 'localStorage', compiled)(() => ({default: api}), mod.exports, {getItem: key => ({tenant_id: 'tenant-1', jwt_token: 'test-token'})[key]});
  return {service: mod.exports, calls};
}

test('ledger and summary send the same server filters and bearer authentication', async () => {
  const {service, calls} = client();
  const filters = {search: 'Agent A', source_id: 'source-1', disbursement_status: 'ACCRUED', date_from: '2026-10-01', date_to: '2026-10-31'};
  await service.loadEarnings(50, filters);
  await service.loadSummary(filters);
  assert.equal(calls[0][1], '/tenants/tenant-1/commissions/earnings');
  assert.deepEqual(calls[0][2].params, {...filters, offset: 50, limit: 50});
  assert.deepEqual(calls[1][2].params, filters);
  for (const call of calls) assert.equal(call[2].headers.Authorization, 'Bearer test-token');
});

test('editing preserves the correction reason and concurrency revision in an authenticated PATCH', async () => {
  const {service, calls} = client();
  const body = {rate_pct: '12.5', disburse_date: '2026-11-15', reason: 'Agreed rate correction', expected_revision: 3};
  const result = await service.updateEarning('earning-1', body);
  assert.equal(calls[0][0], 'PATCH');
  assert.equal(calls[0][1], '/tenants/tenant-1/commissions/earnings/earning-1');
  assert.deepEqual(calls[0][2], body);
  assert.equal(calls[0][3].headers.Authorization, 'Bearer test-token');
  assert.equal(result.snapshot.adjustment_revision, 1);
});
