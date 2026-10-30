import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {handleApi} from '../server/api.mjs';
const password='Coordinator_chosen_password123!';
const jar=()=>({cookie:''});
async function request(j,path,body,status=200){
 const r=await handleApi(new Request('https://coordinator.example/api/'+path,{method:body?'POST':'GET',headers:{cookie:j.cookie,origin:'https://coordinator.example',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}));
 for(const c of r.headers.getSetCookie())if(c.startsWith('bp_memory='))j.cookie=c.split(';')[0];
 const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;
}
const register=(j,email,extra={},status=200)=>request(j,'auth/register',{name:'Chosen Coordinator',email,password,role:'coordinator',...extra},status);
test('coordinators use their own email with key-free first setup and invitations',async t=>{
 const owner=jar(),second=jar(),anonymous=jar(),student=jar();let invited;
 await t.test('fresh workspace has no seeded coordinator and permits key-free first setup',async()=>{
  const status=await request(anonymous,'auth/status');assert.equal(status.coordinatorSetupRequired,true);assert.equal(status.user,null);
  await request(anonymous,'auth/login',{email:'owner-one@example.com',password,role:'coordinator'},401);
 });
 await t.test('learner signup cannot claim staff access or prevent owner setup',async()=>{
  const d=await register(student,'student@example.com',{role:'learner'});assert.equal(d.user.status,'pending');
  await request(student,'auth/invites',{email:'outsider@example.com',role:'coordinator'},403);
  assert.equal((await request(anonymous,'auth/status')).coordinatorSetupRequired,true);
 });
 await t.test('only one simultaneous coordinator signup can consume initial setup',async()=>{
  const candidates=await Promise.all([register(owner,'OWNER-ONE@example.com',{}),register(anonymous,'racing-owner@example.com',{},403)]);
  assert.equal(candidates[0].user.email,'owner-one@example.com');assert.equal(candidates[0].user.status,'active');
  assert.equal((await request(anonymous,'auth/status')).coordinatorSetupRequired,false);
  const d=await request(owner,'data');assert.equal(d.coordinators.length,1);assert.equal(d.coordinators[0].email,'owner-one@example.com');
 });
 await t.test('direct signup cannot create additional coordinators; invitations remain email and role bound',async()=>{
  await register(anonymous,'second@example.com',{},403);
  invited=await request(owner,'auth/invites',{email:'second@example.com',role:'coordinator'});
  await register(anonymous,'different@example.com',{inviteCode:invited.code},403);
  await register(anonymous,'second@example.com',{role:'educator',inviteCode:invited.code},403);
  const d=await register(second,'second@example.com',{name:'Second Coordinator',inviteCode:invited.code});assert.equal(d.user.status,'active');assert(d.recoveryCode);
 });
 await t.test('both coordinators independently sign in, manage courses and invite further coordinators',async()=>{
  for(const [j,email] of [[owner,'owner-one@example.com'],[second,'second@example.com']]){
   await request(j,'auth/logout',{});await request(j,'auth/login',{email,password,role:'coordinator'});
   const d=await request(j,'data');assert.equal(d.coordinators.length,2);
  }
  await request(second,'courses',{title:'Managed by second coordinator',educatorIds:[]});assert.equal((await request(owner,'data')).courses.length,1);
  const invite=await request(second,'auth/invites',{email:'third@example.com',role:'coordinator'});assert(invite.code);
  await register(anonymous,'third@example.com',{inviteCode:invited.code},403);
  await register(anonymous,'third@example.com',{inviteCode:invite.code});assert.equal((await request(owner,'data')).coordinators.length,3);
  await request(student,'auth/login',{email:'student@example.com',password,role:'coordinator'},403);
 });
 await t.test('deployment environment may optionally create any chosen coordinator',()=>{
  const script=`import {handleApi} from './server/api.mjs';const a=await handleApi(new Request('https://test.example/api/auth/status'));const b=await handleApi(new Request('https://test.example/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.env.BRIGHTPATH_ADMIN_EMAIL,password:process.env.BRIGHTPATH_ADMIN_PASSWORD,role:'coordinator'})}));console.log(JSON.stringify({status:await a.json(),login:await b.json()}));`;
  const d=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,BRIGHTPATH_ADMIN_EMAIL:'configured-owner@example.com',BRIGHTPATH_ADMIN_PASSWORD:password,BRIGHTPATH_ADMIN_NAME:'Configured Owner'}}).toString());
  assert.equal(d.status.coordinatorSetupRequired,false);assert.equal(d.login.user.email,'configured-owner@example.com');assert.equal(d.login.user.name,'Configured Owner');
 });
});
