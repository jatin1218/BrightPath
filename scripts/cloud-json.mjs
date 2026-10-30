import {readFile,writeFile} from 'node:fs/promises';
import {get,put,BlobPreconditionFailedError} from '@vercel/blob';
// Production env pull stays separate from the local JSON server's .env.
try{process.loadEnvFile('.env.cloud')}catch(e){if(e.code!=='ENOENT')throw e;try{process.loadEnvFile()}catch(local){if(local.code!=='ENOENT')throw local}}
const {encodeState,decodeState}=await import('../server/file-store.mjs');
const {blobPath}=await import('../server/blob-store.mjs');
const {initial}=await import('../server/memory.mjs');
const [action,argument]=process.argv.slice(2);
const options={access:'private',contentType:'application/json',addRandomSuffix:false,cacheControlMaxAge:60};
try{
 if(!process.env.BLOB_READ_WRITE_TOKEN&&!(process.env.BLOB_STORE_ID&&process.env.VERCEL_OIDC_TOKEN))throw Error('Connect your private Blob store and load its credentials using VERCEL_SETUP.md.');
 if(action==='init'){
  if(!argument)throw Error('Use npm run storage:init -- --new for a new workspace, or npm run storage:init -- path/to/brightpath.json to import an existing file.');
  const raw=argument==='--new'?encodeState(initial()):encodeState(decodeState(await readFile(argument,'utf8')));
  // Creation only. Running this command again cannot overwrite live records.
  await put(blobPath(),raw,{...options,allowOverwrite:false});
  console.log('Private cloud JSON initialized. Existing records are never overwritten by this command.');
 }else if(action==='backup'){
  if(!argument)throw Error('Use npm run storage:backup -- path/to/new-backup.json');
  const saved=await get(blobPath(),{access:'private',useCache:false});
  if(!saved||saved.statusCode!==200||!saved.stream)throw Error('Cloud JSON was not found.');
  const raw=await new Response(saved.stream).text();decodeState(raw);
  await writeFile(argument,raw,{flag:'wx',mode:0o600});
  console.log('Backup saved. Keep it private: it contains account and session data.');
 }else if(action==='restore'){
  if(!argument)throw Error('Use npm run storage:restore -- path/to/backup.json after disabling public access.');
  const raw=encodeState(decodeState(await readFile(argument,'utf8')));
  const saved=await get(blobPath(),{access:'private',useCache:false});
  if(saved&&(!saved.blob?.etag||saved.statusCode!==200))throw Error('Could not verify the current cloud version.');
  await put(blobPath(),raw,{...options,allowOverwrite:!!saved,...(saved?{ifMatch:saved.blob.etag}:{})});
  console.log('Backup restored. Accounts, permissions and sessions now reflect that backup.');
 }else throw Error('Expected init, backup, or restore.');
}catch(error){
 console.error(error instanceof BlobPreconditionFailedError?'Records changed during restore. Disable public access and retry.':error.constructor===Error?error.message:'Cloud JSON operation failed. Check private-store credentials, pathname, connectivity and usage. Initialization refuses to replace an existing file.');
 process.exitCode=1;
}
