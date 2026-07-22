/**
 * Operator controls for the durable chunk embedding failure ledger.
 *
 *   gbrain embed-failures list [--source X]
 *   gbrain embed-failures release <slug> [--chunk N] [--source X]
 */
import type { BrainEngine } from '../core/engine.ts';
import { bigintToStringReplacer } from '../cli.ts';

const HELP = `Usage:
  gbrain embed-failures list [--source X]
  gbrain embed-failures release <slug> [--chunk N] [--source X]`;

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseChunkIndex(args: string[]): number | undefined {
  const value = readFlag(args, '--chunk');
  if (value === undefined) return undefined;
  const chunkIndex = Number(value);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('--chunk must be a non-negative integer');
  }
  return chunkIndex;
}

function firstPositional(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--source' || arg === '--chunk') {
      index++;
      continue;
    }
    if (!arg.startsWith('--')) return arg;
  }
  return undefined;
}

export async function runEmbedFailures(engine: BrainEngine, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === '--help' || subcommand === '-h' || subcommand === undefined) {
    console.log(HELP);
    return;
  }

  const rest = args.slice(1);
  const sourceId = readFlag(rest, '--source');
  switch (subcommand) {
    case 'list': {
      const rows = await engine.listEmbedFailures({ sourceId });
      console.log(JSON.stringify(rows, bigintToStringReplacer, 2));
      return;
    }
    case 'release': {
      const slug = firstPositional(rest);
      if (!slug) throw new Error('Usage: gbrain embed-failures release <slug> [--chunk N] [--source X]');
      const released = await engine.releaseEmbedFailures({
        slug,
        sourceId,
        chunkIndex: parseChunkIndex(rest),
      });
      console.log(`Released ${released} embed failure record(s) for ${slug}.`);
      return;
    }
    default:
      throw new Error(`Unknown embed-failures command: ${subcommand}\n${HELP}`);
  }
}
