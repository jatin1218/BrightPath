import {csv} from './views.mjs';
const bad=message=>{throw Object.assign(new Error(message),{status:400})};
const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function educatorAttendanceView(s,url){
 if(s.user.role==='learner')throw Object.assign(new Error('Staff access required.'),{status:403});
 const q=url.searchParams,from=q.get('from')||'',to=q.get('to')||'',cid=q.get('courseId')||'',eid=q.get('educatorId')||'';
 if(from&&!validDate(from)||to&&!validDate(to)||from&&to&&from>to)bad('Choose a valid date range.');
 const all=s.items.filter(i=>i._kind==='educatorAttendance');
 // Keep the full authorized roster for editing even when the list is filtered by educator.
 const sessions=all.filter(i=>(!from||i.date>=from)&&(!to||i.date<=to)&&(!cid||i.courseId===cid)&&(!eid||i.roster.some(r=>r.educatorId===eid))).sort((a,b)=>b.date.localeCompare(a.date)||b.period-a.period);
 const educators=s.profiles.filter(p=>p.role==='educator'&&(s.user.role==='coordinator'||p.id===s.user.id));
 const summaries=educators.filter(e=>(!eid||e.id===eid)&&(!cid||s.courses.some(c=>c.id===cid&&c.educatorIds.includes(e.id))||sessions.some(i=>i.roster.some(r=>r.educatorId===e.id)))).map(e=>{
  const counts={present:0,absent:0,late:0,leave:0};
  for(const i of sessions)if(i.state==='submitted')for(const r of i.roster)if(r.educatorId===e.id&&Object.hasOwn(counts,r.status))counts[r.status]++;
  const attended=counts.present+counts.late,held=attended+counts.absent;
  return {educatorId:e.id,name:e.name,email:e.email,...counts,attended,held,rate:held?Math.round(attended/held*1000)/10:null};
 });
 const courses=new Map(s.courses.map(c=>[c.id,{id:c.id,title:c.title}]));for(const i of all)if(!courses.has(i.courseId))courses.set(i.courseId,{id:i.courseId,title:i.courseTitle});
 return {today:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),sessions,summaries,educators:educators.map(e=>({id:e.id,name:e.name})),courses:[...courses.values()]};
}
export function educatorAttendanceReport(s,url){
 const v=educatorAttendanceView(s,url);
 const eid=url.searchParams.get('educatorId');
 if(url.searchParams.get('mode')==='register')return csv([['Course','Date','Period','Session','Educator','Email','Status','Remark','Verified by','Verified at'],...v.sessions.filter(i=>i.state==='submitted').flatMap(i=>i.roster.filter(r=>!eid||r.educatorId===eid).map(r=>[i.courseTitle,i.date,i.period,i.title,r.name,r.email,r.status,r.remark,i.verifiedBy,i.verifiedAt]))]);
 return csv([['Educator','Email','Counted sessions','Present','Late','Absent','Leave','Attendance %'],...v.summaries.map(r=>[r.name,r.email,r.held,r.present,r.late,r.absent,r.leave,r.rate])]);
}
