// Run inside the app container: node --test tests/realtime.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS}}).outputText;
  const module = {exports: {}};
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(require, module, module.exports);
  return module.exports;
}
const {confirmationAnswer} = load('lib/voice/protocol.ts');
const {RealtimeConnection} = load('lib/voice/RealtimeConnection.ts');
function call(invoke = async () => ({message: 'Done'})) {
  const events = [], captions = [], statuses = [];
  const connection = new RealtimeConnection({locale: 'en', context: [], onStatus: s => statuses.push(s), onCaption: c => captions.push(c), onError: () => {}, onPlaybackBlocked: () => {}, onPlatformRequest: invoke});
  connection.channel = {readyState: 'open', send: data => events.push(JSON.parse(data)), close() {this.readyState='closed';}};
  connection.ready = true;
  return {connection, events, captions, statuses};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('confirmation requires unambiguous actual consent', () => {
  assert.equal(confirmationAnswer('Yes.'), 'Yes');
  assert.equal(confirmationAnswer('جی ہاں۔'), 'Yes');
  assert.equal(confirmationAnswer('Cancel!'), 'Cancel');
  for (const text of ['yes, but do not delete it', 'Did I say yes?', 'maybe', '']) assert.equal(confirmationAnswer(text), null);
});
test('streaming captions update one item instead of duplicating lines', () => {
  const {connection,captions} = call();
  connection.receive({type:'response.output_audio_transcript.delta',item_id:'a',delta:'Hello'});
  connection.receive({type:'response.output_audio_transcript.delta',item_id:'a',delta:' there'});
  connection.receive({type:'response.output_audio_transcript.done',item_id:'a',transcript:'Hello there!'});
  assert.deepEqual(captions.map(c=>c.text),['Hello','Hello there','Hello there!']);
  assert.ok(captions.every(c=>c.id==='a')); connection.close();
});
test('duplicate function events execute the platform request once', async () => {
  let executions = 0;
  const {connection,events} = call(async ()=>{executions++; return {message:'Done'};});
  const fn={name:'platform_request',call_id:'c1',arguments:'{"request":"Show my earnings"}'};
  connection.receive({type:'response.function_call_arguments.done',...fn});
  connection.receive({type:'response.done',response:{status:'completed',output:[{type:'function_call',...fn}]}});
  await tick(); assert.equal(executions,1);
  assert.equal(events.filter(e=>e.type==='conversation.item.create').length,1); connection.close();
});
test('tool results wait until the current response finishes', async () => {
  const {connection,events} = call();
  connection.receive({type:'response.created'});
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'c',arguments:'{"request":"Show a case"}'});
  await tick(); assert.equal(events.filter(e=>e.type==='response.create').length,0);
  connection.receive({type:'response.done',response:{status:'completed',output:[]}});
  assert.equal(events.filter(e=>e.type==='response.create').length,1); connection.close();
});
test('mute and interruption affect real audio resources', () => {
  const {connection,events} = call(); const track={enabled:true,stop(){}};
  connection.mic={getAudioTracks:()=>[track],getTracks:()=>[track]};
  connection.mute(true); assert.equal(track.enabled,false); connection.mute(false); assert.equal(track.enabled,true);
  connection.responseActive=true; connection.speaking=true; connection.interrupt();
  assert.deepEqual(events.map(e=>e.type),['response.cancel','output_audio_buffer.clear']); connection.close();
});
test('closing while a tool is running never sends stale audio or repeats action', async () => {
  let complete; const pending=new Promise(r=>complete=r);
  const {connection,events} = call(()=>pending);
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'c',arguments:'{"request":"Run an action"}'});
  connection.close(); complete({message:'Done'}); await tick(); assert.equal(events.length,0);
});
test('model-generated confirmation cannot count as a heard user answer', async () => {
  let heard;
  const {connection} = call(async (_,actual)=>{heard=actual; return {message:'Please confirm',pending:'confirm'};});
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'c',arguments:'{"request":"yes"}'});
  await tick(); assert.equal(heard,false); connection.close();
});
test('old or unrelated transcription cannot authorize a new turn', async () => {
  let heard;
  const {connection} = call(async (_,actual)=>{heard=actual; return {message:'Please confirm'};});
  connection.receive({type:'input_audio_buffer.speech_started',item_id:'old'});
  connection.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'old',transcript:'yes'});
  connection.receive({type:'input_audio_buffer.speech_started',item_id:'new'});
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'c',arguments:'{"request":"yes"}'});
  await new Promise(r=>setTimeout(r,1250)); assert.equal(heard,false); connection.close();
});
test('late microphone permission stops tracks after call closes', async () => {
  let resolve; const streamPromise=new Promise(r=>resolve=r); let stopped=0;
  global.window={isSecureContext:true,RTCPeerConnection:function(){}};
  Object.defineProperty(global,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>streamPromise}}});
  const {connection}=call(); const start=connection.start(); connection.close();
  resolve({getTracks:()=>[{stop:()=>stopped++}]}); await start; assert.equal(stopped,1);
});

