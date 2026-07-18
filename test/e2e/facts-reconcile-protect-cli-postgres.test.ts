import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('#1928 deleteFactsForPage preserves cli facts on Postgres', () => {
  const slug = 'transcripts/postgres-cli-facts';
  const sourceId = 'default';

  beforeAll(async () => {
    await setupDB();
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('excludeSourcePrefixes protects cli facts while deleting fence-owned facts', async () => {
    const engine = getEngine();
    await engine.insertFacts([
      { fact: 'fence fact', kind: 'fact', source: 'fence', row_num: 1, source_markdown_slug: slug },
      { fact: 'blank-source fact', kind: 'fact', source: '', row_num: 2, source_markdown_slug: slug },
      { fact: 'conversation fact', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 3, source_markdown_slug: slug },
    ], { source_id: sourceId });

    const { deleted } = await engine.deleteFactsForPage(slug, sourceId, {
      excludeSourcePrefixes: ['cli:'],
    });

    expect(deleted).toBe(2);
    const rows = await engine.executeRaw<{ source: string }>(
      `SELECT COALESCE(source, '') AS source FROM facts
       WHERE source_id = $1 AND source_markdown_slug = $2 ORDER BY row_num`,
      [sourceId, slug],
    );
    expect(rows.map(row => row.source)).toEqual(['cli:extract-conversation-facts']);
  });
});
