import {
  loadEnv,
  logger,
  notify,
  parseTaskNotifyAction,
  taskNotifyTag,
} from "@kotx/shared";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

const HA_URL = process.env.HA_BASE_URL?.replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN;

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const PING_INTERVAL_MS = 30_000;
// No message (event/pong) for this long → assume a dead socket and reconnect.
const STALE_AFTER_MS = 90_000;

/** Messages of the HA WebSocket API we care about
 * (https://developers.home-assistant.io/docs/api/websocket). */
interface HaMessage {
  type: string;
  success?: boolean;
  event?: {
    event_type?: string;
    data?: { action?: string; actionName?: string };
  };
}

/**
 * Listen on Home Assistant's event bus for stale notification-button taps from
 * older deployments and fire the corresponding task action. The companion app
 * turns a tapped action button into a `mobile_app_notification_action` event
 * carrying the button's `action` id; legacy ids such as `kotx-task-42-start`
 * are mapped back onto the task API (`POST /api/tasks/42/start`) and dispatched
 * in-process via Fastify's inject, so the button goes through exactly the same
 * auth and state guards as the frontend. No HA automation is needed.
 *
 * No-op unless the HA notify env vars are set (same gate as `notify`) — but the
 * API must be enabled (API_TOKEN) for the dispatch to pass auth.
 * Returns a stop function for shutdown.
 */
export function startHaActionListener(app: FastifyInstance): () => void {
  if (!HA_URL || !HA_TOKEN) return () => {};
  if (!loadEnv().apiToken) {
    logger.warn(
      "HA notification buttons disabled: API_TOKEN is not set, so actions cannot be dispatched",
    );
    return () => {};
  }

  const wsUrl = `${HA_URL.replace(/^http/, "ws")}/api/websocket`;
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoffMs = RECONNECT_MIN_MS;
  let msgId = 1;
  let lastMessageAt = 0;
  let pinger: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const connect = (): void => {
    if (stopped) return;
    ws = new WebSocket(wsUrl);
    lastMessageAt = Date.now();

    ws.on("message", (raw) => {
      lastMessageAt = Date.now();
      let msg: HaMessage;
      try {
        msg = JSON.parse(String(raw)) as HaMessage;
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        ws?.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      } else if (msg.type === "auth_ok") {
        backoffMs = RECONNECT_MIN_MS; // healthy again — reset the backoff
        ws?.send(
          JSON.stringify({
            id: msgId++,
            type: "subscribe_events",
            event_type: "mobile_app_notification_action",
          }),
        );
        logger.info({ wsUrl }, "HA notification-action listener connected");
      } else if (msg.type === "auth_invalid") {
        // A bad token won't fix itself while we run — stop instead of spamming.
        logger.error("HA websocket auth failed — notification buttons disabled");
        stopped = true;
        ws?.close();
      } else if (msg.type === "event") {
        // Android sends `action`; older iOS companion apps send `actionName`.
        const action =
          msg.event?.data?.action ?? msg.event?.data?.actionName ?? "";
        void handleAction(app, action);
      }
    });

    ws.on("error", (err) => {
      logger.warn({ err, wsUrl }, "HA websocket error");
    });

    ws.on("close", () => {
      ws = null;
      if (stopped) return;
      reconnectTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    });
  };

  // Keepalive: HA answers pings; a socket that stops answering (e.g. HA restart
  // behind a proxy that keeps TCP open) is terminated so `close` reconnects.
  pinger = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastMessageAt > STALE_AFTER_MS) {
      logger.warn("HA websocket stale — reconnecting");
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify({ id: msgId++, type: "ping" }));
  }, PING_INTERVAL_MS);

  connect();

  return () => {
    stopped = true;
    if (pinger) clearInterval(pinger);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

/** Map a tapped button back onto the task API and dispatch it in-process. */
async function handleAction(
  app: FastifyInstance,
  action: string,
): Promise<void> {
  const parsed = parseTaskNotifyAction(action);
  if (!parsed) return; // some other integration's notification — not ours
  const url = `/api/tasks/${parsed.taskId}/${parsed.kind}`;
  try {
    const res = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${loadEnv().apiToken}` },
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.info({ action, url }, "notification action dispatched");
      return;
    }
    // The tap dismissed the notification on the phone, so a silent failure
    // would read as success — push the error back out (same tag replaces any
    // remnant; the deep link isn't known here, the frontend still is).
    const error =
      (JSON.parse(res.body) as { error?: string }).error ?? `HTTP ${res.statusCode}`;
    logger.warn({ action, url, error }, "notification action failed");
    await notify({
      title: "Action failed",
      message: `${parsed.kind === "start" ? "Start implementation" : "Open PR"} — ${error}`,
      tag: taskNotifyTag(parsed.taskId),
    });
  } catch (err) {
    logger.warn({ err, action, url }, "notification action dispatch error");
  }
}
