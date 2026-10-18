const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(file) {
  const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod={exports:{}};
  new Function('require','module','exports',source)(name=>name==='./CopilotRoleIcon'?load('components/CopilotRoleIcon.tsx'):require(name),mod,mod.exports);
  return mod.exports;
}
const mod=load('components/CopilotBadge.tsx');
const Badge=mod.default;
for(const [name,icon] of [['Finance Copilot','finance'],['Medical Underwriting Copilot','medical'],['Financial Underwriting Copilot','financial-underwriting'],['Claims Copilot','claims'],['Underwriting Copilot','underwriting'],['GetInsuredAI Copilot','assistant']]) {
  test(`${name} displays its full identity and matching icon`,()=>{
    const html=renderToStaticMarkup(React.createElement(Badge,{name,betaLabel:'BETA'}));
    assert.ok(html.includes(`>${name}</span>`));
    assert.ok(html.includes(`title="${name}"`));
    assert.ok(html.includes(`data-copilot-icon="${icon}"`));
    assert.match(html,/<svg[^>]*aria-hidden="true"/);
    assert.match(html,/BETA/);
    assert.doesNotMatch(html,/copilot-orb/);
  });
}

const Icon=load('components/CopilotRoleIcon.tsx').default;
test('launcher and reply avatars share exactly the badge icon and role colours',()=>{
  for(const name of ['Finance Copilot','Medical Underwriting Copilot','Financial Underwriting Copilot','Claims Copilot','Underwriting Copilot']) {
    const icon=renderToStaticMarkup(React.createElement(Icon,{name}));
    const badge=renderToStaticMarkup(React.createElement(Badge,{name,betaLabel:'BETA'}));
    assert.ok(badge.includes(icon));
    assert.doesNotMatch(icon,/<img|copilot-orb/);
  }
});

test('separately deployed portal and chat packages ship the same role icons',()=>{
  assert.equal(fs.readFileSync('components/CopilotRoleIcon.tsx','utf8'),fs.readFileSync('../frontend/components/CopilotRoleIcon.tsx','utf8'));
});
