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

/**
 * Update a key gbrain itself stashed (a no-op for a user-set variable, which keeps
 * its value and its precedence). Used when a migration persists a new target, so the
 * stash cannot keep shadowing the config file with the previous model.
 */
export function refreshConfigStashedEnv(key: string, value: string): boolean {
  if (!STASHED.has(key)) return false;
  process.env[key] = value;
  return true;
}

/**
 * The value of an embedding env var as a USER set it: `undefined` when it is unset
 * or holds only a value gbrain stashed from config. Only the live `process.env` can
 * carry a stash; an injected env object (tests, callers with their own map) is read as is.
 */
export function userEnvValue(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env === process.env && STASHED.has(key)) return undefined;
  return env[key];
}

/** True when `process.env[key]` holds a value gbrain stashed from config, not a user override. */
export function isConfigStashedEnv(key: string): boolean {
  return STASHED.has(key);
}

/** Test seam: forget every recorded stash (does not touch process.env). */
export function resetConfigStashedEnvForTests(): void {
  STASHED.clear();
}
