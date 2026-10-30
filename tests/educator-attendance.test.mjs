import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../server/api.mjs';
const password='Attendance_test_password123!',jar=()=>({cookie:''});
async function request(j,path,method='GET',body,expected=200){
 const r=await handleApi(new Request('https://staff.example/api/'+path,{method,headers:{cookie:j.cookie,origin:'https://staff.example',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}));
 for(const c of r.headers.getSetCookie())if(c.startsWith('bp_memory='))j.cookie=c.split(';')[0];
 const raw=await r.text();assert.equal(r.status,expected,raw);return r.headers.get('content-type')?.startsWith('text/csv')?raw:JSON.parse(raw);
}
const post=(j,p,b,e)=>request(j,p,'POST',b,e),patch=(j,p,b,e)=>request(j,p,'PATCH',b,e),get=(j,p,e)=>request(j,p,'GET',undefined,e);
test('coordinator verifies educator attendance and protects private staff records',async t=>{
 const admin=jar(),a=jar(),b=jar(),learner=jar(),outsider=jar();let ea,eb,cid,today,session;
 await post(admin,'auth/register',{name:'Center Coordinator',email:'coordinator@example.com',password,role:'coordinator'});
 for(const [j,name,email] of [[a,'Educator A','a@example.com'],[b,'Educator B','b@example.com']]){const inv=await post(admin,'auth/invites',{email,role:'educator'});const u=(await post(j,'auth/register',{name,email,password,role:'educator',inviteCode:inv.code})).user;if(j===a)ea=u;else eb=u}
 const student=(await post(learner,'auth/register',{name:'Student',email:'student@example.com',role:'learner',password})).user;
 await post(admin,'hub',{action:'account',payload:{id:student.id,status:'active'}});
 cid=(await post(admin,'courses',{title:'Shared course',educatorIds:[ea.id,eb.id]})).id;
 await post(admin,'enrollments',{courseId:cid,learnerId:student.id});today=(await get(admin,'educator-attendance')).today;
 await t.test('only coordinators create registers; learners cannot read the endpoint or export',async()=>{
  await get(outsider,'educator-attendance',401);await get(learner,'educator-attendance',403);await get(learner,'educator-attendance/report',403);
  for(const j of [a,learner]){await post(j,'educator-attendance',{courseId:cid,date:today,period:1},403);await post(j,'hub',{action:'educatorAttendance.create',payload:{courseId:cid,date:today,period:1}},403)}
  session=await post(admin,'educator-attendance',{courseId:cid,date:today,period:1,title:'Morning class'});assert.equal(session.roster.length,2);assert(session.roster.every(r=>r.status===null));
  assert.equal((await get(a,'educator-attendance')).sessions.length,0);assert.equal((await get(a,'data')).items.filter(i=>i._kind==='educatorAttendance').length,0);
 });
 await t.test('duplicate, future, impossible dates, empty assignments and incomplete rosters are rejected',async()=>{
  await post(admin,'educator-attendance',{courseId:cid,date:today,period:1},409);
  for(const date of ['2099-01-01','2026-02-30','invalid'])await post(admin,'educator-attendance',{courseId:cid,date,period:2},400);
  const unassigned=(await post(admin,'courses',{title:'Unassigned'})).id;await post(admin,'educator-attendance',{courseId:unassigned,date:today,period:1},400);
  await patch(admin,'educator-attendance/'+session.id,{action:'submit',revision:1,marks:session.roster},400);
  await patch(admin,'educator-attendance/'+session.id,{action:'submit',revision:1,marks:[{educatorId:ea.id,status:'present'}]},400);
  assert.equal((await get(admin,'educator-attendance')).sessions[0].revision,1);
 });
 await t.test('draft saves are private and submission publishes only each educator own record',async()=>{
  const marks=session.roster.map(r=>({...r,status:r.educatorId===ea.id?'present':'absent',remark:'Observed by coordinator'}));
  session=await patch(admin,'educator-attendance/'+session.id,{action:'save',revision:1,marks});assert.equal((await get(admin,'educator-attendance')).summaries.find(r=>r.educatorId===ea.id).rate,null);
  await patch(a,'educator-attendance/'+session.id,{action:'submit',revision:2,marks},403);
  session=await patch(admin,'educator-attendance/'+session.id,{action:'submit',revision:2,marks});assert.equal(session.state,'submitted');assert.equal(session.verifiedBy,'Center Coordinator');
  for(const [j,u,status] of [[a,ea,'present'],[b,eb,'absent']]){const d=await get(j,'educator-attendance');assert.equal(d.sessions[0].roster.length,1);assert.equal(d.sessions[0].roster[0].educatorId,u.id);assert.equal(d.sessions[0].roster[0].status,status);assert.equal(d.sessions[0].audit,undefined);assert.equal(d.summaries.length,1);assert.equal((await get(j,'data')).items.find(i=>i._kind==='educatorAttendance').roster.length,1)}
  const studentData=await get(learner,'data');assert(!studentData.items.some(i=>i._kind==='educatorAttendance'));assert(!studentData.notifications.some(n=>n.category.startsWith('educatorAttendance.')));
  assert((await get(a,'hub')).notifications.some(n=>n.category==='educatorAttendance.save'));
 });
 await t.test('submitted registers lock; corrections require reasons, correct revisions and audit changes',async()=>{
  const marks=session.roster.map(r=>({...r,status:r.educatorId===eb.id?'late':'present'}));
  await patch(admin,'educator-attendance/'+session.id,{action:'save',revision:3,marks},400);
  await patch(admin,'educator-attendance/'+session.id,{action:'correct',revision:2,marks,reason:'Late arrival'},409);
  await patch(admin,'educator-attendance/'+session.id,{action:'correct',revision:3,marks,reason:'x'},400);
  await patch(b,'educator-attendance/'+session.id,{action:'correct',revision:3,marks,reason:'Self marking'},403);
  session=await patch(admin,'educator-attendance/'+session.id,{action:'correct',revision:3,marks,reason:'Arrival verified late'});
  assert.equal(session.audit.at(-1).changes[0].from,'absent');assert.equal(session.audit.at(-1).changes[0].to,'late');assert.equal((await get(admin,'educator-attendance')).summaries.find(r=>r.educatorId===eb.id).rate,100);
 });
 await t.test('leave is excluded, filters preserve editable rosters and CSV limits exported educators',async()=>{
  let second=await post(admin,'educator-attendance',{courseId:cid,date:today,period:2});second=await patch(admin,'educator-attendance/'+second.id,{action:'submit',revision:1,marks:second.roster.map(r=>({...r,status:r.educatorId===ea.id?'leave':'absent',remark:'=unsafe'}))});
  const d=await get(admin,'educator-attendance?educatorId='+ea.id+'&from='+today+'&to='+today);assert.equal(d.summaries.length,1);assert.equal(d.summaries[0].leave,1);assert.equal(d.summaries[0].held,1);assert.equal(d.summaries[0].rate,100);assert.equal(d.sessions[0].roster.length,2);
  const csv=await get(admin,'educator-attendance/report?mode=register&educatorId='+ea.id);assert(csv.includes('a@example.com'));assert(!csv.includes('b@example.com'));assert(csv.includes("'=unsafe"));
  const own=await get(b,'educator-attendance/report?mode=register');assert(!own.includes('a@example.com'));assert(own.includes('b@example.com'));
  assert.equal((await get(a,'educator-attendance?educatorId='+eb.id)).sessions.length,0);
  await get(admin,'educator-attendance?from=2026-02-30',400);await get(admin,'educator-attendance?from=2026-10-13&to=2026-01-01',400);
 });
 await t.test('reassignment preserves own past records; cancellation excludes totals and keeps history',async()=>{
  await patch(admin,'courses/'+cid,{educatorIds:[eb.id]});const own=await get(a,'educator-attendance');assert.equal(own.sessions.length,2);assert(own.courses.some(c=>c.id===cid));
  session=await patch(admin,'educator-attendance/'+session.id,{action:'cancel',revision:session.revision,reason:'Class record duplicated'});assert.equal(session.state,'cancelled');assert.equal(session.audit.at(-1).action,'cancel');
  assert.equal((await get(admin,'educator-attendance')).summaries.find(r=>r.educatorId===ea.id).rate,null);
  await patch(admin,'educator-attendance/'+session.id,{action:'correct',revision:session.revision,reason:'Cannot reopen'},409);
  assert.equal((await get(a,'educator-attendance')).sessions.length,1);
  const third=await post(admin,'educator-attendance',{courseId:cid,date:today,period:1});assert.deepEqual(third.roster.map(r=>r.educatorId),[eb.id]);
 });
});
