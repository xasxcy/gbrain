import { Database } from 'bun:sqlite';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statfsSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_MAX_BYTES } from './page-size-policy.ts';

export const EXPORT_MARKER = '.gbrain-export-status';
export const EXPORT_PAYLOAD_LIMIT = 32 * 1024 * 1024;
export const EXPORT_STAGE_LIMIT = 8 * 1024 * 1024 * 1024;
export const EXPORT_SNAPSHOT_MS = 10 * 60 * 1000;
/** Snapshot time each byte of a streamed (segmented) page adds: 1 MiB/s, well under the measured read rate. */
export const EXPORT_STREAM_BYTES_PER_MS = 1024 * 1024 / 1000;
/** Free space a streamed stage file must leave on the staging filesystem. */
export const EXPORT_STAGE_FREE_RESERVE = 512 * 1024 * 1024;

/**
 * @internal Work addStream does, for the export memory tests: streamed files staged (`files`), pieces and bytes
 * written, and the largest piece (the most page bytes the stream handed over at once). Counts, not time.
 */
export const exportStreamWork = { files: 0, pieces: 0, bytes: 0, largestPiece: 0 };

/** A page's payload limit: the page ceiling plus the metadata headroom the 32 MiB limit gives a 24 MiB page. */
export function exportPayloadLimit(maxBytes: number): number {
  return Math.max(maxBytes, PAGE_MAX_BYTES) + EXPORT_PAYLOAD_LIMIT - PAGE_MAX_BYTES;
}

export function exportPathKey(path: string): string {
  const parts = path.split('/');
  if (Buffer.byteLength(path) > 4096 || parts.length > 256 || parts.some(part => !part || part === '.' || part === '..'
    || /[\\\x00-\x1f\x7f:<>"|?*]/.test(part) || /[\uD800-\uDFFF]/u.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) || Buffer.byteLength(part) > 240)) {
    throw new Error('Unsafe export path. Correct the stored slug before exporting.');
  }
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

export class ExportStage {
  readonly directory = mkdtempSync(join(tmpdir(), 'gbrain-export-'));
  readonly db = new Database(join(this.directory, 'manifest.sqlite'));
  bytes = 0;
  /** Bytes of streamed stage files, bounded by the staging filesystem's free space rather than the SQLite stage. */
  fileBytes = 0;
  pages = 0;
  private files = 0;

  constructor() {
    this.db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096; PRAGMA max_page_count=2097152; CREATE TABLE paths (key TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB, file TEXT)');
    this.add(EXPORT_MARKER, 'marker');
  }

  add(path: string, kind: 'file' | 'directory' | 'marker', payload?: string): void {
    exportPathKey(path);
    const size = payload === undefined ? 0 : Buffer.byteLength(payload);
    if (size > EXPORT_PAYLOAD_LIMIT || this.bytes + size > EXPORT_STAGE_LIMIT) throw stageCapacityError();
    this.plan(path, kind, payload ?? null, null);
    this.bytes += size;
  }

  /**
   * Stage a file written piece by piece to its own file in the stage directory (published by path), so no payload is
   * held whole. `expectedBytes` must fit the staging filesystem with EXPORT_STAGE_FREE_RESERVE to spare; the written
   * bytes must stay within `limit`.
   */
  async addStream(path: string, expectedBytes: number, limit: number, pieces: AsyncIterable<Uint8Array | string>): Promise<void> {
    exportPathKey(path);
    const free = statfsSync(this.directory);
    if (expectedBytes > limit || expectedBytes + EXPORT_STAGE_FREE_RESERVE > Number(free.bavail) * Number(free.bsize)) throw stageCapacityError();
    const name = String(this.files++);
    this.plan(path, 'file', null, name);
    mkdirSync(join(this.directory, 'files'), { recursive: true });
    const fd = openSync(join(this.directory, 'files', name), 'wx', 0o600);
    let size = 0;
    exportStreamWork.files++;
    try {
      for await (const piece of pieces) {
        const bytes = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
        exportStreamWork.pieces++;
        exportStreamWork.bytes += bytes.length;
        exportStreamWork.largestPiece = Math.max(exportStreamWork.largestPiece, bytes.length);
        size += bytes.length;
        if (size > limit) throw stageCapacityError();
        for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
      }
    } finally { closeSync(fd); }
    this.fileBytes += size;
  }

  /** The stage file of a path staged by addStream. */
  filePath(name: string): string {
    return join(this.directory, 'files', name);
  }

  private plan(path: string, kind: 'file' | 'directory' | 'marker', payload: string | null, file: string | null): void {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join('/');
      const currentKind = i === parts.length ? kind : 'directory';
      const key = exportPathKey(current);
      const prior = this.db.query<{ path: string; kind: string }, [string]>('SELECT path, kind FROM paths WHERE key=?').get(key);
      if (prior) {
        if (prior.kind === 'directory' && currentKind === 'directory' && prior.path === current) continue;
        throw new Error('Export path collision (including case, Unicode, page/sidecar or file-prefix aliases). Nothing was published. Export one source at a time with --source <id> into separate fresh directories.');
      }
      this.db.query('INSERT INTO paths VALUES (?, ?, ?, ?, ?)').run(key, current, currentKind, i === parts.length ? payload : null, i === parts.length ? file : null);
    }
  }

  close(): void {
    this.db.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function stageCapacityError(): Error {
  return new Error('Export staging capacity exceeded; nothing was published. Use --source, --type or --slug-prefix to select a smaller snapshot.');
}
