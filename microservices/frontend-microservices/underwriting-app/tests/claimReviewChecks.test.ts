import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = readFileSync(new URL('../components/workbench/ClaimReviewChecks.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const mod = {exports:{}};
new Function('require','exports','module',compiled)(name=>name==='@/lib/i18n/tx'?{tx:s=>s}:require(name),mod.exports,mod);
const panel = mod.exports.default;
const requirements = [
  {key:'documents',label:'Documents',status:'Received'},
  {key:'claim_exclusions',label:'Plan exclusions to check',status:'Required',detail:'Policy exclusions from the plan.'},
  {key:'claim_contestability',label:'Contestability — proposal answers vs. history',status:'Required',detail:'Compare declarations to the evidence.'},
];
const render = (changes={}) => renderToStaticMarkup(React.createElement(panel,{requirements,checks:{},disabled:false,onSave:async()=>{},onEvidence:()=>{},...changes}));
test('both manual requirements have findings, rationale and save controls',()=>{
  const html=render();
  assert.match(html,/id="claim_exclusions"/);assert.match(html,/id="claim_contestability"/);
  assert.equal((html.match(/<select/g)||[]).length,2);
  assert.equal((html.match(/<textarea/g)||[]).length,2);
  assert.equal((html.match(/Save finding/g)||[]).length,2);
  assert.match(html,/Review documents/);assert.match(html,/View applicant &amp; policy/);
});
test('saved findings are restored and held/unassigned reviews have disabled forms',()=>{
  const html=render({disabled:true,checks:{claim_exclusions:{finding:'Clear',note:'Original terms and incident records reviewed.',updated_at:'2026-10-18',updated_by:'reviewer'}}});
  assert.equal((html.match(/<fieldset disabled=""/g)||[]).length,2);
  assert.match(html,/Original terms and incident records reviewed/);
  assert.match(html,/Finding saved/);
});
test('an unresolved concern explains that clearance remains blocked',()=>{
  const html=render({checks:{claim_contestability:{finding:'Concern',note:'Evidence requires referral.',updated_at:'2026-10-18',updated_by:'reviewer'}}});
  assert.match(html,/An unresolved concern keeps this requirement open/);
});
