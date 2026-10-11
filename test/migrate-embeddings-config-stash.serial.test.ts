/**
 * R6-2: the embedding-model value gbrain itself stashed into process.env (connectEngine copies the merged config model
 * there for child processes) is not a user environment override. The migration's env checks (detectEnvOverride,
 * detectEnvPresence, envFullyPinsTarget) must ignore the internal stash, a migration to B must not be refused because
 * of it, and persisting B must refresh the stash so the reconfigured gateway runs B instead of the previous model.
 * A variable the USER set still refuses a mismatching migration (the #1421 guard).
 *
 * Serial: temp GBRAIN_HOME, process.env and a fake embed transport for the file's lifecycle.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { configureGateway, resetGateway, getEmbeddingModel, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runMigrateEmbeddings, persistEmbeddingFileConfig } from '../src/commands/migrate-embeddings.ts';
import { detectEnvOverride, detectEnvPresence, envFullyPinsTarget } from '../src/core/embedding-migration.ts';
import { isConfigStashedEnv, resetConfigStashedEnvForTests, stashConfigEnv } from '../src/core/config-env-stash.ts';

const FROM_MODEL = 'voyage:voyage-4';
const TO_MODEL = 'openai:text-embedding-3-small';
const FROM_DIMS = 1024;
const TO_DIMS = 1536;

let engine: PGLiteEngine;
let tmpHome: string;
let currentDims = FROM_DIMS;
const savedEnv: Record<string, string | undefined> = {};

class ExitError extends Error { constructor(public code: number) { super(`exit ${code}`); } }
const exitSeam = (code: number): never => { throw new ExitError(code); };

async function runMigrate(args: string[]): Promise<number> {
  try {
    await runMigrateEmbeddings(engine, args, { exit: exitSeam });
    throw new Error('runMigrateEmbeddings returned without exiting');
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

function writeFileConfig(model: string, dims: number): void {
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', embedding_model: model, embedding_dimensions: dims,
    voyage_api_key: 'voyage-test-fake', openai_api_key: 'sk-test-fake',
  }, null, 2));
}
const fileModel = (): string => (JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf8')) as { embedding_model: string }).embedding_model;

function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001)),
    usage: { tokens: values.length * 4 },
  }) as never);
}

function configureFrom(): void {
  resetGateway();
  configureGateway({ embedding_model: FROM_MODEL, embedding_dimensions: FROM_DIMS, env: { VOYAGE_API_KEY: 'voyage-test-fake', OPENAI_API_KEY: 'sk-test-fake' } });
  installTransport(); // resetGateway drops the fake transport; a real provider call must never happen here
}

beforeAll(async () => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-stash-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileConfig(FROM_MODEL, FROM_DIMS);
  configureFrom();
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();
  for (const slug of ['stash-1', 'stash-2']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nbody` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4 }]);
  }
  await runEmbedCore(engine, { stale: true, quiet: true });
}, 60000);

afterEach(() => {
  resetConfigStashedEnvForTests();
  delete process.env.GBRAIN_EMBEDDING_MODEL;
  delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('R6-2 migration env checks versus the internal config stash', () => {
  test('a stashed model is invisible to detectEnvOverride / detectEnvPresence / envFullyPinsTarget; a user-set one is not', () => {
    stashConfigEnv('GBRAIN_EMBEDDING_MODEL', FROM_MODEL);
    expect(process.env.GBRAIN_EMBEDDING_MODEL).toBe(FROM_MODEL);
    expect(detectEnvOverride(TO_MODEL, TO_DIMS).triggered).toBe(false);
    expect(detectEnvPresence()).toEqual({ present: false, model: null, dims: null });
    expect(envFullyPinsTarget(FROM_MODEL, FROM_DIMS)).toBe(false); // a stash never "pins" the target
    // An injected env object is read as is (no stash applies to it).
    expect(detectEnvOverride(TO_MODEL, TO_DIMS, { GBRAIN_EMBEDDING_MODEL: FROM_MODEL } as NodeJS.ProcessEnv).triggered).toBe(true);

    resetConfigStashedEnvForTests();
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    process.env.GBRAIN_EMBEDDING_MODEL = FROM_MODEL; // the user really set it
    stashConfigEnv('GBRAIN_EMBEDDING_MODEL', FROM_MODEL); // connectEngine writes the same key afterwards
    expect(isConfigStashedEnv('GBRAIN_EMBEDDING_MODEL')).toBe(false);
    expect(detectEnvOverride(TO_MODEL, TO_DIMS).triggered).toBe(true);
    expect(detectEnvPresence().present).toBe(true);
    expect(envFullyPinsTarget(FROM_MODEL, FROM_DIMS)).toBe(true);
  });

  test('a model the USER set in the environment still refuses a migration to another model (config untouched)', async () => {
    process.env.GBRAIN_EMBEDDING_MODEL = FROM_MODEL;
    stashConfigEnv('GBRAIN_EMBEDDING_MODEL', FROM_MODEL); // does not turn the user's variable into a stash
    expect(await runMigrate(['--to', TO_MODEL, '--dim', String(TO_DIMS), '--yes', '--max-cost-usd', '1'])).toBe(1);
    expect(fileModel()).toBe(FROM_MODEL);
    expect(process.env.GBRAIN_EMBEDDING_MODEL).toBe(FROM_MODEL);
  }, 60000);

  test('persistEmbeddingFileConfig refreshes a stash to the persisted target and leaves a user-set variable alone', async () => {
    try {
      stashConfigEnv('GBRAIN_EMBEDDING_MODEL', FROM_MODEL);
      await persistEmbeddingFileConfig(TO_MODEL, TO_DIMS);
      expect(fileModel()).toBe(TO_MODEL);
      expect(process.env.GBRAIN_EMBEDDING_MODEL).toBe(TO_MODEL);
      expect(isConfigStashedEnv('GBRAIN_EMBEDDING_MODEL')).toBe(true);
      expect(getEmbeddingModel()).toBe(TO_MODEL);

      resetConfigStashedEnvForTests();
      process.env.GBRAIN_EMBEDDING_MODEL = FROM_MODEL; // user-set: env keeps winning, untouched
      await persistEmbeddingFileConfig(TO_MODEL, TO_DIMS);
      expect(process.env.GBRAIN_EMBEDDING_MODEL).toBe(FROM_MODEL);
    } finally {
      writeFileConfig(FROM_MODEL, FROM_DIMS);
      configureFrom();
    }
  });

  test('with only a stash present, migrating to another model is not refused; the stash follows the persisted target and the gateway runs it', async () => {
    stashConfigEnv('GBRAIN_EMBEDDING_MODEL', FROM_MODEL);
    currentDims = TO_DIMS;
    const code = await runMigrate(['--to', TO_MODEL, '--dim', String(TO_DIMS), '--yes', '--max-cost-usd', '1']);
    expect(code).toBe(0);
    expect(fileModel()).toBe(TO_MODEL);
    expect(process.env.GBRAIN_EMBEDDING_MODEL).toBe(TO_MODEL);
    expect(isConfigStashedEnv('GBRAIN_EMBEDDING_MODEL')).toBe(true);
    expect(getEmbeddingModel()).toBe(TO_MODEL);
    const vectors = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL');
    expect(Number(vectors[0]?.n)).toBe(2);
  }, 90000);
});
