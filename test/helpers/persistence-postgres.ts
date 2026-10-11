import postgres from '#postgres'
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

/** Permanent receipt IDs deliberately survive source deletion; use a fresh test brain. */
export async function isolatedPersistencePostgres(databaseUrl:string, connectionStyle:'instance'|'module'='instance', poolSize=4):Promise<{engine:PostgresEngine;databaseUrl:string;close:()=>Promise<void>}> {
  assertSafeE2eDatabaseUrl(databaseUrl);
  const database=`gbrain_test_persistence_${randomUUID().replace(/-/g,'')}`;
  const admin=postgres(databaseUrl,{max:1,prepare:false});
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url=new URL(databaseUrl);url.pathname=`/${database}`;
  const engine=new PostgresEngine();
  const close=async()=>{await engine.disconnect();await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();};
  try {await engine.connect({database_url:url.toString(),poolSize:connectionStyle==='module'?undefined:poolSize});await engine.initSchema();return{engine,databaseUrl:url.toString(),close};}
  catch(error){await close();throw error;}
}

/**
 * One migrated template per test file: each clone (CREATE DATABASE ... TEMPLATE) is its own fresh brain,
 * so permanent receipt IDs never cross tests, without re-running every migration per test.
 */
export async function persistencePostgresTemplate(databaseUrl:string, poolSize=4):Promise<{clone:()=>Promise<{engine:PostgresEngine;close:()=>Promise<void>}>;dispose:()=>Promise<void>}> {
  const template=await isolatedPersistencePostgres(databaseUrl);
  await template.engine.disconnect();
  const name=new URL(template.databaseUrl).pathname.slice(1);
  const admin=postgres(databaseUrl,{max:1,prepare:false});
  let clones=0;
  return {
    clone:async()=>{
      const database=`${name}_${clones++}`;
      await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE ${name}`);
      const url=new URL(databaseUrl);url.pathname=`/${database}`;
      const engine=new PostgresEngine();
      const close=async()=>{await engine.disconnect();await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);};
      try {await engine.connect({database_url:url.toString(),poolSize});await rebuildClonedPgroongaIndexes(engine);return{engine,close};}
      catch(error){await close();throw error;}
    },
    dispose:async()=>{await admin.end();await template.close();},
  };
}

/**
 * FORK: a PGroonga index keeps its data in a per-database Groonga store that `CREATE DATABASE ... TEMPLATE` does not
 * carry over ("pgroonga: PGrnLookupWithSize: object isn't found: <Sources...>" on the first write to the indexed
 * table). Rebuilding the cloned index recreates the store; on a server without the extension there is nothing to do.
 */
async function rebuildClonedPgroongaIndexes(engine: PostgresEngine): Promise<void> {
  const rows = await engine.executeRaw<{ index: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS index
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_am am ON am.oid = c.relam
      WHERE am.amname = 'pgroonga' AND n.nspname = 'public'`,
  );
  for (const row of rows) await engine.executeRaw(`REINDEX INDEX ${row.index}`);
}
