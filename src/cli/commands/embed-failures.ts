/**
 * `gbrain embed-failures`: post-connect dispatch. FORK command (not in
 * upstream); re-homed from the old src/cli.ts handleCliOnly `case
 * 'embed-failures'`. The record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runEmbedFailures } = await import('../../commands/embed-failures.ts');
  await runEmbedFailures(engine, args);
}
