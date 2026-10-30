import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
try{process.loadEnvFile()}catch(e){if(e.code!=='ENOENT')throw e}
const {postgresPool,postgresProblem,readState,saveState}=await import('../server/postgres-store.mjs');
const {encodeState,decodeState}=await import('../server/file-store.mjs');
const {initial}=await import('../server/memory.mjs');
const [command,arg,label]=process.argv.slice(2);let client,databasePool,transaction=false;
try{
 if(postgresProblem())throw Error(postgresProblem());
 databasePool=postgresPool();client=await databasePool.connect();
 if(command==='check'){
  await client.query('BEGIN');transaction=true;await client.query('SET LOCAL ROLE brightpath_runtime');
  await client.query('SELECT 1 FROM brightpath_private.centers LIMIT 0');
  await client.query("SELECT * FROM brightpath_private.resolve_center('000000000000')");
  await client.query('ROLLBACK');transaction=false;
  console.log('Database connection, schema and backend role are ready.');
 }else if(command==='import'){
  if(!arg||!label||label.trim().length<2||label.length>120)throw Error('Usage: npm run db:import -- backup.json "Your learning center name"');
  const state=decodeState(await readFile(arg,'utf8'));
  if(![...state.users.values()].some(u=>u.role==='coordinator'&&u.status==='active'))throw Error('Import requires at least one active coordinator in the backup. For an empty workspace use the website registration form.');
  // Preserve password hashes/recovery keys/MFA; force fresh sign-in after migration.
  state.sessions.clear();state.limits.clear();
  const empty=initial();if(empty.users.size)throw Error('Remove BRIGHTPATH_ADMIN_EMAIL/PASSWORD before importing.');
  const center={id:randomUUID(),code:randomBytes(6).toString('hex').toUpperCase(),name:label.trim()};
  await client.query('BEGIN');transaction=true;await client.query('SET LOCAL ROLE brightpath_runtime');
  await client.query("SELECT set_config('brightpath.center_id',$1,true)",[center.id]);
  await client.query('INSERT INTO brightpath_private.centers(id,code,name) VALUES($1,$2,$3)',[center.id,center.code,center.name]);
  await saveState(client,center.id,encodeState(empty),encodeState(state));
  await client.query('COMMIT');transaction=false;
  console.log('Imported into a NEW isolated center. Existing centers were not changed.');
  console.log('Center code: '+center.code+' — use this with existing emails and passwords.');
 }else if(command==='backup'){
  if(!/^[A-Z0-9]{12}$/.test(arg||'')||!label)throw Error('Usage: npm run db:backup -- CENTERCODE12 path/to/new-backup.json');
  await client.query('BEGIN');transaction=true;await client.query('SET LOCAL ROLE brightpath_runtime');
  let center=(await client.query('SELECT * FROM brightpath_private.resolve_center($1)',[arg])).rows[0];if(!center)throw Error('Center not found.');
  await client.query("SELECT set_config('brightpath.center_id',$1,true)",[center.id]);
  center=(await client.query('SELECT * FROM brightpath_private.centers WHERE id=$1 FOR UPDATE',[center.id])).rows[0];
  const state=await readState(client,center,decodeState);await client.query('COMMIT');transaction=false;
  await writeFile(label,encodeState(state),{flag:'wx',mode:0o600});
  console.log('Private backup saved. It contains account and learning records; store it securely.');
 }else throw Error('Choose check, import, or backup.');
}catch(e){if(transaction)await client?.query('ROLLBACK').catch(()=>{});console.error(e.code?'Database operation failed ('+e.code+'). Check connection, SQL setup and file permissions.':e.message);process.exitCode=1}
finally{client?.release();await databasePool?.end()}
