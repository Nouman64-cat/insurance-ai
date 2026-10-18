// Render the real checklist, including proposal uploads awaiting OCR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = new URL('../components/workbench/ReviewDocuments.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
}}).outputText;
const component = { exports: {} };
// The workbench shares the portal translation module; assert the English labels.
new Function('require', 'exports', 'module', compiled)(
  name => name === '@/lib/i18n/tx' ? { tx: value => value } : require(name), component.exports, component);
const ReviewDocuments = component.exports.default;
function render(status, received, stalled = false) {
  return renderToStaticMarkup(React.createElement(ReviewDocuments, {
    medical: false, disabled: false, tests: [],
    requiredDocuments: [{ type: 'Bank Statement', received }],
    documents: status ? [{ id: 'saved-proposal-upload', name: 'bank_statement.pdf', type: 'Bank Statement',
      status, processing_stalled: stalled, scope: 'customer' }] : [],
    onUploadFile: async () => {}, onUploaded: () => {}, onOpen: () => {}, onRetry: async () => {},
  })).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}
for (const status of ['Uploaded', 'Processing', 'Processing Failed', 'Accepted', 'Waived']) {
  test(`received proposal upload counts as received when OCR status is ${status}`, () => {
    const text = render(status, true, status === 'Uploaded');
    assert.match(text, /1 of 1 received/);
    assert.doesNotMatch(text, /Needs action|1 outstanding/);
    assert.match(text, /Received from your existing upload/);
    if (status === 'Processing Failed' || status === 'Uploaded') assert.match(text, /Retry reading/);
  });
}
test('a genuinely missing bank statement still requests an upload', () => {
  const text = render(null, false);
  assert.match(text, /0 of 1 received/);
  assert.match(text, /Needs action/);
});
test('an unreadable document returned for resubmission remains outstanding', () => {
  const text = render('Re-submission Requested', false);
  assert.match(text, /0 of 1 received/);
  assert.match(text, /Upload a clearer copy/);
});


test('claim documents shared by application and track requirements render once and count once', () => {
  const legal = 'Legal heir / succession certificate';
  const payee = 'Payee bank account details / cancelled cheque';
  const original = 'Original policy documents';
  const identity = 'Attested CNIC copies for insured and nominee(s)';
  const requiredDocuments = [
    { type: legal, received: false }, { type: payee, received: false },
    { type: original, received: true }, { type: identity, received: true },
  ];
  const props = {
    medical: false, disabled: false, tests: [], requiredDocuments,
    applicationDocuments: [legal, payee].map(type => ({type, reason: 'Required for this claim by the plan.', canUpload: true, owner: null, tag: 'Claim'})),
    documents: [original, identity].map((type, index) => ({id: String(index), name: `received-${index}.pdf`, type, status: 'Accepted', scope: 'application'})),
    onUploadFile: async () => {}, onUploaded: () => {}, onOpen: () => {},
  };
  const markup = renderToStaticMarkup(React.createElement(ReviewDocuments, props));
  const text = markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.equal(markup.split(`<h4 class="text-sm font-semibold text-slate-900">${legal}</h4>`).length - 1, 1);
  assert.equal(markup.split(`<h4 class="text-sm font-semibold text-slate-900">${payee}</h4>`).length - 1, 1);
  assert.match(text, /2 of 4 received/);
  assert.match(text, /2 outstanding/);
  assert.equal((text.match(/Required for this claim by the plan\./g) || []).length, 2);

  // A received document remains one row even if the caller still includes its claim metadata.
  requiredDocuments[0].received = true;
  const updated = renderToStaticMarkup(React.createElement(ReviewDocuments, props)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.match(updated, /3 of 4 received/);
  assert.match(updated, /1 outstanding/);
});
