import {storageMode} from './file-store.mjs';
import {configured,context,auth,rpc,fail,saveFile,downloadFile,withStorage} from './memory.mjs';
import {shape,attendanceView,classroomView,report} from './views.mjs';
import {educatorAttendanceView,educatorAttendanceReport} from './educator-attendance-views.mjs';
const uploadLimits=()=>process.env.VERCEL==='1'?{document:4*1024*1024,recording:4*1024*1024}:{document:10*1024*1024,recording:20*1024*1024};
const uploadReady=()=>true;
async function limitedBody(req,max){const reader=req.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let total=0;for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();fail('Request too large',413)}chunks.push(value)}const bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}return bytes;}
async function upload(ctx,id,req){
 const mime=(req.headers.get('content-type')||'').split(';')[0];const limit=mime.startsWith('video/')?uploadLimits().recording:uploadLimits().document;
 const bytes=await limitedBody(req,limit);if(!bytes.length||bytes.length>20971520)fail('File must be 1 byte to 20 MB.',413);
 let name;try{name=decodeURIComponent(req.headers.get('x-filename')||'')}catch{fail('Invalid filename')}
 const signatures={'application/pdf':b=>new TextDecoder().decode(b.slice(0,5))==='%PDF-','image/png':b=>b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71,'image/jpeg':b=>b[0]===255&&b[1]===216&&b[2]===255,'video/mp4':b=>new TextDecoder().decode(b.slice(4,8))==='ftyp','video/webm':b=>b[0]===26&&b[1]===69&&b[2]===223&&b[3]===163,'text/plain':b=>!b.includes(0)};
 if(!signatures[mime]?.(bytes))fail('File contents do not match a supported format.');
 return saveFile(ctx,id,{name,mime,revision:Number(req.headers.get('x-revision'))},bytes);
}

