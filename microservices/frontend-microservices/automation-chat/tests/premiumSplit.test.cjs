const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const output = ts.transpileModule(fs.readFileSync('lib/agent/premiumSplit.ts', 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const stub = {exports:{}};
vm.runInThisContext(`(function(module,exports){${output}\n})`)(stub,stub.exports);
const {paymentSummary} = stub.exports;
const split = {upfront_pct:20, upfront_amount:23380.70, remaining_pct:80, remaining_amount:93522.78, total:116903.48, rule_code:'PAY-SPLIT-01'};
test('proposal states rule-defined upfront and issuance portions with cents', () => {
 const text = paymentSummary('due',{amount_due:23380.70, breakdown_due:{split}});
 assert.match(text,/20% — PKR 23,380.70/); assert.match(text,/80% — PKR 93,522.78/); assert.match(text,/plus any underwriting loading/);
});
test('realized receipts use their original split and paid amount, not a newly priced due amount', () => {
 const text = paymentSummary('paid',{amount:23380.70,amount_due:99999,breakdown:{split},breakdown_due:{split:{...split,upfront_pct:50}}});
 assert.match(text,/20% — PKR 23,380.70/); assert.doesNotMatch(text,/50%|99,999/); assert.match(text,/only the outstanding balance/);
});
test('does not hardcode twenty percent or invent a split for legacy receipts', () => {
 assert.match(paymentSummary('due',{amount_due:300,breakdown_due:{split:{...split,upfront_pct:30,upfront_amount:300,remaining_pct:70,remaining_amount:700}}}),/30% — PKR 300.00/);
 assert.doesNotMatch(paymentSummary('paid',{amount:1000}),/Premium split|80%/);
});
test('full upfront payment and unpaid claims are not reported as settled issuance', () => {
 const full={...split,upfront_pct:100,remaining_pct:0,remaining_amount:0};
 assert.match(paymentSummary('paid',{amount:1000,breakdown:{split:full}}),/100% upfront/);
 const text=paymentSummary('proof',{amount:23380.70,proof_status:'Submitted',breakdown:{split}});
 assert.match(text,/says they have paid/);assert.doesNotMatch(text,/\(received\)/);
});
