import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript'), React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const source = readFileSync(new URL('../components/workbench/ClaimAdminUnderwritingOutcome.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX, esModuleInterop:true}}).outputText;
const mod = {exports:{}} as any;
new Function('require','module','exports',compiled)((name:string)=>name==='@/app/services/api'?{default:{}}:name==='@/lib/i18n/tx'?{tx:(s:string)=>s}:require(name),mod,mod.exports);
const Component = mod.exports.default;
const state = {reviews_complete:true,assessment_id:'assessment-1',ai_recommendation:'Decline',outcome:null};
const render=(role:string,initialState=state)=>renderToStaticMarkup(React.createElement(Component,{role,tenantId:'tenant',caseId:'case',initialState,onDone:()=>{}}));
test('AI decline leaves Admin human Proceed and Decline choices enabled',()=>{
  const html=render('Admin');
  assert.match(html,/AI recommendation/); assert.match(html,/Decline/); assert.match(html,/Proceed/);
  assert.match(html,/AI provides advice only/); assert.match(html,/Claims Manager makes the final claim decision/);
  assert.doesNotMatch(html,/<fieldset[^>]*disabled/);
  assert.equal((html.match(/aria-pressed="false"/g)||[]).length,2); // AI never selects the human outcome.
  assert.match(html,/<button type="submit" disabled=""/); // Explicit choice and rationale are required.
});
test('Missing specialist reviews prevent recording the human outcome',()=>assert.match(render('Admin',{...state,reviews_complete:false}),/<fieldset disabled=""/));
for(const role of ['Medical Underwriter','Financial Underwriter','ClaimsManager','Finance','Underwriter'])
  test(`${role} cannot record the Admin underwriting outcome`,()=>assert.equal(render(role),''));


test('Claim AI banners describe advice and never declare a claim declined',()=>{
  const source=readFileSync(new URL('../../frontend/components/StatusBadge.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const exports:any={};new Function('require','exports',code)(require,exports);
  const banner=renderToStaticMarkup(React.createElement(exports.DecisionBanner,{decision:'Decline',advisory:true,variant:'compact'}));
  assert.match(banner,/AI recommendation: Decline/);assert.match(banner,/Advisory only/);
  assert.doesNotMatch(banner,/Application declined|Application cannot proceed/i);
  const badge=renderToStaticMarkup(React.createElement(exports.StatusBadge,{decision:'Decline',advisory:true}));
  assert.match(badge,/Recommend decline/);assert.doesNotMatch(badge,/Declined/);
});
