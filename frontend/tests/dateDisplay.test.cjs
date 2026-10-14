const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const apps = ['frontend/lib', 'automation-chat/lib', 'underwriting-app/lib', 'customer-portal/lib', 'agent-app/src/lib'];
for (const app of apps) {
  const source = fs.readFileSync(path.join(root, app, 'dateDisplay.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  new Function('exports', compiled)(mod.exports);
  const { displayDate, displayDateTime } = mod.exports;
  test(`${app}: standard dates and safe empty values`, () => {
    assert.equal(displayDate('2026-10-14'), '14 Oct, 2026');
    assert.equal(displayDate('2027-01-02'), '2 Jan, 2027');
    for (const value of [null, undefined, '', 'invalid']) assert.equal(displayDate(value), '—');
  });
  test(`${app}: explicit timezone and time retained`, () => {
    assert.equal(displayDate('2026-10-14T23:30:00Z', { timeZone: 'Asia/Karachi' }), '15 Oct, 2026');
    assert.equal(displayDateTime('2026-10-14T10:30:00Z', { timeZone: 'UTC' }), '14 Oct, 2026 · 10:30');
    assert.equal(displayDate('2026-10-14T10:30:00Z', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }), '14 Oct, 2026 · 10:30');
  });
}
