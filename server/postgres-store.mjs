import pg from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
const tables={users:'users',sessions:'sessions',invites:'invites',courses:'courses',enrollments:'enrollments',items:'items',quizKeys:'quiz_keys',files:'files',limits:'limits',events:'events',notifications:'notifications'};
let pool;
export function postgresProblem(){
 try{const u=new URL(process.env.DATABASE_URL||'');if(!['postgres:','postgresql:'].includes(u.protocol)||!u.password||decodeURIComponent(u.password).includes('[YOUR-PASSWORD]'))throw Error();return ''}catch{return 'Set DATABASE_URL with your real database password privately in the server environment, then run sql/001_supabase_multicenter.sql.'}
}
export function postgresPool(){
 if(!pool){
  const u=new URL(process.env.DATABASE_URL);for(const key of ['sslmode','sslcert','sslkey','sslrootcert','pgbouncer'])u.searchParams.delete(key);
  const local=['localhost','127.0.0.1','::1'].includes(u.hostname);
  pool=new pg.Pool({connectionString:u.toString(),ssl:local?false:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT}:{})},max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,allowExitOnIdle:true});
  pool.on('error',()=>console.error('postgres_idle_connection_error'));
 }
 return pool;
}
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const error=(message,status=400)=>{throw Object.assign(Error(message),{status})};
function cookies(request){return Object.fromEntries((request.headers.get('cookie')||'').split(';').map(s=>s.trim().split('=')))}
export async function readState(client,center,decodeState){
 const maps={},arrays={};
 for(const [key,tab] of Object.entries(tables)){
  const {rows}=await client.query(`SELECT record_key,data FROM brightpath_private.${tab} WHERE center_id=$1 ORDER BY record_key`,[center.id]);
  if(['events','notifications'].includes(key))arrays[key]=rows.map(r=>r.data);
  else maps[key]=rows.map(r=>[r.record_key,r.data]);
 }
 return decodeState(JSON.stringify({schemaVersion:1,maps,...arrays,settings:center.settings}));
}
function rowsOf(raw){const d=JSON.parse(raw),out={...d.maps};for(const key of ['events','notifications'])out[key]=d[key].map((v,i)=>[String(i).padStart(12,'0'),v]);return {rows:out,settings:d.settings}}
export async function saveState(client,centerId,before,after){
 const previous=rowsOf(before),next=rowsOf(after);
 for(const [key,tab] of Object.entries(tables)){
  const old=new Map(previous.rows[key].map(([id,value])=>[id,JSON.stringify(value)])),current=new Map(next.rows[key]);
  const removed=[...old.keys()].filter(k=>!current.has(k));
  if(removed.length)await client.query(`DELETE FROM brightpath_private.${tab} WHERE center_id=$1 AND record_key=ANY($2::text[])`,[centerId,removed]);
  const changed=[...current].filter(([id,value])=>old.get(id)!==JSON.stringify(value)).map(([record_key,data])=>({record_key,data}));
  if(changed.length)await client.query(`INSERT INTO brightpath_private.${tab}(center_id,record_key,data) SELECT $1,x.record_key,x.data FROM jsonb_to_recordset($2::jsonb) AS x(record_key text,data jsonb) ON CONFLICT(center_id,record_key) DO UPDATE SET data=excluded.data`,[centerId,JSON.stringify(changed)]);
 }
 if(JSON.stringify(previous.settings)!==JSON.stringify(next.settings))await client.query('UPDATE brightpath_private.centers SET settings=$2::jsonb WHERE id=$1',[centerId,JSON.stringify(next.settings)]);
}
async function authBody(request){
 const reader=request.clone().body?.getReader();if(!reader)return {};let size=0;const chunks=[];
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>160000){void reader.cancel();error('Request too large',413)}chunks.push(value)}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{error('Invalid JSON')}
 if(!value||typeof value!=='object'||Array.isArray(value))error('Expected a JSON object');return value;
}
export async function withPostgresState(request,initial,execute,{encodeState,decodeState,run},dbPool){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 let client,inTransaction=false;
 try{
  const problem=postgresProblem();if(problem)return json({apiVersion:8,configured:false,user:null,error:problem},503);
  if(path==='/api/health'){client=await (dbPool||postgresPool()).connect();await client.query('SELECT 1 FROM brightpath_private.centers LIMIT 0');return json({ok:true,apiVersion:8,storage:'postgres',configured:true,multiCenter:true})}
  const isEntry=method==='POST'&&['/api/auth/login','/api/auth/register','/api/auth/recover'].includes(path);
  const b=isEntry?await authBody(request):{};
  const newCenter=path==='/api/auth/register'&&b.newCenter===true;
  if(newCenter&&(b.role!=='coordinator'||typeof b.centerName!=='string'||b.centerName.trim().length<2||b.centerName.trim().length>120))error('Only a coordinator can create a center. Enter a center name of 2–120 characters.');
  const code=isEntry?String(b.centerCode||'').trim().toUpperCase():cookies(request).bp_center;
  if(!newCenter&&!/^[A-Z0-9]{12}$/.test(code||'')){
   if(path==='/api/auth/status'&&method==='GET')return json({apiVersion:8,configured:true,multiCenter:true,coordinatorSetupRequired:false,user:null});
   error(isEntry?'Enter the 12-character center code supplied by your coordinator.':'Choose your learning center and sign in again.',isEntry?400:401);
  }
  client=await (dbPool||postgresPool()).connect();await client.query('BEGIN');inTransaction=true;
  await client.query("SET LOCAL lock_timeout='10s'");await client.query("SET LOCAL statement_timeout='20s'");
  await client.query('SET LOCAL ROLE brightpath_runtime');
  let center;
  if(newCenter){center={id:randomUUID(),code:randomBytes(6).toString('hex').toUpperCase(),name:b.centerName.trim(),settings:{requireStaffMfa:false}}}
  else{center=(await client.query('SELECT * FROM brightpath_private.resolve_center($1)',[code])).rows[0];if(!center)error('Center code not found. Check the code with your coordinator.',404)}
  await client.query("SELECT set_config('brightpath.center_id',$1,true)",[center.id]);
  if(newCenter)await client.query('INSERT INTO brightpath_private.centers(id,code,name) VALUES($1,$2,$3)',[center.id,center.code,center.name]);
  // A transaction-scoped center lock prevents lost updates, including across Vercel instances.
  // Different centers lock different rows. No named/prepared statements are used.
  center=(await client.query('SELECT id,code,name,settings FROM brightpath_private.centers WHERE id=$1 FOR UPDATE',[center.id])).rows[0];
  const state=newCenter?initial():await readState(client,center,decodeState);
  if(newCenter&&state.users.size)error('Remove BRIGHTPATH_ADMIN_EMAIL/PASSWORD: multi-center signup must not seed a shared administrator.',503);
  const before=encodeState(state),holder={state,center:{id:center.id,code:center.code,name:center.name},newCenter};
  const response=await run(holder,()=>execute(request));
  if(response.status>=500||newCenter&&response.status>=400){await client.query('ROLLBACK');inTransaction=false;return response}
  await saveState(client,center.id,before,encodeState(holder.state));
  await client.query('COMMIT');inTransaction=false;
  // Do not issue successful authentication cookies until the transaction is committed.
  if(isEntry&&response.ok&&path!=='/api/auth/recover')response.headers.append('set-cookie',`bp_center=${center.code}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${url.protocol==='https:'?'; Secure':''}`);
  if(path==='/api/auth/logout')response.headers.append('set-cookie',`bp_center=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol==='https:'?'; Secure':''}`);
  return response;
 }catch(e){
  if(inTransaction)await client?.query('ROLLBACK').catch(()=>{});
  if(e.status)return json({error:e.message},e.status);
  console.error(JSON.stringify({event:'postgres_storage_error',code:e.code||'CONNECTION_ERROR'}));
  return json({apiVersion:8,configured:false,user:null,error:['55P03','57014'].includes(e.code)?'This center is busy. Retry your change shortly.':'Database connection or schema setup is incomplete. Check DATABASE_URL and run the Supabase SQL setup. No successful save was confirmed.'},503);
 }finally{client?.release()}
}
