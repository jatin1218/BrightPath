import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {handleApi} from '../server/api.mjs';
const exec=promisify(execFile),password='JSON_persistence_password123!',jar=()=>({cookie:''});
async function request(j,path,method='GET',body,expected=200,extra={}){
 const r=await handleApi(new Request('https://json.example/api/'+path,{method,headers:{cookie:j.cookie,origin:'https://json.example',...(body?{'content-type':'application/json'}:{}),...extra},body:body===undefined?undefined:extra['x-filename']?body:JSON.stringify(body)}));
 const raw=await r.text();assert.equal(r.status,expected,raw);for(const c of r.headers.getSetCookie())if(c.startsWith('bp_memory='))j.cookie=c.split(';')[0];
 return r.headers.get('content-type')?.startsWith('application/json')?JSON.parse(raw):raw;
}
const post=(j,p,b,e)=>request(j,p,'POST',b,e),get=(j,p,e)=>request(j,p,'GET',undefined,e);
async function freshProcess(cookie,path,body){
 const script=`import {handleApi} from './server/api.mjs';const input=JSON.parse(process.argv[1]);const r=await handleApi(new Request('https://json.example/api/'+input.path,{method:input.body?'POST':'GET',headers:{cookie:input.cookie,origin:'https://json.example',...(input.body?{'content-type':'application/json'}:{})},body:input.body?JSON.stringify(input.body):undefined}));const text=await r.text();console.log(JSON.stringify({status:r.status,body:r.headers.get('content-type')?.startsWith('application/json')?JSON.parse(text):text}));`;
 const {stdout}=await exec(process.execPath,['--input-type=module','-e',script,JSON.stringify({cookie,path,body})],{cwd:new URL('..',import.meta.url),env:{...process.env,BRIGHTPATH_STORAGE:'json'}});return JSON.parse(stdout);
}
test('JSON data persists across independent Node processes and fails safely',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'brightpath-json-')),path=join(dir,'data','brightpath.json');
 process.env.BRIGHTPATH_STORAGE='json';process.env.BRIGHTPATH_DATA_FILE=path;delete process.env.VERCEL;
 t.after(async()=>{delete process.env.BRIGHTPATH_DATA_FILE;delete process.env.VERCEL;process.env.BRIGHTPATH_STORAGE='memory';await rm(dir,{recursive:true,force:true})});
 const admin=jar(),educator=jar(),learner=jar();let cid,educatorId,learnerId,fileId;
 await t.test('fresh installation saves accounts, password hashes and sessions to JSON',async()=>{
  const r=await post(admin,'auth/register',{name:'JSON Owner',email:'owner@json.example',password,role:'coordinator'});assert.equal(r.user.role,'coordinator');
  const raw=await readFile(path,'utf8'),d=JSON.parse(raw);assert.equal(d.schemaVersion,1);assert.equal(d.maps.users.length,1);assert.equal(d.maps.sessions.length,1);assert(!raw.includes(password));assert(raw.includes('passwordHash'));assert.equal((await get(admin,'health')).storage,'json');
  if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
 });
 await t.test('course, learner attendance, educator attendance, notes and attachments are saved',async()=>{
  const inv=await post(admin,'auth/invites',{email:'educator@json.example',role:'educator'});
  educatorId=(await post(educator,'auth/register',{name:'JSON Teacher',email:'educator@json.example',password,role:'educator',inviteCode:inv.code})).user.id;
  learnerId=(await post(learner,'auth/register',{name:'JSON Student',email:'student@json.example',password,role:'learner'})).user.id;
  await post(admin,'hub',{action:'account',payload:{id:learnerId,status:'active'}});
  cid=(await post(admin,'courses',{title:'Persistent course',educatorIds:[educatorId],topics:['Persistent topic']})).id;
  await post(admin,'enrollments',{courseId:cid,learnerId});const today=(await get(admin,'attendance')).today;
  let record=await post(educator,'attendance',{courseId:cid,date:today,period:1,kind:'lecture'});
  await request(educator,'attendance/'+record.id,'PATCH',{action:'submit',revision:1,marks:record.roster.map(r=>({...r,status:'present'}))});
  record=await post(admin,'educator-attendance',{courseId:cid,date:today,period:1});await request(admin,'educator-attendance/'+record.id,'PATCH',{action:'submit',revision:1,marks:record.roster.map(r=>({...r,status:'late'}))});
  await request(learner,'classroom/notes/'+cid,'PATCH',{revision:0,content:'My saved private note'});
  const material=await post(educator,'classroom/materials',{courseId:cid,kind:'notes',title:'Persistent attachment',hasUpload:true});
  const file=await request(educator,'classroom/materials/'+material.id+'/file','POST',Buffer.from('Saved lesson file'),200,{'content-type':'text/plain','x-filename':'lesson.txt','x-revision':'1'});fileId=file.id;
  assert(JSON.parse(await readFile(path,'utf8')).maps.files.length===1);assert((await stat(path+'.bak')).size>0);
 });
 await t.test('restart preserves login cookies, role permissions, records and exact attachment bytes',async()=>{
  const self=await freshProcess(admin.cookie,'auth/status');assert.equal(self.status,200);assert.equal(self.body.user.email,'owner@json.example');assert.equal(self.body.coordinatorSetupRequired,false);
  const data=await freshProcess(learner.cookie,'data');assert.equal(data.status,200);assert.equal(data.body.courses[0].title,'Persistent course');assert.equal(data.body.enrollments[0].attendanceRate,100);assert(data.body.items.some(i=>i._kind==='note'&&i.content==='My saved private note'));assert(!data.body.items.some(i=>i._kind==='educatorAttendance'));
  const teaching=await freshProcess(educator.cookie,'educator-attendance');assert.equal(teaching.body.sessions[0].roster[0].status,'late');
  const file=await freshProcess(learner.cookie,'classroom/files/'+fileId);assert.equal(file.status,200);assert.equal(file.body,'Saved lesson file');
 });
 await t.test('concurrent processes preserve both updates using the same JSON file',async()=>{
  const results=await Promise.all([freshProcess(admin.cookie,'courses',{title:'Parallel A'}),freshProcess(admin.cookie,'courses',{title:'Parallel B'})]);assert(results.every(r=>r.status===200));const d=await get(admin,'data');assert(d.courses.some(c=>c.title==='Parallel A'));assert(d.courses.some(c=>c.title==='Parallel B'));
 });
 await t.test('invalid mutations roll back; malformed JSON is never replaced with an empty workspace',async()=>{
  const before=await readFile(path,'utf8');await request(admin,'courses/'+cid,'PATCH',{title:'Must not survive',educatorIds:['missing']},400);assert.equal(await readFile(path,'utf8'),before);
  await writeFile(path,'{ damaged JSON');const error=await get(admin,'data',503);assert(error.error.includes('not been overwritten'));assert.equal(await readFile(path,'utf8'),'{ damaged JSON');
  await copyFile(path+'.bak',path);assert.equal((await get(admin,'auth/status')).user.email,'owner@json.example');
 });
 await t.test('storage errors never report a successful registration or switch to memory',async()=>{
  const blocker=join(dir,'not-a-directory');await writeFile(blocker,'blocked');process.env.BRIGHTPATH_DATA_FILE=join(blocker,'state.json');
  await post(jar(),'auth/register',{name:'No Disk',email:'failed@json.example',password,role:'coordinator'},503);process.env.BRIGHTPATH_DATA_FILE=path;
  assert(!(await get(admin,'data')).profiles.some(p=>p.email==='failed@json.example'));
 });
 await t.test('Vercel is rejected explicitly rather than pretending its local files are permanent',async()=>{
  process.env.VERCEL='1';const d=await get(admin,'auth/status',503);assert.equal(d.configured,false);assert(d.error.includes('persistent disk'));delete process.env.VERCEL;
 });
});
