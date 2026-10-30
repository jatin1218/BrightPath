import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdir,readFile,open,rename,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import lockfile from 'proper-lockfile';
import {postgresProblem,withPostgresState} from './postgres-store.mjs';
import {withBlobState} from './blob-store.mjs';

const scope=new AsyncLocalStorage();
const mapNames=['users','sessions','invites','courses','enrollments','items','quizKeys','files','limits'];
const defaultFile=fileURLToPath(new URL('../data/brightpath.json',import.meta.url));
export const requestState=()=>scope.getStore();
export const runWithState=(holder,execute)=>scope.run(holder,execute);
export const storageMode=()=>process.env.BRIGHTPATH_STORAGE||(process.env.DATABASE_URL?'postgres':process.env.VERCEL==='1'?'postgres':'json');
export const dataFile=()=>resolve(process.env.BRIGHTPATH_DATA_FILE||defaultFile);
export function storageProblem(){
 if(!['postgres','json','blob','memory'].includes(storageMode()))return 'BRIGHTPATH_STORAGE must be postgres, json, blob, or memory (local tests only).';
 if(storageMode()==='postgres')return postgresProblem();
 if(process.env.VERCEL==='1'&&storageMode()!=='blob')return 'Local JSON requires a persistent disk. On Vercel use BRIGHTPATH_STORAGE=blob and connect a private Blob store; see VERCEL_SETUP.md.';
 if(storageMode()==='blob'&&!process.env.BLOB_READ_WRITE_TOKEN&&!(process.env.BLOB_STORE_ID&&process.env.VERCEL_OIDC_TOKEN))return 'Connect a private Vercel Blob store to this environment before using cloud JSON. See VERCEL_SETUP.md.';
 return '';
}
export function encodeState(state){
 const maps={};for(const key of mapNames)maps[key]=[...state[key]].map(([id,value])=>[id,key==='files'?{...value,bytes:Buffer.from(value.bytes).toString('base64')}:value]);
 return JSON.stringify({schemaVersion:1,maps,events:state.events,notifications:state.notifications,settings:state.settings},null,2)+'\n';
}
export function decodeState(raw){
 const d=JSON.parse(raw);
 if(d.schemaVersion!==1||!d.maps||!Array.isArray(d.events)||!Array.isArray(d.notifications)||typeof d.settings?.requireStaffMfa!=='boolean')throw Error('Invalid data schema');
 const state={events:d.events,notifications:d.notifications,settings:d.settings};
 for(const key of mapNames){
  const rows=d.maps[key];if(!Array.isArray(rows)||rows.some(r=>!Array.isArray(r)||r.length!==2||typeof r[0]!=='string'||r[1]===null)||new Set(rows.map(r=>r[0])).size!==rows.length)throw Error('Invalid data collection');
  state[key]=new Map(rows.map(([id,value])=>{
   if(key==='files'){
    if(typeof value.bytes!=='string'||!Number.isInteger(value.size)||value.size<1)throw Error('Invalid saved attachment');
    const bytes=Buffer.from(value.bytes,'base64');if(bytes.length!==value.size||bytes.toString('base64')!==value.bytes)throw Error('Invalid saved attachment');
    value={...value,bytes};
   }
   return [id,value];
  }));
 }
 return state;
}
async function atomicWrite(path,content){
 const temporary=path+'.'+randomUUID()+'.tmp';let file;
 try{file=await open(temporary,'wx',0o600);await file.writeFile(content,'utf8');await file.sync();await file.close();file=null;await rename(temporary,path)}
 finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{})}
}
const unavailable=message=>Response.json({apiVersion:8,configured:false,storage:storageMode(),user:null,error:message},{status:503,headers:{'cache-control':'no-store'}});
// Serialize within a process; proper-lockfile also protects two Node processes sharing the same file.
let queue=Promise.resolve();
export async function withFileState(request,initial,execute){
 const problem=storageProblem();if(problem)return unavailable(problem);
 if(storageMode()==='postgres')return withPostgresState(request,initial,execute,{encodeState,decodeState,run:runWithState});
 if(storageMode()==='memory')return execute(request);
 if(storageMode()==='blob')return withBlobState(request,execute,{encodeState,decodeState,run:runWithState});
 const previous=queue;let done;queue=new Promise(r=>{done=r});await previous;
 let release,compromised=false;
 try{
  const path=dataFile();await mkdir(dirname(path),{recursive:true,mode:0o700});
  release=await lockfile.lock(path,{realpath:false,stale:10000,update:2000,retries:{retries:25,factor:1,minTimeout:500,maxTimeout:500},onCompromised:()=>{compromised=true}});
  let original=null;
  try{original=await readFile(path,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
  let state;
  try{state=original===null?initial():decodeState(original)}catch{return unavailable('The saved JSON data is invalid. It has not been overwritten. Stop the server and restore data/brightpath.json.bak using SETUP.md.')}
  const holder={state};const response=await scope.run(holder,()=>execute(request));
  if(response.status>=500)return response;
  const next=encodeState(holder.state);
  if(compromised)return unavailable('Data file lock was interrupted. Nothing was saved. Retry after restarting the server.');
  if(next!==original){
   // Keep the previous valid generation for manual recovery. Never replace corrupt data automatically.
   if(original!==null)await atomicWrite(path+'.bak',original);
   if(compromised)return unavailable('Data file lock was interrupted. Nothing was saved. Please retry.');
   await atomicWrite(path,next);
  }
  // Cookies and successful responses are only returned after the disk commit succeeds.
  return response;
 }catch(e){
  console.error(JSON.stringify({event:'json_storage_error',code:e.code||'STORAGE_ERROR'}));
  return unavailable(e.code==='ELOCKED'?'The data file is busy. Retry shortly.':'Unable to read or save the JSON data file. Check disk space and folder permissions. No successful save was confirmed.');
 }finally{await release?.().catch(()=>{});done()}
}
