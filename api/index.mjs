import {handleApi} from '../server/api.mjs';
// Vercel uses private Blob JSON; local Node uses a file on its persistent disk.
export default {
 async fetch(request){
  const url=new URL(request.url),route=url.searchParams.get('__bp_route');
  if(route!==null){
   if(!/^[a-zA-Z0-9/_-]*$/.test(route))return Response.json({error:'Invalid API path'},{status:400});
   url.pathname='/api/'+route;url.searchParams.delete('__bp_route');
   request=new Request(url,request);
  }
  return handleApi(request);
 }
};
