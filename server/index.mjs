import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
try{process.loadEnvFile()}catch(e){if(e.code!=='ENOENT')throw e}
const {handleApi}=await import('./api.mjs');
const {dataFile,storageMode,storageProblem}=await import('./file-store.mjs');
if(storageProblem())throw Error(storageProblem());
const root=fileURLToPath(new URL('../dist/public/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,process.env.PUBLIC_ORIGIN||('http://'+(req.headers.host||'localhost')));
  if(url.pathname.startsWith('/api/')){
   const chunks=[];let size=0;const limit=/^\/api\/classroom\/(materials|submissions)\/[^/]+\/file$/.test(url.pathname)?21*1024*1024:160000;
   for await(const chunk of req){size+=chunk.length;if(size>limit){res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({error:'Request too large'}));return;}chunks.push(chunk);}
   const request=new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
   const out=await handleApi(request);const responseHeaders=Object.fromEntries(out.headers);const setCookies=out.headers.getSetCookie();if(setCookies.length)responseHeaders['set-cookie']=setCookies;res.writeHead(out.status,responseHeaders);res.end(Buffer.from(await out.arrayBuffer()));return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end('Invalid URL');return;}
  let file=path.resolve(root,'.'+pathname);if(file!==path.resolve(root)&&!file.startsWith(root)){res.writeHead(403);res.end('Forbidden');return;}
  if(pathname==='/')file=path.join(root,'index.html');
  try{if(!(await stat(file)).isFile())throw Error();}catch{res.writeHead(404);res.end('Not found. Run npm run build first if the app has not been built.');return;}
  const bytes=await readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','cache-control':path.extname(file)==='.html'?'no-store':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'Server error'}));}
});
const port=Number(process.env.PORT||3000);const host=process.env.HOST||'127.0.0.1';
server.listen(port,host,()=>console.log(`Brightpath running at http://${host}:${server.address().port} — ${storageMode()==='json'?'JSON data: '+dataFile():storageMode()==='postgres'?'Supabase PostgreSQL (multi-center)':storageMode()==='blob'?'private cloud JSON':'temporary test memory'}; see SETUP.md.`));