test('delayed transcription supplies actual consent without asking twice', async () => {
  let heard, request;
  const {connection}=call(async (text, actual)=>{request=text;heard=actual;return {message:'Done'};});
  connection.receive({type:'input_audio_buffer.speech_started',item_id:'new'});
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'c',arguments:'{"request":"yes"}'});
  await tick(); assert.equal(heard,undefined);
  connection.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'new',transcript:'Yes.'});
  await tick(); assert.equal(heard,true); assert.equal(request,'Yes.'); connection.close();
});

test('the same spoken instruction cannot be delegated twice with different call IDs', async () => {
  let calls=0;
  const {connection}=call(async()=>{calls++;return {message:'Please confirm',pending:'confirm'};});
  connection.receive({type:'input_audio_buffer.speech_started',item_id:'u'});
  connection.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'Delete this customer'});
  const event={type:'response.function_call_arguments.done',name:'platform_request',arguments:'{"request":"Delete this customer"}'};
  connection.receive({...event,call_id:'one'}); await tick();
  connection.receive({...event,call_id:'two'}); await tick();
  assert.equal(calls,1);connection.close();
});

test('Urdu speech gets an Urdu tool summary even in an English portal', async () => {
  let request;
  const {connection,events}=call(async text=>{request=text;return {message:'One approved claim awaits authorisation.'};});
  connection.receive({type:'input_audio_buffer.speech_started',item_id:'urdu'});
  connection.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'urdu',transcript:'میرے کلیم کی تفصیل دکھائیں'});
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'urdu-tool',arguments:'{"request":"Show my claim"}'});
  await tick();
  assert.equal(request,'میرے کلیم کی تفصیل دکھائیں');
  const reply=events.find(e=>e.type==='response.create');
  assert.match(reply.response.instructions,/Pakistani Urdu/);
  assert.equal(reply.response.tool_choice,'none');
  connection.close();
});

test('Roman Urdu and brief confirmations retain Urdu, with an explicit language override', () => {
  const {connection}=call();
  connection.matchLanguage('mujhe claim ki details dikhao');assert.equal(connection.replyLanguage,'ur');
  connection.matchLanguage('Yes');assert.equal(connection.replyLanguage,'ur');
  connection.matchLanguage('Please respond in Urdu');
  connection.matchLanguage('Show my approved claim');assert.equal(connection.replyLanguage,'ur');
  connection.matchLanguage('Please speak English');assert.equal(connection.replyLanguage,'en');
  connection.close();
});

test('Hindi-script transcription is not delegated as business action or consent', async () => {
  let calls=0;
  const {connection,captions}=call(async()=>{calls++;return {message:'Done'};});
  connection.receive({type:'input_audio_buffer.speech_started',item_id:'bad-caption'});
  connection.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'bad-caption',transcript:'हाँ'});
  connection.receive({type:'response.function_call_arguments.done',name:'platform_request',call_id:'bad-language',arguments:'{"request":"yes"}'});
  await tick();
  assert.equal(calls,0);assert.ok(captions.every(c=>!/[\u0900-\u097f]/.test(c.text)));
  assert.equal(connection.replyLanguage,'ur');connection.close();
});

test('Hindi output is interrupted and repaired in Urdu without another business tool', () => {
  const {connection,events,captions}=call();
  connection.receive({type:'response.created'});
  connection.receive({type:'response.output_audio_transcript.delta',item_id:'bad-output',delta:'नमस्ते'});
  assert.ok(events.some(e=>e.type==='response.cancel'));
  assert.ok(captions.every(c=>!/[\u0900-\u097f]/.test(c.text)));
  connection.receive({type:'response.done',response:{status:'cancelled',output:[]}});
  const reply=events.find(e=>e.type==='response.create');
  assert.equal(reply.response.tool_choice,'none');assert.match(reply.response.instructions,/Correct the last answer into Urdu/);
  connection.close();
});
