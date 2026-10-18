import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(relative){
  const source=readFileSync(new URL(relative,import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const mod={exports:{}};
  new Function('require','exports','module',compiled)(name=>name==='@/lib/i18n/tx'?{tx:s=>s}:name==='@/lib/mock-data'?{fmtCoverage:n=>String(n)}:name==='@/app/services/claims'?{getClaimDetail:async()=>{},resolveClaimUnderwriting:async()=>{}}:require(name),mod.exports,mod);
  return mod.exports.default;
}
const FinalDecision=load('../../frontend/components/claims/ClaimFinalUnderwritingDecision.tsx');
const Summary=load('../components/workbench/ClaimUnderwritingSummary.tsx');
const claim={id:'claim-a',status:'Re-Underwriting Required',claim_number:'CLM-TEST',claim_type:'Death Claim',submitted_amount:1000,incident_date:null,referral_reason:'Review disclosures',ready:true,
  reviews:{medical:{status:'CLEARED',note:null},financial:{status:'CLEARED',note:null}},
  underwriting_review:{ready:true,case_id:'case-a',reviews:{medical:{status:'CLEARED'},financial:{status:'CLEARED'}}}};
for(const role of ['Medical Underwriter','Financial Underwriter','Underwriter','ClaimsAdjuster','Admin','SuperAdmin','Finance']){
  test(`final decision controls are absent for ${role}`,()=>{
    assert.equal(renderToStaticMarkup(React.createElement(FinalDecision,{claimId:claim.id,role,initialClaim:claim,onDone:()=>{}})),'');
  });
}
test('Claims Manager receives the final action only after both current reviews are complete',()=>{
  const render=data=>renderToStaticMarkup(React.createElement(FinalDecision,{claimId:claim.id,role:'ClaimsManager',initialClaim:data,onDone:()=>{}}));
  const html=render(claim);
  assert.match(html,/Record final decision/);
  assert.doesNotMatch(html,/<button[^>]*disabled=""[^>]*>Record final decision/);
  assert.match(render({...claim,underwriting_review:{...claim.underwriting_review,ready:false}}),/<button[^>]*disabled=""[^>]*>Record final decision/);
});
test('specialist summary keeps review statuses but mounts no final-action handlers',()=>{
  const html=renderToStaticMarkup(React.createElement(Summary,{claim}));
  assert.match(html,/Medical review/);assert.match(html,/Financial review/);
  assert.match(html,/Claims Manager records the final decision/);
  assert.doesNotMatch(html,/<button|<form|Record final decision/);
});

const PayoutAction=load('../../frontend/components/claims/ClaimPayoutAction.tsx');
for(const role of ['ClaimsManager','ClaimsAdjuster','Medical Underwriter','Financial Underwriter','Underwriter','Admin','SuperAdmin']){
  test(`approved claims hand off payment to Finance for ${role}`,()=>{
    const html=renderToStaticMarkup(React.createElement(PayoutAction,{role,eligible:true,onPayout:()=>{throw Error('must not pay')}}));
    assert.match(html,/Awaiting Finance/);
    assert.doesNotMatch(html,/<button|<form/);
  });
}
test('Finance receives the payout control only for an eligible claim',()=>{
  const render=(eligible,disabled=false)=>renderToStaticMarkup(React.createElement(PayoutAction,{role:'Finance',eligible,disabled,onPayout:()=>{}}));
  assert.match(render(true),/<button/);assert.match(render(true),/Issue payout/);
  assert.doesNotMatch(render(true),/disabled=""/);
  assert.match(render(true,true),/disabled=""/);
  assert.equal(render(false),'');
});
