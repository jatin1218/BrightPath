import * as blob from '@vercel/blob';

// Keep the pathname deployment-owned; never accept it from a browser request.
export const blobPath=()=>process.env.BRIGHTPATH_BLOB_PATH||'brightpath/production.json';
const failure=(error,status=503)=>Response.json({apiVersion:8,configured:false,storage:'blob',user:null,error},{status,headers:{'cache-control':'no-store'}});

/** One private JSON document, read consistently and committed with compare-and-swap.
 * Conflicts are returned explicitly: replaying a consumed upload or an auth request
 * automatically could duplicate actions. The browser can refresh and retry safely.
 * The SDK parameter is dependency injection for isolated storage tests only.
 */
export async function withBlobState(request,execute,{encodeState,decodeState,run},sdk=blob){
 try{
  const path=blobPath();
  const saved=await sdk.get(path,{access:'private',useCache:false,abortSignal:AbortSignal.timeout(15000)});
  // Never create a fresh workspace after an outage, deletion, or changed path.
  // Only the owner's separate CLI initialization can create the first document.
  if(!saved)return failure('Cloud JSON is not initialized. The site owner must run npm run storage:init using VERCEL_SETUP.md. Existing data has not been reset.');
  if(saved.statusCode!==200||!saved.stream||!saved.blob?.etag)return failure('Cloud JSON returned an invalid response. No changes were saved.');
  const original=await new Response(saved.stream).text();
  let state;
  try{state=decodeState(original)}catch{return failure('Cloud JSON data is invalid. It has not been overwritten. Ask the site owner to restore a valid backup.');}
  const holder={state};
  const response=await run(holder,()=>execute(request));
  if(response.status>=500)return response;
  const next=encodeState(holder.state);
  if(next!==original){
   await sdk.put(path,next,{
    access:'private',contentType:'application/json',addRandomSuffix:false,
    allowOverwrite:true,ifMatch:saved.blob.etag,cacheControlMaxAge:60,
    abortSignal:AbortSignal.timeout(20000),
   });
  }
  // In particular, do not issue a login cookie before the session is durable.
  return response;
 }catch(error){
  if(error instanceof sdk.BlobPreconditionFailedError)return failure('Another request updated the records. Refresh the page and retry your change.',409);
  // Do not log provider errors: they may contain private paths or credentials.
  console.error(JSON.stringify({event:'cloud_json_storage_error'}));
  return failure('Cloud storage is unavailable or the save could not be confirmed. Refresh before retrying. The site owner should check the private Blob connection and usage limits.');
 }
}
