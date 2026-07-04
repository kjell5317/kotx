import { logger } from "./logger.js";

const HA_URL = process.env.HA_BASE_URL?.replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN;
const HA_SERVICE = process.env.HA_NOTIFY_SERVICE; // e.g. mobile_app_pixel_7

/**
 * Stable per-task notification tag. A later notify (or clear) carrying the same
 * tag replaces / dismisses the earlier one on the mobile app, so a task shows at
 * most one live notification and it can be cleared once the task reaches a
 * normal non-failure state.
 */
export function taskNotifyTag(taskId: number): string {
  return `kotx-task-${taskId}`;
}

/** POST a notify-service payload to Home Assistant. No-op unless all three HA_*
 * env vars are set; failures are logged, never thrown. */
async function post(body: unknown, tag: string): Promise<void> {
  if (!HA_URL || !HA_TOKEN || !HA_SERVICE) return;
  try {
    const res = await fetch(`${HA_URL}/api/services/notify/${HA_SERVICE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, tag }, "home assistant notify failed");
    }
  } catch (err) {
    logger.warn({ err, tag }, "home assistant notify error");
  }
}

/** Legacy task actions that older notification buttons could fire, mapped 1:1
 * onto the API's `POST /api/tasks/:id/<kind>` routes. */
export type TaskNotifyActionKind = "start" | "approve";

/** Parse a legacy action id; null for foreign/malformed action ids. */
export function parseTaskNotifyAction(
  action: string,
): { taskId: number; kind: TaskNotifyActionKind } | null {
  const m = /^kotx-task-(\d+)-(start|approve)$/.exec(action);
  if (!m) return null;
  return { taskId: Number(m[1]), kind: m[2] as TaskNotifyActionKind };
}

/**
 * Push a notification to Home Assistant's notify service. `tag` lets a later
 * notification replace an earlier one with the same tag on Android, and lets
 * `clearNotification` dismiss it later.
 */
export async function notify(opts: {
  title: string;
  message: string;
  tag: string;
  url?: string;
}): Promise<void> {
  await post(
    {
      title: opts.title,
      message: opts.message,
      data: {
        tag: opts.tag, // Android: same tag replaces the previous notification
        ...(opts.url ? { clickAction: opts.url, url: opts.url } : {}),
      },
    },
    opts.tag,
  );
}

/**
 * Dismiss a previously-sent notification by tag. Home Assistant's companion apps
 * treat the reserved `clear_notification` message as "remove the notification
 * carrying this tag", so stale task notifications disappear once the task moves
 * to a normal non-failure state.
 */
export async function clearNotification(tag: string): Promise<void> {
  await post({ message: "clear_notification", data: { tag } }, tag);
}
