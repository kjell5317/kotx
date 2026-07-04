// Outbound state-transition webhook for the external task manager (007).
// Every task state change POSTs the full task DTO to WEBHOOK_URL, HMAC-signed
// with WEBHOOK_SECRET. Deliveries are best-effort upserts: the payload carries
// the task's CURRENT state, order is not guaranteed, and a missed delivery is
// healed by the consumer's GET /api/tasks?updatedSince=… reconciliation.

import { createHmac } from "node:crypto";
import { loadEnv } from "./config.js";
import { getTaskListItem } from "./db.js";
import { taskDto } from "./dto.js";
import { logger } from "./logger.js";
import type { TaskState } from "./types.js";

export const WEBHOOK_SIGNATURE_HEADER = "X-Kotx-Signature";

// A handful of attempts with growing gaps; a consumer outage longer than this
// is covered by its updatedSince reconciliation, not by us queueing forever.
const RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 60_000];
const ATTEMPT_TIMEOUT_MS = 10_000;

// `queued` usually lasts only milliseconds: a task is set queued, enqueued, and
// a free worker flips it to `running` almost at once. Only report queued if the
// task is STILL waiting after this grace window, so the consumer sees a queued
// event for real waits (all slots busy) and not for instant flush-throughs. The
// running/next transition emits its own webhook, so nothing is lost by skipping.
const QUEUED_GRACE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

async function deliver(
  url: string,
  secret: string,
  rawBody: string,
): Promise<{ ok: boolean; status?: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Fire the `task.state_changed` webhook for a task. Fire-and-forget: callers
 * are state mutators (often inside request handlers), so delivery/retries run
 * in the background and never throw. `previousState` is the state before the
 * transition (null for task creation).
 *
 * No-op unless WEBHOOK_URL is configured.
 */
export function emitTaskStateChanged(
  taskId: number,
  previousState: TaskState | null,
): void {
  const { webhookUrl, webhookSecret } = loadEnv();
  if (!webhookUrl || !webhookSecret) return;
  void dispatch(webhookUrl, webhookSecret, Number(taskId), previousState).catch(
    (err) => logger.warn({ err, taskId }, "webhook dispatch error"),
  );
}

async function dispatch(
  url: string,
  secret: string,
  taskId: number,
  previousState: TaskState | null,
): Promise<void> {
  // Load the task fresh (joined with its latest run) so the payload equals
  // GET /api/tasks/:id at delivery time — an upsert, not an event log.
  let row = await getTaskListItem(taskId);
  if (!row) {
    logger.warn({ taskId }, "webhook skipped: task not found");
    return;
  }

  // A queued task that a free worker picks up immediately shouldn't emit a
  // queued event. Wait a grace window and re-check: if it already left queued,
  // drop this delivery (the transition it moved to sends its own webhook).
  if (row.state === "queued") {
    await sleep(QUEUED_GRACE_MS);
    row = await getTaskListItem(taskId);
    if (!row) {
      logger.warn({ taskId }, "webhook skipped: task not found");
      return;
    }
    if (row.state !== "queued") {
      logger.debug(
        { taskId, state: row.state },
        "webhook skipped: queued flushed within grace window",
      );
      return;
    }
  }

  const rawBody = JSON.stringify({
    event: "task.state_changed",
    previousState,
    task: taskDto(row),
    occurredAt: new Date().toISOString(),
  });

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await deliver(url, secret, rawBody);
      if (res.ok) return;
      logger.warn(
        { taskId, status: res.status, attempt },
        "webhook delivery rejected",
      );
    } catch (err) {
      logger.warn({ err, taskId, attempt }, "webhook delivery failed");
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      logger.error(
        { taskId, attempts: attempt + 1 },
        "webhook delivery gave up",
      );
      return;
    }
    await sleep(delay);
  }
}
