import { logger } from "@kotx/shared";

const HA_URL = process.env.HA_BASE_URL?.replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN;
const HA_SERVICE = process.env.HA_NOTIFY_SERVICE; // e.g. mobile_app_pixel_7

/**
 * Push a notification to Home Assistant's notify service. No-op unless all three
 * HA_* env vars are set. `tag` lets a later notification replace an earlier one
 * with the same tag on Android (so "started" → "finished" updates in place).
 */
export async function notify(opts: {
  title: string;
  message: string;
  tag: string;
  url?: string;
}): Promise<void> {
  if (!HA_URL || !HA_TOKEN || !HA_SERVICE) return;
  try {
    const res = await fetch(`${HA_URL}/api/services/notify/${HA_SERVICE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: opts.title,
        message: opts.message,
        data: {
          tag: opts.tag, // Android: same tag replaces the previous notification
          ...(opts.url ? { clickAction: opts.url, url: opts.url } : {}),
        },
      }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, tag: opts.tag },
        "home assistant notify failed",
      );
    }
  } catch (err) {
    logger.warn({ err, tag: opts.tag }, "home assistant notify error");
  }
}
