import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withBlobState} from '../server/blob-store.mjs';
import {encodeState,decodeState,runWithState,requestState,storageMode,storageProblem} from '../server/file-store.mjs';
import {initial} from '../server/memory.mjs';
import {handleApi} from '../server/api.mjs';

class Conflict extends Error{}
function store(){
 const s={raw:encodeState(initial()),version:1,reads:0,writes:0,failWrite:false};
 s.sdk={BlobPreconditionFailedError:Conflict,
  async get(path,options){
   assert.equal(options.access,'private');assert.equal(options.useCache,false);s.reads++;
   return s.raw===null?null:{statusCode:200,stream:new Response(s.raw).body,blob:{etag:String(s.version)}};
  },
  async put(path,raw,options){
   assert.equal(options.access,'private');assert.equal(options.allowOverwrite,true);assert.equal(options.addRandomSuffix,false);
   if(s.failWrite)throw Error('Provider unavailable');
   if(options.ifMatch!==String(s.version))throw new Conflict();
   s.raw=raw;s.version++;s.writes++;return {etag:String(s.version)};
  },
 };return s;
}
const context={encodeState,decodeState,run:runWithState};
const run=(s,fn,req=new Request('https://cloud.example/api/data'))=>withBlobState(req,fn,context,s.sdk);
const api=(s,path,body,cookie='')=>run(s,handleApi,new Request('https://cloud.example/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://cloud.example','content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined}));

test('private cloud JSON keeps real accounts, login sessions and courses across isolated requests',async()=>{
 const s=store(),password='Cloud_json_password_123!';
 let r=await api(s,'auth/register',{name:'Cloud Coordinator',email:'owner@cloud.example',role:'coordinator',password});
 assert.equal(r.status,200,await r.clone().text());const cookie=r.headers.get('set-cookie').split(';')[0];
 assert(!s.raw.includes(password));assert.equal(decodeState(s.raw).sessions.size,1);
 // Each read decodes a new object; no shared in-process model is used.
 r=await api(s,'auth/status',undefined,cookie);assert.equal((await r.json()).user.email,'owner@cloud.example');
 r=await api(s,'courses',{title:'Durable cloud course'},cookie);assert.equal(r.status,200);
 r=await api(s,'data',undefined,cookie);assert.equal((await r.json()).courses[0].title,'Durable cloud course');
 const reads=s.reads;
 r=await api(s,'auth/logout',{},cookie);assert.equal(r.status,200);
 r=await api(s,'auth/status',undefined,cookie);assert.equal((await r.json()).user,null);assert(s.reads>reads);
});
test('simultaneous changes use CAS; conflict does not overwrite the winner or return its cookie',async()=>{
 const s=store();let count=0,release;const gate=new Promise(r=>release=r);
 const change=id=>run(s,async()=>{
  requestState().state.courses.set(id,{id,title:id});if(++count===2)release();await gate;
  return Response.json({ok:true},{headers:{'set-cookie':'must-only-return-if-committed=1'}});
 });
 const responses=await Promise.all([change('A'),change('B')]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(s.writes,1);
 const failed=responses.find(r=>r.status===409);assert.equal(failed.headers.get('set-cookie'),null);
 const winner=[...decodeState(s.raw).courses.keys()][0],other=winner==='A'?'B':'A';
 const retry=await run(s,()=>{requestState().state.courses.set(other,{id:other});return Response.json({ok:true})});
 assert.equal(retry.status,200);assert.equal(decodeState(s.raw).courses.size,2);
});
test('first-coordinator race permits exactly one coordinator without an invitation',async()=>{
 const s=store(),body={name:'First Owner',role:'coordinator',password:'Cloud_race_password123!'};
 const results=await Promise.all([api(s,'auth/register',{...body,email:'a@cloud.example'}),api(s,'auth/register',{...body,email:'b@cloud.example'})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(decodeState(s.raw).users.size,1);
 const winner=[...decodeState(s.raw).users.values()][0].email,other=winner.startsWith('a@')?'b@cloud.example':'a@cloud.example';
 const retry=await api(s,'auth/register',{...body,email:other});assert.equal(retry.status,403);assert.equal(decodeState(s.raw).users.size,1);
});
test('failed cloud commit does not issue login cookies or leak state into another request',async()=>{
 const s=store();s.failWrite=true;
 const r=await api(s,'auth/register',{name:'Failed Save',email:'failed@cloud.example',role:'coordinator',password:'Failed_cloud_password123!'});
 assert.equal(r.status,503);assert.equal(r.headers.get('set-cookie'),null);assert.equal(decodeState(s.raw).users.size,0);
 s.failWrite=false;const status=await api(s,'auth/status');assert.equal((await status.json()).coordinatorSetupRequired,true);
});
test('missing, corrupt and unavailable cloud data never silently create a new workspace',async()=>{
 for(const raw of [null,'{broken']){const s=store();s.raw=raw;let called=false;const r=await run(s,()=>{called=true;return Response.json({})});assert.equal(r.status,503);assert.equal(called,false);assert.equal(s.raw,raw);assert.equal(s.writes,0)}
 const s=store();s.sdk.get=async()=>{throw Error('Offline')};const r=await run(s,()=>Response.json({}));assert.equal(r.status,503);assert.equal(s.writes,0);
});
test('unchanged reads avoid writes, 500 rolls back, and attachments retain exact bytes',async()=>{
 const s=store();let r=await run(s,()=>Response.json({ok:true}));assert.equal(r.status,200);assert.equal(s.writes,0);
 r=await run(s,()=>{requestState().state.courses.set('fail',{});return Response.json({error:'failure'},{status:500})});assert.equal(r.status,500);assert.equal(s.writes,0);
 const bytes=Buffer.from([0,255,17,18]);
 await run(s,()=>{requestState().state.files.set('f',{id:'f',size:bytes.length,bytes});return Response.json({ok:true})});
 await run(s,()=>{assert.deepEqual(requestState().state.files.get('f').bytes,bytes);return Response.json({ok:true})});assert.equal(s.writes,1);
});
test('explicit legacy Blob mode refuses missing credentials or local-only storage',()=>{
 const keys=['VERCEL','BRIGHTPATH_STORAGE','BLOB_READ_WRITE_TOKEN','BLOB_STORE_ID','VERCEL_OIDC_TOKEN'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  for(const k of keys)delete process.env[k];process.env.VERCEL='1';process.env.BRIGHTPATH_STORAGE='blob';assert.equal(storageMode(),'blob');assert(storageProblem().includes('private'));
  process.env.BLOB_STORE_ID='store_test';process.env.VERCEL_OIDC_TOKEN='not-a-real-token';assert.equal(storageProblem(),'');
  process.env.BRIGHTPATH_STORAGE='json';assert(storageProblem().includes('persistent disk'));
 }finally{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k]}
});
