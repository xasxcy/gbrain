import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tamper-evidence manifest for the bundled `skills/` tree (#159).
 *
 * NOT a signature system: the manifest is a committed sha256 inventory that
 * makes silent edits to bundled skill files visible (doctor warns, CI diffs).
 * Anyone who can edit skills/ can also regenerate the manifest — the value is
 * that the edit becomes an explicit, reviewable diff instead of an invisible
 * behavior change in a fat-markdown skill an agent will later execute.
 *
 * Regenerate after any change under skills/:
 *   bun run scripts/generate-skills-manifest.ts
 * Freshness is CI-guarded by scripts/check-skills-manifest-fresh.sh.
 */

/** Committed manifest filename, lives inside the skills dir it describes. */
export const SKILLS_MANIFEST_FILENAME = 'skills.lock.json';

/** Relative posix path → sha256 hex digest. */
export type SkillsManifest = Record<string, string>;

export interface SkillsManifestDrift {
  /** Present in manifest and on disk, but content hash differs. */
  modified: string[];
  /** Present in manifest, absent on disk. */
  missing: string[];
  /** Present on disk, absent from manifest. */
  extra: string[];
}

/**
 * Hash every regular file under `dir` (recursive). Paths are '/'-separated
 * relative paths, sorted, so output is deterministic across platforms. The
 * manifest file itself is excluded from its own hash set. Symlinks and other
 * non-regular entries are skipped.
 */
/** FORK-FIX: OS-generated files that appear in local checkouts but never in git. */
const OS_JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function computeSkillsManifest(dir: string): SkillsManifest {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      // FORK-FIX: skip OS junk files. macOS drops a .DS_Store into any
      // directory Finder has visited; it is gitignored, so it exists in local
      // working copies and never in CI. Hashing it made `check:skills-manifest`
      // fail on every macOS checkout with a diff the developer cannot commit
      // away — committing the hash would then fail in CI, where the file is
      // absent. Named explicitly rather than skipping all dotfiles, because
      // migrations/.gitkeep is a real tracked manifest entry. Worth upstreaming.
      if (OS_JUNK_FILES.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile() && relPath !== SKILLS_MANIFEST_FILENAME) files.push(relPath);
    }
  };
  walk('');
  files.sort();
  const manifest: SkillsManifest = {};
  for (const f of files) {
    manifest[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  }
  return manifest;
}

/** Canonical serialized form: 2-space JSON + trailing newline. */
export function renderSkillsManifest(dir: string): string {
  return JSON.stringify(computeSkillsManifest(dir), null, 2) + '\n';
}

/** Compare `dir`'s current contents against a previously computed manifest. */
export function verifySkillsManifest(dir: string, manifest: SkillsManifest): SkillsManifestDrift {
  const actual = computeSkillsManifest(dir);
  const modified: string[] = [];
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(manifest)) {
    if (!(path in actual)) missing.push(path);
    else if (actual[path] !== hash) modified.push(path);
  }
  const extra = Object.keys(actual).filter((p) => !(p in manifest));
  return { modified, missing, extra };
}
