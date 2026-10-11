/**
 * FORK: process.env keys that gbrain itself stashed from the merged config.
 *
 * `connectEngine` (src/cli/main.ts) copies the merged embedding model(s) into
 * `process.env` so child processes and the image-embed path re-fold them through
 * `loadConfig`'s env merge. That makes the value look like a user-set environment
 * variable to anything that asks "is an env override present?" (the doctor's
 * `embedding_env_override` check would tell the operator to `unset` a variable
 * they never set). A key is recorded here only when the process had no value of
 * its own, so a genuine user override is never hidden.
 */
const STASHED = new Set<string>();

/** Set `process.env[key]`, remembering that gbrain (not the user) provided it when the key was unset. */
export function stashConfigEnv(key: string, value: string): void {
  if (process.env[key] === undefined) STASHED.add(key);
  process.env[key] = value;
}

/** True when `process.env[key]` holds a value gbrain stashed from config, not a user override. */
export function isConfigStashedEnv(key: string): boolean {
  return STASHED.has(key);
}

/** Test seam: forget every recorded stash (does not touch process.env). */
export function resetConfigStashedEnvForTests(): void {
  STASHED.clear();
}
