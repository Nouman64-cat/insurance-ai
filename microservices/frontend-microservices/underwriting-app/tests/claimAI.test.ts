import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = readFileSync(new URL('../components/workbench/ClaimAIPanel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const mod = {exports:{}};
new Function('require','exports','module',compiled)(name=>name==='@/lib/i18n/tx'?{tx:s=>s}:name==='@/app/services/api'?{post:async()=>{}}:name==='./toast'?{notify:()=>{}}:require(name),mod.exports,mod);
const render = (track, changes={}) => renderToStaticMarkup(React.createElement(mod.exports.default,{tenantId:'t',caseId:'c',track,ai:{ready:true,blockers:[],result:null},disabled:false,onDone:()=>{},...changes}));
for(const track of ['medical','financial']) {
  test(`${track} claim has a run button without new-business examinations`,()=>{
    const html=render(track);
    assert.match(html,new RegExp(`Run AI ${track} underwriting`));
    assert.doesNotMatch(html,/disabled=""/);
    assert.match(html,/Advisory only/);
  });
  test(`${track} cannot run on locked or incomplete evidence`,()=>{
    assert.match(render(track,{disabled:true}),/disabled=""/);
    const html=render(track,{ai:{ready:false,blockers:['Hospital records still outstanding'],result:null}});
    assert.match(html,/disabled=""/);assert.match(html,/Hospital records still outstanding/);
  });
}
test('recommendation displays evidence and does not offer a final claim decision',()=>{
  const html=render('medical',{ai:{ready:true,blockers:[],run_at:null,result:{recommendation:'Decline',summary:'Review exclusion',findings:[{requirement:'Exclusions',observation:'Check clause',evidence:['Clause 2']}],missing_evidence:['Death certificate']}}});
  assert.match(html,/AI recommendation/);assert.match(html,/Decline/);assert.match(html,/Clause 2/);
  assert.match(html,/Death certificate/);assert.doesNotMatch(html,/Record final decision/);
});
