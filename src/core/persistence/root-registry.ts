import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configDir } from '../config.ts';
import { OperationError } from '../ops/contract.ts';

export interface ManagedRootRecord {
  local_path: string;
  source_id?: string;
  source_incarnation?: string;
  worktree_id?: string;
  topology_generation?: string | number;
}
function registryDirectory(): string { return join(configDir(), 'persistence', 'managed-roots'); }
function gitMetadataDirectory(root: string): string | null {
  const git = join(root, '.git');
  if (!existsSync(git)) return null;
  if (statSync(git).isDirectory()) return git;
  const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(git, 'utf8'));
  return match ? resolve(root, match[1]) : null;
}
function enclosingGitMetadata(root: string): string | null {
  let current = root;
  for (;;) {
    const metadata = gitMetadataDirectory(current);
    if (metadata) return metadata;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function writePrivateRecord(file: string, value: string): void {
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8');
    try {
      if (existing === value || stableJson(JSON.parse(existing)) === stableJson(JSON.parse(value))) { chmodSync(file, 0o600); return; }
    } catch { /* unreadable records must be atomically replaced by the current trusted writer */ }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, file); syncDirectory(dirname(file)); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
function markerExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new OperationError('writer_coordinator_required', 'Managed-root marker cannot be inspected.');
  }
}
/** Shared refusal marker helps installations with separate homes. It NEVER grants ownership. */
export function hasManagedRootMarker(path: string): boolean {
  let current = canonicalFilesystemPath(path);
  for (;;) {
    // A prepared claim is already a durable refusal, including when its target
    // directory does not yet exist. Ownership still requires SQL/native proof.
    const reservation = join(dirname(current), `.gbrain-owner-${createHash('sha256').update(current).digest('hex')}.json`);
    if (markerExists(reservation)) return true;
    if (existsSync(current) && statSync(current).isDirectory()) {
      if (markerExists(join(current, '.gbrain-owner.json'))) return true;
      const metadata = gitMetadataDirectory(current);
      if (markerExists(join(current, '.gbrain-managed')) || metadata && markerExists(join(metadata, 'gbrain-managed.json'))) return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
/** Resolve existing ancestors too, so an alias to a managed tree cannot bypass the fence. */
export function canonicalFilesystemPath(path: string): string {
  return resolveFilesystemPath(path, realpathSync);
}
export function nativeFilesystemPath(path: string): string {
  return resolveFilesystemPath(path, realpathSync.native);
}
function resolveFilesystemPath(path: string, realpath: (path: string) => string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return resolve(realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
    }
  }
}
/**
 * One private immutable path identity per brain/root; topology metadata can be
 * refreshed but stale roots stay fenced until an explicit verified drain clears
 * them. Per-root files prevent independent registration from dropping siblings.
 */
export function recordManagedRoots(brainId: string, records: ManagedRootRecord[]): void {
  if (!/^[a-f0-9-]{36}$/i.test(brainId)) throw new OperationError('storage_error', 'Invalid managed-root brain identity.');
  if (!records.length) return;
  const directory = registryDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  // SQL path text can carry both /var and /private/var for the same macOS
  // directory. Collapse by physical root before writing, preferring a complete
  // worktree binding over the source-only fallback row.
  const canonicalRecords = new Map<string, ManagedRootRecord>();
  const score = (record: ManagedRootRecord) => Number(record.worktree_id != null) * 4
    + Number(record.source_id != null) * 2 + Number(record.source_incarnation != null);
  for (const record of records) {
    const root = canonicalFilesystemPath(record.local_path);
    const existing = canonicalRecords.get(root);
    if (!existing || score(record) > score(existing)) canonicalRecords.set(root, record);
  }
  for (const [root, record] of canonicalRecords) {
    const key = createHash('sha256').update(root).digest('hex');
    const file = join(directory, `${brainId}.${key}.json`);
    // Keep the record byte-stable: database UNION result key order must not
    // turn an unchanged physical root into an inode-replacing rewrite.
    const value = JSON.stringify({ version: 1, brain_id: brainId, root, local_path: root,
      ...(record.source_id !== undefined ? { source_id: record.source_id } : {}),
      ...(record.source_incarnation !== undefined ? { source_incarnation: record.source_incarnation } : {}),
      ...(record.worktree_id !== undefined ? { worktree_id: record.worktree_id } : {}),
      ...(record.topology_generation != null ? { topology_generation: String(record.topology_generation) } : {}) });
    writePrivateRecord(file, value);
    if (existsSync(root) && statSync(root).isDirectory()) {
      const metadata = enclosingGitMetadata(root);
      const marker = metadata ? join(metadata, 'gbrain-managed.json') : join(root, '.gbrain-managed');
      if (!existsSync(marker)) writePrivateRecord(marker, JSON.stringify({ version: 1, managed: true, brain_id: brainId }));
    }
  }
  syncDirectory(directory);
}
/** Available before connect, including while another process owns local PGLite. */
export function registeredManagedRoots(): string[] {
  const directory = registryDirectory();
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const roots: string[] = [];
  for (const file of files.filter(file => file.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (value.version !== 1 || typeof value.root !== 'string' || !isAbsolute(value.root)) throw new Error('invalid record');
      roots.push(canonicalFilesystemPath(value.root));
    } catch {
      throw new OperationError('writer_coordinator_required', 'Managed-root ownership records are unreadable.',
        'Repair the local persistence registry through writer administration before running filesystem maintenance.');
    }
  }
  return roots;
}
