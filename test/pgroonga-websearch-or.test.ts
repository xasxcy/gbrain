/**
 * FORK: the PGroonga keyword match (`chunk_text &@~ $1`) only reads uppercase `OR`; websearch_to_tsquery
 * reads a bare `or` in any case. pgroongaWebsearchOr keeps the two syntaxes agreeing on the same $1.
 * The end-to-end proof (`acme or globex` returns rows on a PGroonga database) is
 * test/e2e/keyword-arm-ranking-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { pgroongaWebsearchOr } from '../src/core/search/keyword-chunk-match.ts';

describe('pgroongaWebsearchOr', () => {
  test('uppercases a bare or between two terms, any case', () => {
    expect(pgroongaWebsearchOr('acme or globex')).toBe('acme OR globex');
    expect(pgroongaWebsearchOr('acme Or globex oR initech')).toBe('acme OR globex OR initech');
    expect(pgroongaWebsearchOr('量子 or 计算')).toBe('量子 OR 计算');
  });

  test('leaves words that only contain or, leading or trailing or, and quoted phrases alone', () => {
    expect(pgroongaWebsearchOr('oracle orbit color')).toBe('oracle orbit color');
    expect(pgroongaWebsearchOr('or acme')).toBe('or acme');
    expect(pgroongaWebsearchOr('acme or')).toBe('acme or');
    expect(pgroongaWebsearchOr('"this or that" or globex')).toBe('"this or that" OR globex');
    // Punctuation inside a phrase is literal in both syntaxes; a backslash is Groonga's escape even there.
    expect(pgroongaWebsearchOr('alpha or "beta-gamma"')).toBe('alpha OR "beta-gamma"');
    expect(pgroongaWebsearchOr('"alpha*" or beta')).toBe('"alpha*" OR beta');
    expect(pgroongaWebsearchOr('alpha or "beta\\" gamma"')).toBe('alpha or "beta\\" gamma"');
    // Groonga reads `alpha - OR beta` as `(alpha AND "-") OR beta`; websearch reads the original as alpha AND beta.
    expect(pgroongaWebsearchOr('alpha - or beta')).toBe('alpha - or beta');
    expect(pgroongaWebsearchOr('alpha or -beta')).toBe('alpha or -beta');
    expect(pgroongaWebsearchOr('alpha or - beta')).toBe('alpha or - beta');
    expect(pgroongaWebsearchOr('alpha - ! or beta')).toBe('alpha - ! or beta');
    expect(pgroongaWebsearchOr('beta "beta or gamma')).toBe('beta "beta or gamma');
    expect(pgroongaWebsearchOr('- or- or OR')).toBe('- or- or OR');
    expect(pgroongaWebsearchOr('alpha or beta*')).toBe('alpha or beta*');
    expect(pgroongaWebsearchOr('alpha or title:beta')).toBe('alpha or title:beta');
    expect(pgroongaWebsearchOr('alpha or or beta')).toBe('alpha or or beta');
  });

  test('a query without or passes through byte-identical', () => {
    for (const q of ['acme', 'globex weekly', '-acme "globex weekly"', 'acme OR globex']) {
      expect(pgroongaWebsearchOr(q)).toBe(q);
    }
  });
});
