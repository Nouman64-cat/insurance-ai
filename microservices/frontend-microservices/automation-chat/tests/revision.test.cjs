const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
const output=ts.transpileModule(fs.readFileSync('lib/agent/revision.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const stub={exports:{}};vm.runInThisContext(`(function(module,exports){${output}\n})`)(stub,stub.exports);
const {isRevisionText,revision}=stub.exports;
test('English changes of direction are revisions',()=>{for(const phrase of ['Actually, I need family insurance','Switch to family','Go back','Change my plan'])assert.equal(isRevisionText(phrase),true);});
test('Urdu corrections are revisions',()=>assert.equal(isRevisionText('مجھے خاندانی بیمہ چاہیے، تبدیل کریں'),true));
test('confirmation and plan labels are not revisions',()=>{for(const phrase of ['Yes','Cancel','Family Protection','Individual','Family group'])assert.equal(isRevisionText(phrase),false);});
test('revision uses an explicit control envelope',()=>assert.deepEqual(revision('  Switch to family  '),{kind:'revise',message:'Switch to family'}));
