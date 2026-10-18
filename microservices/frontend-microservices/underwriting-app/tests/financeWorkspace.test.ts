import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript'), React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(relative){
  const compiled=ts.transpileModule(readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const mod={exports:{}};
  new Function('require','exports','module',compiled)(name=>name==='@/lib/i18n/tx'?{tx:s=>s}:name==='@/lib/dateDisplay'?{displayDate:s=>s}:name==='next/link'?{__esModule:true,default:props=>React.createElement('a',props)}:name==='@/app/services/postIssuance'?{}:name==='@/app/services/claims'?{listFinancePayments:async()=>({items:[],total:0})}:name==='./paymentQueue'?load('../../frontend/components/finance/paymentQueue.ts'):require(name),mod.exports,mod);
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
test('approved claim awaiting manager authorisation shows a disabled payout action',()=>{
  const html=render();assert.match(html,/Awaiting Claims Manager authorisation/);
  assert.match(html,/>Record payout</);assert.match(html,/<button[^>]*disabled=""[^>]*>Record payout<\/button>/);
  assert.doesNotMatch(html,/Approve claim|Record final decision|Investigation &amp; assessment/);
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
test('missing workflow explains the blocker and disables payment',()=>{
  const html=render(base,null);assert.match(html,/Payment workflow could not be loaded/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Record payout<\/button>/);assert.doesNotMatch(html,/>Reconcile payment</);
});


test('recording payment asks for an external reference and explains its Paid status',()=>{
  const workspace={settlement:{...settlement,authorized_at:'2026-10-18',authorized_amount:1000},can:{disburse:true,reconcile:false}};
  const html=render(base,workspace);
  assert.match(html,/Bank \/ payment reference/);
  assert.match(html,/no bank transfer is initiated/);
  assert.match(html,/Payment note/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Record payout<\/button>/);
});

test('payment history displays payment status separately from claim status',()=>{
  const html=render({...base,status:'Closed',settlement_amount:1000,payouts:[{id:'p',amount:1000,method:'Bank Transfer',status:'Settled',reference_number:'BANK-REF'}]},null);
  assert.match(html,/Payment status/);assert.match(html,/>Paid</);assert.match(html,/BANK-REF/);
});


test('split settlements require a reference for every payee',()=>{
  const html=render(base,{settlement:{...settlement,authorized_at:'2026-10-18',authorized_amount:1000,payees:[{id:'p1',name:'Ali',amount:500,share_pct:50,verified:true},{id:'p2',name:'Sara',amount:500,share_pct:50,verified:true}]},can:{disburse:true,reconcile:false}});
  assert.equal((html.match(/placeholder="Enter the actual transaction reference"/g)||[]).length,2);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Record payout<\/button>/);
});


test('Finance dashboard payment register exposes reference, payee and status filters',()=>{
  const Register=load('../../frontend/components/finance/PaymentRegister.tsx').default;
  const html=renderToStaticMarkup(React.createElement(Register,{refreshKey:''}));
  assert.match(html,/Payment register/);assert.match(html,/Search payment records/);
  assert.match(html,/All payment statuses/);assert.match(html,/>Reference</);assert.match(html,/>Payee</);
  assert.match(html,/>Payment status</);assert.match(html,/>Paid on</);
});
