import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript'), React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(relative){
  const compiled=ts.transpileModule(readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const mod={exports:{}};
  new Function('require','exports','module',compiled)(name=>name==='@/lib/i18n/tx'?{tx:s=>s}:name==='@/lib/dateDisplay'?{displayDate:s=>s}:name==='next/link'?{__esModule:true,default:props=>React.createElement('a',props)}:name==='@/app/services/postIssuance'?{}:require(name),mod.exports,mod);
  return mod.exports;
}
const {paymentQueue}=load('../../frontend/components/finance/paymentQueue.ts');
const FinanceClaim=load('../../frontend/components/finance/FinanceClaimWorkspace.tsx').default;
const base={id:'c1',policy_id:'p1',claim_number:'CLM-TEST',policy_number:'POL-TEST',claim_type:'Death Claim',customer_name:'Policy Holder',claimant_name:'Beneficiary',approved_amount:1000,settlement_amount:0,status:'Approved'};
const rows=[base,{...base,id:'c2',status:'Partial Approval'}, {...base,id:'c3',status:'Settled',settlement_amount:1000}, {...base,id:'c4',status:'Closed',settlement_amount:1000}, {...base,id:'c5',status:'Closed'}, {...base,id:'c6',status:'Declined'}, {...base,id:'c7',status:'Under Investigation'}, {...base,id:'c8',status:'Settled',settlement_amount:1000,finance_summary:{reconciled_at:'2026-10-18'}}];
test('Finance queues separate approved work, reconciliation and paid history',()=>{
  assert.deepEqual(paymentQueue(rows,'payouts','').map(c=>c.id),['c1','c2']);
  assert.deepEqual(paymentQueue(rows,'history','').map(c=>c.id),['c3','c4','c8']);
  assert.deepEqual(paymentQueue(rows,'reconciliation','').map(c=>c.id),['c3']);
  assert.equal(paymentQueue(rows,'history','not-found').length,0);
  assert.equal(paymentQueue(rows,'payouts','pol-test').length,2);
});
const settlement={payees:[],payouts:[],authorized_at:null,reconciled_at:null,methods:['Bank Transfer']};
const render=(claim=base,workspace={settlement,can:{disburse:false,reconcile:false}})=>renderToStaticMarkup(React.createElement(FinanceClaim,{claim,workspace,onReload:async()=>{}}));
test('approved claim awaiting manager authorisation has no payment or claim decision button',()=>{
  const html=render();assert.match(html,/Awaiting Claims Manager authorisation/);
  assert.doesNotMatch(html,/>Record payout<|Approve claim|Record final decision|Investigation &amp; assessment/);
});
test('only an authorised unpaid claim offers the Finance payout action',()=>{
  const workspace={settlement:{...settlement,authorized_at:'2026-10-18',authorized_amount:1000},can:{disburse:true,reconcile:false}};
  assert.match(render(base,workspace),/>Record payout</);
  assert.doesNotMatch(render({...base,status:'Closed'},workspace),/>Record payout</);
});
test('closed claims show payment references without an underwriting journey or payment action',()=>{
  const payout={id:'pay1',amount:1000,method:'Bank Transfer',reference_number:'PAY-TEST-123',completed_at:'2026-10-18'};
  const html=render({...base,status:'Closed',settlement_amount:1000,payouts:[payout]},null);
  assert.match(html,/PAY-TEST-123/);assert.match(html,/No further payout/);
  assert.doesNotMatch(html,/>Record payout<|>Reconcile payment<|Claim intimation|Claims decision|Fraud risk/);
});
test('settled payments expose reconciliation and show exception details',()=>{
  const workspace={settlement:{...settlement,reconciliation:{status:'Exception',variance:20,checks:[{label:'Payment total',detail:'Amounts differ'}]}},can:{disburse:false,reconcile:true}};
  const html=render({...base,status:'Settled'},workspace);
  assert.match(html,/Reconcile payment/);assert.match(html,/Payment total.*Amounts differ/);
  assert.match(html,/disabled=""/);assert.doesNotMatch(html,/>Record payout</);
});
test('missing workflow stays read-only and offers refresh',()=>{
  const html=render(base,null);assert.match(html,/Payment workflow could not be loaded/);
  assert.doesNotMatch(html,/>Record payout<|>Reconcile payment</);
});
