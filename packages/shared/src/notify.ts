import { logger } from "./logger.js";

const HA_URL = process.env.HA_BASE_URL?.replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN;
const HA_SERVICE = process.env.HA_NOTIFY_SERVICE; // e.g. mobile_app_pixel_7

/**
 * Stable per-task notification tag. A later notify (or clear) carrying the same
 * tag replaces / dismisses the earlier one on the mobile app, so a task shows at
 * most one live notification and it can be cleared once the task no longer needs
 * my attention.
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

/** An actionable-notification button (Home Assistant companion app format).
 * Tapping it fires a `mobile_app_notification_action` event on the HA event bus
 * carrying `action`; the app's HA listener turns that back into an API call. */
export interface NotifyAction {
  action: string;
  title: string;
}

/** The kinds of task actions a notification button can fire, mapped 1:1 onto
 * the API's `POST /api/tasks/:id/<kind>` routes. */
export type TaskNotifyActionKind = "start" | "approve";

/** Stable action id for a notification button, e.g. `kotx-task-42-start`. */
export function taskNotifyAction(
  taskId: number,
  kind: TaskNotifyActionKind,
): string {
  return `kotx-task-${taskId}-${kind}`;
}

/** Inverse of `taskNotifyAction`; null for foreign/malformed action ids. */
export function parseTaskNotifyAction(
  action: string,
): { taskId: number; kind: TaskNotifyActionKind } | null {
  const m = /^kotx-task-(\d+)-(start|approve)$/.exec(action);
  if (!m) return null;
  return { taskId: Number(m[1]), kind: m[2] as TaskNotifyActionKind };
}

/**
 * Push a notification to Home Assistant's notify service. `tag` lets a later
 * notification replace an earlier one with the same tag on Android (so a fresh
 * state updates in place), and lets `clearNotification` dismiss it later.
 * `actions` become tappable buttons on the companion app.
 */
export async function notify(opts: {
  title: string;
  message: string;
  tag: string;
  url?: string;
  actions?: NotifyAction[];
}): Promise<void> {
  await post(
    {
      title: opts.title,
      message: opts.message,
      data: {
        tag: opts.tag, // Android: same tag replaces the previous notification
        ...(opts.url ? { clickAction: opts.url, url: opts.url } : {}),
        ...(opts.actions?.length ? { actions: opts.actions } : {}),
      },
    },
    opts.tag,
  );
}

/**
 * Dismiss a previously-sent notification by tag. Home Assistant's companion apps
 * treat the reserved `clear_notification` message as "remove the notification
 * carrying this tag", so a stale prompt (e.g. "Open PR") disappears once the
 * action it asked for is done.
 */
export async function clearNotification(tag: string): Promise<void> {
  await post({ message: "clear_notification", data: { tag } }, tag);
}
