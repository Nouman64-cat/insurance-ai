const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const path=require('node:path');
function load(file,stubs={}) {
  const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',source)(name=>stubs[name] || require(name),module,module.exports);
  return module.exports;
}
for(const file of ['lib/copilotName.ts','../frontend/lib/copilotName.ts']) {
  test(`Finance Copilot identity is consistent in ${file}`,()=>{
    const {copilotIdentity}=load(file);
    assert.equal(copilotIdentity('Finance').name,'Finance Copilot');
    assert.match(copilotIdentity('Finance').tagline,/payments.*reconciliation/i);
    assert.equal(copilotIdentity('Financial Underwriter').name,'Financial Underwriting Copilot');
    assert.equal(copilotIdentity('ClaimsManager').name,'Claims Copilot');
  });
}
test('Finance returns from chat to its own dashboard',()=>{
  const {homeUrlFor}=load('lib/portal.ts');
  assert.match(homeUrlFor('Finance'),/\/finance$/);
  assert.match(homeUrlFor('ClaimsManager'),/\/claims\/dashboard$/);
});
test('English and Urdu greetings identify Finance and explain its payment scope',()=>{
  for(const locale of ['en','ur']) {
    const dictionary=load(`lib/i18n/messages/${locale}.ts`).default;
    assert.match(dictionary.composer.greetingFinance,/Finance Copilot/);
    assert.ok(dictionary.composer.greetingFinance.length>60);
  }
});
