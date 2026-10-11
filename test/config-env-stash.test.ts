// FORK: connectEngine stashes the merged embedding model into process.env for child
// processes. The doctor's embedding_env_override check must not read that stash as a
// user-set environment variable, but must still report a genuine user override.
import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkEmbeddingEnvOverride } from '../src/commands/doctor/checks/search-eval.ts';
import { isConfigStashedEnv, resetConfigStashedEnvForTests, stashConfigEnv } from '../src/core/config-env-stash.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('embedding_model', 'voyage:voyage-4');
}, 60000);
afterAll(async () => { await engine.disconnect(); });
afterEach(() => resetConfigStashedEnvForTests());

describe('config env stash', () => {
  test('a stashed model that disagrees with the DB is not reported as an env override', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
      stashConfigEnv('GBRAIN_EMBEDDING_MODEL', 'openai:text-embedding-3-large');
      expect(process.env.GBRAIN_EMBEDDING_MODEL).toBe('openai:text-embedding-3-large');
      expect(isConfigStashedEnv('GBRAIN_EMBEDDING_MODEL')).toBe(true);
      const check = await checkEmbeddingEnvOverride(engine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('no embedding env overrides set');
    });
  });

  test('a user-set env var is still reported, even if the stash writes the same key afterwards', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large', GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
      stashConfigEnv('GBRAIN_EMBEDDING_MODEL', 'openai:text-embedding-3-large');
      expect(isConfigStashedEnv('GBRAIN_EMBEDDING_MODEL')).toBe(false);
      const check = await checkEmbeddingEnvOverride(engine);
      expect(check.status).toBe('warn');
      expect(check.details).toEqual({ mismatches: [{ key: 'GBRAIN_EMBEDDING_MODEL', env: 'openai:text-embedding-3-large', db: 'voyage:voyage-4' }] });
    });
  });
});
