import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {withPostgresState} from '../server/postgres-store.mjs';
import {initial} from '../server/memory.mjs';
import {encodeState,decodeState,runWithState} from '../server/file-store.mjs';
import {handleRequest} from '../server/api.mjs';
process.env.BRIGHTPATH_STORAGE='postgres';
process.env.DATABASE_URL='postgresql://postgres:local-test-only@localhost/brightpath';
const db=new PGlite();
const migration=await readFile(new URL('../sql/001_supabase_multicenter.sql',import.meta.url),'utf8');
await db.exec(migration);await db.exec(migration);
let queue=Promise.resolve();
// PGlite is real PostgreSQL/WASM with a single connection. This pool adapter
// reserves that connection until release, as pg.Pool does in production.
const pool={async connect(){const wait=queue;let release;queue=new Promise(r=>release=r);await wait;return {query:(s,p)=>db.query(s,p),release}}};
const helpers={encodeState,decodeState,run:runWithState};
const pw='Local-test-password-234!';
async function req(path,body,cookie='',method=body?'POST':'GET',execute=handleRequest){
 const request=new Request('https://brightpath.test/api/'+path,{method,headers:{cookie,...(body?{'content-type':'application/json','origin':'https://brightpath.test'}:{})},body:body?JSON.stringify(body):undefined});
 const response=await withPostgresState(request,initial,execute,helpers,pool);
 const set=response.headers.getSetCookie();const next=set.map(v=>v.split(';')[0]).filter(v=>!v.endsWith('=')).join('; ');
 return {status:response.status,data:await response.json(),cookie:next||cookie,headers:response.headers};
}
const create=(name,email='owner@example.test')=>req('auth/register',{name:'Center Owner',email,password:pw,role:'coordinator',newCenter:true,centerName:name});
let a,b,courseId;
test('independent coordinators create separate centers, including same email',async()=>{
 a=await create('Alpha Learning');b=await create('Beta Learning');assert.equal(a.status,200);assert.equal(b.status,200);
 assert.notEqual(a.data.user.center.id,b.data.user.center.id);assert.notEqual(a.data.user.center.code,b.data.user.center.code);
 assert.match(a.cookie,/bp_center=/);assert.match(a.cookie,/bp_memory=/);
 assert.equal((await req('auth/status',null,a.cookie)).data.user.center.name,'Alpha Learning');
});
test('coordinators cannot read or change another center records, even with IDs',async()=>{
 const made=await req('courses',{title:'Alpha private course',educatorIds:[]},a.cookie);assert.equal(made.status,200);courseId=made.data.id;
 assert.equal((await req('data',null,b.cookie)).data.courses.length,0);
 assert.equal((await req('courses/'+courseId,{title:'Hijacked'},b.cookie,'PATCH')).status,404);
 const forged=a.cookie.replace(a.data.user.center.code,b.data.user.center.code);
 assert.equal((await req('data',null,forged)).status,401);
 assert.equal((await req('data',null,a.cookie)).data.courses[0].title,'Alpha private course');
});
test('existing center requires exact-email staff invitation; new-center bypass is not possible',async()=>{
 const code=a.data.user.center.code;
 assert.equal((await req('auth/register',{name:'Other Staff',email:'staff@example.test',password:pw,role:'coordinator',centerCode:code})).status,403);
 const invite=await req('auth/invites',{email:'staff@example.test',role:'coordinator'},a.cookie);assert.equal(invite.status,200);
 const wrongCenter=await req('auth/register',{name:'Other Staff',email:'staff@example.test',password:pw,role:'coordinator',centerCode:b.data.user.center.code,inviteCode:invite.data.code});assert.equal(wrongCenter.status,403);
 const added=await req('auth/register',{name:'Other Staff',email:'staff@example.test',password:pw,role:'coordinator',centerCode:code,inviteCode:invite.data.code});assert.equal(added.status,200);assert.equal(added.data.user.center.id,a.data.user.center.id);
 const invalid=await req('auth/register',{name:'Student',email:'s@example.test',password:pw,role:'learner',newCenter:true,centerName:'Invalid'});assert.equal(invalid.status,400);
});
test('learners join the chosen center pending approval; other coordinators cannot approve them',async()=>{
 const learner=await req('auth/register',{name:'Real Learner',email:'learner@example.test',password:pw,role:'learner',centerCode:a.data.user.center.code});assert.equal(learner.status,200);assert.equal(learner.data.user.status,'pending');
 assert.equal((await req('hub',{action:'account',payload:{id:learner.data.user.id,status:'active'}},b.cookie)).status,404);
 assert.equal((await req('hub',{action:'account',payload:{id:learner.data.user.id,status:'active'}},a.cookie)).status,200);
 assert.equal((await req('educators',null,learner.cookie)).status,403);
 assert.equal((await req('courses',{title:'Forbidden'},learner.cookie)).status,403);
});
test('database preserves educator teaching, both attendance registers, private notes and files',async()=>{
 const centerCode=a.data.user.center.code;
 const invite=await req('auth/invites',{email:'teacher@example.test',role:'educator'},a.cookie);
 const teacher=await req('auth/register',{name:'Teacher',email:'teacher@example.test',password:pw,role:'educator',centerCode,inviteCode:invite.data.code});assert.equal(teacher.status,200);
 const learner=await req('auth/login',{email:'learner@example.test',password:pw,role:'learner',centerCode});assert.equal(learner.status,200);
 assert.equal((await req('courses/'+courseId,{educatorIds:[teacher.data.user.id]},a.cookie,'PATCH')).status,200);
 assert.equal((await req('enrollments',{courseId,learnerId:learner.data.user.id},a.cookie)).status,200);
 const topic=await req('courses/'+courseId+'/topics',{title:'First topic'},teacher.cookie);assert.equal(topic.status,200);
 const today=(await req('attendance',null,teacher.cookie)).data.today;
 const at=await req('attendance',{courseId,date:today,period:1,kind:'lecture'},teacher.cookie);assert.equal(at.status,200);
 const marks=at.data.roster.map(r=>({enrollmentId:r.enrollmentId,status:'present',remark:''}));
 assert.equal((await req('attendance/'+at.data.id,{revision:1,action:'submit',marks},teacher.cookie,'PATCH')).status,200);
 assert.equal((await req('attendance',null,learner.cookie)).data.sessions.length,1);
 const ea=await req('educator-attendance',{courseId,date:today,period:1},a.cookie);assert.equal(ea.status,200);
 assert.equal((await req('educator-attendance/'+ea.data.id,{revision:1,action:'submit',marks:[{educatorId:teacher.data.user.id,status:'present',remark:''}]},a.cookie,'PATCH')).status,200);
 assert.equal((await req('educator-attendance',null,teacher.cookie)).status,200);
 assert.equal((await req('educator-attendance',null,learner.cookie)).status,403);
 assert.equal((await req('classroom/notes/'+courseId,{content:'Private note survives SQL',revision:0},learner.cookie,'PATCH')).status,200);
 assert.equal((await req('classroom?courseId='+courseId,null,learner.cookie)).data.note.content,'Private note survives SQL');
 assert.ok(!(await req('data',null,a.cookie)).data.items.some(x=>x.content==='Private note survives SQL'));
 const material=await req('classroom/materials',{courseId,kind:'pdf',title:'PDF',hasUpload:true},teacher.cookie);assert.equal(material.status,200);
 const bytes=Buffer.from('%PDF-1.4\nSQL file persistence');
 const upload=await withPostgresState(new Request('https://brightpath.test/api/classroom/materials/'+material.data.id+'/file',{method:'POST',headers:{cookie:teacher.cookie,'content-type':'application/pdf','x-filename':'notes.pdf','x-revision':'1'},body:bytes}),initial,handleRequest,helpers,pool);
 assert.equal(upload.status,200);const file=await upload.json();
 const downloaded=await withPostgresState(new Request('https://brightpath.test/api/classroom/files/'+file.id,{headers:{cookie:learner.cookie}}),initial,handleRequest,helpers,pool);
 assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
 assert.equal((await req('classroom/files/'+file.id,null,b.cookie)).status,404);
});
test('concurrent changes persist and read requests do not rewrite records',async()=>{
 const results=await Promise.all([req('courses',{title:'One'},a.cookie),req('courses',{title:'Two'},a.cookie)]);assert.ok(results.every(r=>r.status===200));
 const data=await req('data',null,a.cookie);assert.equal(data.data.courses.length,3);
 const before=await db.query('SELECT data FROM brightpath_private.courses ORDER BY record_key');await req('data',null,a.cookie);const after=await db.query('SELECT data FROM brightpath_private.courses ORDER BY record_key');assert.deepEqual(after.rows,before.rows);
});
test('database RLS prevents tenant escape even without WHERE clause',async()=>{
 await db.query('BEGIN');try{await db.query('SET LOCAL ROLE brightpath_runtime');await db.query("SELECT set_config('brightpath.center_id',$1,true)",[b.data.user.center.id]);
 const r=await db.query('SELECT * FROM brightpath_private.courses');assert.equal(r.rows.length,0);
 await assert.rejects(db.query('INSERT INTO brightpath_private.courses(center_id,record_key,data) VALUES($1,$2,$3)',[a.data.user.center.id,'bad','{}']),/row-level security/);
 }finally{await db.query('ROLLBACK')}
});
test('failed registration or failed commit does not create a center or issue session cookies',async()=>{
 const count=async()=>Number((await db.query('SELECT count(*) AS n FROM brightpath_private.centers')).rows[0].n);
 const n=await count();assert.equal((await req('auth/register',{name:'No',email:'bad',password:pw,role:'coordinator',newCenter:true,centerName:'Should not exist'})).status,400);assert.equal(await count(),n);
 const broken={async connect(){const c=await pool.connect();return {...c,query:async(s,p)=>{if(s==='COMMIT')throw Object.assign(Error('test failure'),{code:'08006'});return c.query(s,p)}}}};
 const r=await withPostgresState(new Request('https://brightpath.test/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Owner',email:'fail@example.test',password:pw,role:'coordinator',newCenter:true,centerName:'Fail'})}),initial,handleRequest,helpers,broken);
 assert.equal(r.status,503);assert.equal(r.headers.get('set-cookie'),null);assert.equal(await count(),n);
});
test('login requires correct center; data persists after new request/session',async()=>{
 const login=await req('auth/login',{email:'owner@example.test',password:pw,role:'coordinator',centerCode:a.data.user.center.code});assert.equal(login.status,200);
 assert.equal((await req('data',null,login.cookie)).data.courses.length,3);
 assert.equal((await req('auth/login',{email:'owner@example.test',password:pw,role:'coordinator',centerCode:'000000000000'})).status,404);
 assert.equal((await req('auth/logout',{},login.cookie)).status,200);assert.equal((await req('data',null,login.cookie)).status,401);
});
after(()=>db.close());
