const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
const output=ts.transpileModule(fs.readFileSync('lib/voice/proxy.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const moduleStub={exports:{}};
vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(name=>name==='@/lib/sso'?{API_GATEWAY_INTERNAL_URL:'http://gateway',SSO_COOKIE_NAME:'insurance_sso'}:require(name),moduleStub,moduleStub.exports);
const {proxyVoice,proxyVoiceChat}=moduleStub.exports;
function request(tenant='t1',body={role:'SuperAdmin',thread_id:'thread'}){
 return {cookies:{get:()=>({value:'verified-cookie'})},headers:new Headers({'x-tenant-id':tenant,'content-type':'application/json'}),signal:new AbortController().signal,
 json:async()=>body,arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(body)).buffer};
}
test('unsigned voice setup cannot reach any provider',async()=>{
 const original=global.fetch;let called=false;global.fetch=async()=>{called=true;};
 try{const req=request();req.cookies.get=()=>undefined;const res=await proxyVoice(req,'session');assert.equal(res.status,401);assert.equal(called,false);}finally{global.fetch=original;}
});
test('voice platform action derives the role from verified identity',async()=>{
 const original=global.fetch;const calls=[];
 global.fetch=async(url,opts)=>{calls.push({url,opts});return calls.length===1?Response.json({id:'u',is_active:true,status:'ACTIVE',role_name:'Agent',tenant_id:'t1'}):new Response('data: {"type":"done"}\n\n');};
 try{const res=await proxyVoiceChat(request(),'stream');assert.equal(res.status,200);const forwarded=JSON.parse(calls[1].opts.body);assert.equal(forwarded.role,'Agent');assert.equal(forwarded.platform,'web');assert.equal(calls[1].opts.headers.Authorization,'Bearer verified-cookie');}finally{global.fetch=original;}
});
test('cross-tenant and inactive users never enter the graph',async()=>{
 const original=global.fetch;
 try{
  for(const user of [{is_active:true,status:'ACTIVE',role_name:'Agent',tenant_id:'other'},{is_active:false,status:'ACTIVE',role_name:'Agent',tenant_id:'t1'}]){
   let calls=0;global.fetch=async()=>{calls++;return Response.json(user);};
   assert.equal((await proxyVoiceChat(request(),'resume')).status,403);assert.equal(calls,1);
  }
 }finally{global.fetch=original;}
});
test('expired sessions return 401 without forwarding the mutation',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;return new Response('',{status:401});};
 try{assert.equal((await proxyVoiceChat(request(),'resume')).status,401);assert.equal(calls,1);}finally{global.fetch=original;}
});
