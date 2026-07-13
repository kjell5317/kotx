import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { getRedis, loadDefaults, loadEnv, logger, redisKeys } from "@kotx/shared";
import { run } from "./exec.js";

/**
 * Best-effort decode of token expiry from $CODEX_HOME/auth.json. Returns epoch
 * seconds, or null if it can't be determined. The exact auth.json shape must be
 * confirmed against the installed Codex CLI version (mirrors SPEC §16 Q6).
 */
function tokenExpiryEpoch(codexHome: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    const access: unknown =
      raw?.tokens?.access_token ?? raw?.access_token ?? null;
    if (typeof access === "string" && access.split(".").length === 3) {
      const payload = JSON.parse(
        Buffer.from(access.split(".")[1]!, "base64url").toString("utf8"),
      );
      if (typeof payload.exp === "number") return payload.exp;
    }
  } catch {
    /* unreadable / unexpected shape — treat as unknown */
  }
  return null;
}

/**
 * Refresh the Codex auth token on the host if it expires within the configured
 * skew, serialized under a Redis lock so concurrent workers don't race (SPEC
 * §D4/§13). Containers mount $CODEX_HOME read-only, so refresh MUST happen here.
 *
 * The refresh command itself is configurable via CODEX_REFRESH_CMD because the
 * exact CLI invocation depends on the installed version; if unset, we delegate
 * to the CLI's own runtime refresh and only warn when the token looks stale.
 */
export async function ensureFreshAuth(): Promise<void> {
  const env = loadEnv();
  const skew = loadDefaults().codex.auth_refresh_skew_sec;
  const exp = tokenExpiryEpoch(env.codexHome);
  const nowSec = Math.floor(Date.now() / 1000);

  if (exp !== null && exp - nowSec > skew) return; // still fresh

  const redis = getRedis();
  const lockKey = redisKeys.codexAuthLock();
  const got = await redis.set(lockKey, "1", "EX", 120, "NX");
  if (got !== "OK") {
    // another worker is refreshing; brief wait then continue (its write lands RO-visible)
    await new Promise((r) => setTimeout(r, 2000));
    return;
  }
  try {
    const cmd = process.env.CODEX_REFRESH_CMD;
    if (!cmd) {
      logger.warn(
        { exp },
        "codex token near/at expiry and no CODEX_REFRESH_CMD set; relying on CLI runtime refresh",
      );
      return;
    }
    const [bin, ...args] = cmd.split(" ");
    await run(bin!, args, { env: { ...process.env, CODEX_HOME: env.codexHome } });
    logger.info("refreshed codex auth on host");
  } finally {
    await redis.del(lockKey);
  }
}

/**
 * After a run, copy the run's (writable) CODEX_HOME `auth.json` back to the host
 * if Codex rotated the token during the run.
 *
 * ChatGPT/OpenAI OAuth uses ROTATING refresh tokens: every refresh mints a new
 * refresh token and invalidates the previous one. Because each run gets a private
 * copy of `auth.json` (so concurrent runners don't share a writable auth dir), a
 * token Codex refreshes mid-run is otherwise LOST when that copy is discarded —
 * the host keeps the now-consumed refresh token, and the next run's attempt to
 * reuse it fails with "refresh token was already used". Writing the newer token
 * back keeps the host authoritative so the next run seeds from a live token.
 *
 * Best-effort and serialized under the same Redis lock as ensureFreshAuth, so a
 * host pre-refresh and concurrent write-backs don't clobber each other. Only
 * writes when the run's access-token expiry is strictly later than the host's
 * (i.e. Codex actually refreshed); a run that never refreshed is a no-op.
 *
 * NOTE: this cannot revive a refresh token that is ALREADY dead — if the host
 * token was consumed without being persisted (the pre-fix failure mode) or was
 * rotated by logging into the same account elsewhere, runs keep failing until you
 * re-authenticate on the host (`codex login` into $CODEX_HOME).
 */
export async function persistRefreshedAuth(
  perRunCodexHome: string,
): Promise<void> {
  const env = loadEnv();
  const runExp = tokenExpiryEpoch(perRunCodexHome);
  if (runExp === null) return; // no readable token in the run copy — nothing to persist
  const hostExp = tokenExpiryEpoch(env.codexHome);
  if (hostExp !== null && runExp <= hostExp) return; // host already as fresh — Codex didn't refresh

  const redis = getRedis();
  const lockKey = redisKeys.codexAuthLock();
  const got = await redis.set(lockKey, "1", "EX", 30, "NX");
  if (got !== "OK") {
    // A refresh/write-back is already in flight; it lands a token at least as
    // fresh as ours, so drop this one rather than contend for the lock.
    logger.debug({ runExp }, "codex auth write-back skipped: lock held");
    return;
  }
  try {
    // Re-check under the lock: another run may have persisted a newer token while
    // we waited, in which case ours is now stale — don't overwrite it.
    const hostExpNow = tokenExpiryEpoch(env.codexHome);
    if (hostExpNow !== null && runExp <= hostExpNow) return;
    await cp(
      join(perRunCodexHome, "auth.json"),
      join(env.codexHome, "auth.json"),
    );
    logger.info(
      { runExp, hostExp: hostExpNow },
      "persisted refreshed codex auth to host",
    );
  } finally {
    await redis.del(lockKey);
  }
}
