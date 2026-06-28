/**
 * Startup env preflight for out-of-process floor scripts (keep-fresh,
 * heartbeat-drain).
 *
 * Born from the 2026-06-23 floor outage: the GitHub Actions ran with their
 * repo secrets UNSET. GitHub injects unset secrets as EMPTY STRINGS, so the
 * jobs sailed past `actions/checkout` and `bun install`, started the indexer,
 * then crashed ~8 frames deep with a generic "supabase must be set" error.
 * Every scheduled run failed in ~30s for weeks and nothing alerted — the
 * ingest floor rotted invisibly while data went stale.
 *
 * This preflight moves detection to line 1 with a message that names every
 * missing key at once AND points at the cause (CI secrets), so a future
 * recurrence is diagnosed from the first log line instead of a stack trace.
 * Pure + dependency-free so it is trivially testable and safe to import early.
 */

/** Returns the required keys whose value is absent, empty, or whitespace-only. */
export function findMissingEnv(
  env: Record<string, string | undefined>,
  required: readonly string[],
): string[] {
  return required.filter((key) => {
    const value = env[key];
    return value == null || value.trim() === '';
  });
}

/**
 * Throws a single actionable error if any required env var is missing/empty.
 * Defaults to `process.env`; pass an explicit map in tests.
 */
export function requireEnv(
  required: readonly string[],
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = findMissingEnv(env, required);
  if (missing.length === 0) return;

  throw new Error(
    `Missing required environment: ${missing.join(', ')}. ` +
      `Set these as GitHub repo secrets (for the keep-fresh / heartbeat-drain ` +
      `floor) or in the runtime env. Without them the out-of-process ingest ` +
      `floor cannot connect and ingestion silently stalls.`,
  );
}
