import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const source=readFileSync(new URL('../../frontend/components/claims/ClaimSettlementApproval.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const mod={exports:{}};
new Function('require','exports','module',compiled)(name=>name==='@/lib/i18n/tx'?{tx:s=>s}:name==='@/lib/dateDisplay'?{displayDate:s=>s}:name==='@/app/services/postIssuance'?{}:require(name),mod.exports,mod);
const render=(workspace=null,role='ClaimsManager')=>renderToStaticMarkup(React.createElement(mod.exports.default,{role,policyId:'p',claimId:'c',workspace,onDone:async()=>{}}));
const payee={id:'p1',name:'Mahnoor Shah',amount:185000,share_pct:100,verified:false};
const workspace={settlement:{payees:[payee]},can:{verify_payees:true,authorize:false}};
test('only Claims Manager gets settlement approval controls',()=>{
  for (const role of ['Finance','Admin','ClaimsAdjuster','Medical Underwriter']) assert.equal(render(workspace,role),'');
  assert.match(render(workspace),/Authorise Finance to record payment/);
});
test('legacy approval with no payees has an explicit preparation action',()=>{
  assert.match(render(),/Prepare settlement payees/);
  assert.doesNotMatch(render(),/>Authorise Finance payment</);
});
test('manager can enter verification evidence but cannot authorise unverified payees',()=>{
  const html=render(workspace);
  for(const label of ['Payee CNIC','Bank name','Account title','IBAN','Identity verification method','Verification note','Save &amp; verify payees']) assert.ok(html.includes(label),label);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Authorise Finance payment<\/button>/);
});
test('verified payees enable authorisation and an authorised settlement becomes a confirmation',()=>{
  const html=render({...workspace,can:{verify_payees:true,authorize:true}});
  assert.match(html,/<button type="button" class="[^"]*">Authorise Finance payment<\/button>/);
  const authorised=render({...workspace,settlement:{payees:[payee],authorized_at:'2026-10-19',authorized_by:'Claims Manager',authorized_amount:185000}});
  assert.match(authorised,/Finance payment authorised/);assert.match(authorised,/Finance can now record/);
  assert.doesNotMatch(authorised,/<form|<input/);
});
