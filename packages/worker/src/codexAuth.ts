import { readFileSync } from "node:fs";
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