export const handleApi=request=>withStorage(request,handleRequest);
export async function handleRequest(request){
 const url=new URL(request.url),p=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean),method=request.method;
 const headers=new Headers({'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'}),json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
 try{
  if(!['GET','POST','PATCH','DELETE'].includes(method))fail('Method not allowed',405);
  if(method!=='GET'){const origin=request.headers.get('origin');if((origin&&origin!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site')fail('Cross-origin writes are not allowed',403);}
  if(p[0]==='health')return json({ok:true,apiVersion:8,storage:storageMode(),configured:configured()});
  if(p.join('/')==='auth/status'&&!configured())return json({apiVersion:8,configured:false,user:null});
  const ctx=await context(request,headers);
  const isUpload=p[0]==='classroom'&&p.length===4&&p[3]==='file'&&method==='POST';
  let b={};if(['POST','PATCH'].includes(method)&&!isUpload){if(!request.headers.get('content-type')?.startsWith('application/json'))fail('Use application/json',415);const raw=new TextDecoder().decode(await limitedBody(request,160000));if(raw.length>160000)fail('Request too large',413);try{b=JSON.parse(raw||'{}')}catch{fail('Invalid JSON')};if(!b||typeof b!=='object'||Array.isArray(b))fail('Expected a JSON object');}
  if(p[0]==='auth'&&p[1]!=='invites')return json(await auth(ctx,p.slice(1).join('/'),method,b));
  if(!ctx.user)fail('Please sign in again.',401);
  const action=async(a,args=b)=>rpc(ctx.sb,'bp_action',{action:a,p:args});
  if(isUpload)return json(await upload(ctx,p[2],request));
  const snap=async()=>shape(await rpc(ctx.sb,'bp_snapshot'));
  if(method==='GET'){
   const s=await snap();
   const requestedView=url.searchParams.get('view');if(['educators','coordinators','people'].includes(requestedView)&&s.user.role!=='coordinator'||requestedView==='learners'&&s.user.role==='learner')fail('This view requires staff access',403);
   if(p[0]==='classroom'&&p[1]==='files'){
    const f=downloadFile(ctx,p[2]);
    headers.set('content-type',f.mime);headers.set('content-disposition',`${f.mime.startsWith('video/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);headers.set('accept-ranges','bytes');
    const range=request.headers.get('range');let start=0,end=f.size-1,status=200;
    if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||!m[1]&&!m[2])fail('Invalid byte range',416);if(m[1]){start=Number(m[1]);if(m[2])end=Math.min(Number(m[2]),end)}else start=Math.max(0,f.size-Number(m[2]));if(start>end||start>=f.size){headers.set('content-range',`bytes */${f.size}`);return new Response(null,{status:416,headers})}status=206;headers.set('content-range',`bytes ${start}-${end}/${f.size}`)}
    headers.set('content-length',String(end-start+1));return new Response(f.bytes.slice(start,end+1),{status,headers});
   }
   if(p[0]==='data')return json(s);
   if(p[0]==='educator-attendance'){
    if(p.length===1)return json(educatorAttendanceView(s,url));
    if(p.length===2&&p[1]==='report'){const result=educatorAttendanceReport(s,url);headers.set('content-type','text/csv; charset=utf-8');headers.set('content-disposition','attachment; filename="educator-attendance.csv"');return new Response(result,{headers})}
    fail('Route not found',404);
   }
   if(p[0]==='hub')return json({...s,uploadEnabled:uploadReady(),uploadLimits:uploadLimits()});
   if(p[0]==='auth'&&p[1]==='invites'){if(s.user.role!=='coordinator')fail('Coordinator access required',403);return json(s.invites)}
   if(p[0]==='classroom'){const cid=url.searchParams.get('courseId');if(!s.courses.some(c=>c.id===cid))fail('Course access denied',403);return json({...classroomView(s,cid),uploadEnabled:uploadReady(),uploadLimits:uploadLimits()})}
   if(p[0]==='attendance'&&p.length===1)return json(attendanceView(s,url));
   if(p[0]==='report'||p[0]==='attendance'&&p[1]==='report'){headers.set('content-type','text/csv; charset=utf-8');headers.set('content-disposition','attachment; filename="brightpath-report.csv"');return new Response(report(s,url,p[0]==='attendance'),{headers})}
   if(['educators','coordinators','learners','courses','enrollments'].includes(p[0])&&p.length===1){if((['educators','coordinators'].includes(p[0])&&s.user.role!=='coordinator')||(p[0]==='learners'&&s.user.role==='learner'))fail('Staff access required',403);return json(s[p[0]])}
   fail('Route not found',404);
  }
  if(p[0]==='hub'&&p.length===1&&method==='POST')return json(await action(b.action,b.payload||{}));
  if(p.join('/')==='auth/invites'&&method==='POST')return json(await action('invite'));
  if(p[0]==='educator-attendance'){
   if(p.length===1&&method==='POST')return json(await action('educatorAttendance.create'));
   if(p.length===2&&method==='PATCH')return json(await action('educatorAttendance.save',{...b,id:p[1]}));
   fail('Route not found',404);
  }
  if(p[0]==='courses'){
   if(p.length===1&&method==='POST')return json(await action('course.create'));
   if(p.length===2&&method==='PATCH')return json(await action('course.update',{...b,id:p[1]}));
   if(p[2]==='topics'&&method==='POST')return json(await action('topic.add',{...b,courseId:p[1]}));
   if(p[2]==='topics'&&p.length===4&&method==='PATCH')return json(await action('topic.update',{...b,courseId:p[1],topicId:p[3]}));
  }
  if(p[0]==='enrollments')return json(await action(method==='POST'?'enroll':method==='DELETE'?'unenroll':'progress',{...b,...(p[1]?{id:p[1]}:{})}));
  if(p[0]==='attendance'){
   const item=await action(method==='POST'?'attendance.create':'attendance.save',{...b,...(p[1]?{id:p[1]}:{})});const s=await snap();return json(s.sessions.find(i=>i.id===item.id)||item);
  }
  if(p[0]==='classroom'){
   const map={lectures:method==='POST'?'lecture.create':'lecture.state',materials:method==='DELETE'?'material.delete':p[3]==='submissions'?'submission.save':'material.create',submissions:'submission.grade',notes:'note.save'};
   if(map[p[1]])return json(await action(map[p[1]],{...b,...(p[2]?p[1]==='notes'?{courseId:p[2]}:{id:p[2]}:{})}));
  }
  fail('Route not found',404);
 }catch(e){if(!e.status)console.error(JSON.stringify({event:'api_error',path:url.pathname,message:'Unhandled backend error'}));return json({error:e.status?e.message:'The service could not complete this request. Check the server configuration and retry.'},e.status||500)}
}
