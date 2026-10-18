import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript');
const source=readFileSync(new URL('../../frontend/components/claims/claimProgress.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const mod={exports:{}};
new Function('exports','module',compiled)(mod.exports,mod);
const {claimStepIndex}=mod.exports;
const steps=['Intimation','Eligibility','Documents','Assessment','Decision','Settlement','Closure'];
const stale=[{state:'complete'},{state:'complete'},{state:'complete'},{state:'action'},{state:'not_started'},{state:'not_started'},{state:'complete'}];
test('closed claim finishes the stepper despite stale investigation markers',()=>{
  const index=claimStepIndex('Closed',stale,steps,'Closed');
  assert.equal(index,7);
  assert.equal(steps.filter((_,i)=>i<index).length,7);
  assert.equal(Math.min(index+1,steps.length),7);
});
test('open claim retains the first genuine outstanding stage',()=>{
  assert.equal(claimStepIndex('Under Investigation',stale,steps,'Under Investigation'),3);
});
test('closed legacy claim also finishes when no workspace exists',()=>{
  assert.equal(claimStepIndex('Closed',null,steps,'Closed'),7);
});
test('complete and skipped stages do not become active and all-done count stays bounded',()=>{
  const stages=steps.map((_,i)=>({state:i===5?'skipped':'complete'}));
  assert.equal(claimStepIndex('Closed',stages,steps,'Closed'),7);
  const awaitingReconciliation=stages.map((s,i)=>i===5?{state:'action'}:s);
  assert.equal(claimStepIndex('Settled',awaitingReconciliation,steps,'Settled'),5);
});
