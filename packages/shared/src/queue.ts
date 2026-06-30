import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "./config.js";
import { TASK_QUEUE_NAME, type TaskJob } from "./types.js";

let connection: Redis | undefined;

/** Shared ioredis connection. BullMQ requires maxRetriesPerRequest: null. */
export function getRedis(): Redis {
  if (!connection) {
    connection = new Redis(loadEnv().redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return connection as Redis;
}

let taskQueue: Queue<TaskJob> | undefined;

export function getTaskQueue(): Queue<TaskJob> {
  if (!taskQueue) {
    taskQueue = new Queue<TaskJob>(TASK_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 1, // re-runs are explicit (HITL / operator), never automatic
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return taskQueue as Queue<TaskJob>;
}

/**
 * Enqueue a task run. By default the job id is `run-<taskRunId>` so the same
 * attempt can't be double-enqueued. The busy-requeue path passes an explicit
 * `jobId` (a fresh, unique one) + `delayMs`: re-adding with the *same* id while
 * the current job is still active is silently de-duplicated by BullMQ, which is
 * how queued tasks used to get orphaned.
 */
export async function enqueueTask(
  job: TaskJob,
  opts: { jobId?: string; delayMs?: number } = {},
): Promise<void> {
  await getTaskQueue().add(`${job.kind}:${job.phase}`, job, {
    jobId: opts.jobId ?? `run-${job.taskRunId}`,
    delay: opts.delayMs,
  });
}

// ── Redis keys for locks/flags (SPEC §8) ────────────────────────────────────
export const redisKeys = {
  repoSlot: (repoFullName: string, slot: number) =>
    `lock:repo:${repoFullName}:${slot}`,
  codexAuthLock: () => `lock:codex-auth`,
  cancelTask: (taskId: number) => `cancel:task:${taskId}`,
};

/**
 * Acquire one of `maxSlots` concurrency slots for a repo (a counting semaphore
 * over N Redis keys, honoring `max_workers_per_repo`). Returns the slot index
 * held, or null if all slots are taken. The TTL is a crash safety net: a worker
 * that dies without releasing frees its slot when the key expires, so a failed
 * run can't clog the repo indefinitely.
 */
export async function acquireRepoSlot(
  repoFullName: string,
  holderId: string,
  maxSlots: number,
  ttlSeconds: number,
): Promise<number | null> {
  for (let slot = 0; slot < maxSlots; slot++) {
    const res = await getRedis().set(
      redisKeys.repoSlot(repoFullName, slot),
      holderId,
      "EX",
      ttlSeconds,
      "NX",
    );
    if (res === "OK") return slot;
  }
  return null;
}

/** Release a repo slot only if we still hold it (compare-and-delete). */
export async function releaseRepoSlot(
  repoFullName: string,
  slot: number,
  holderId: string,
): Promise<void> {
  const lua = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end`;
  await getRedis().eval(
    lua,
    1,
    redisKeys.repoSlot(repoFullName, slot),
    holderId,
  );
}

export async function setCancelFlag(taskId: number): Promise<void> {
  await getRedis().set(redisKeys.cancelTask(taskId), "1", "EX", 3600);
}

export async function isCancelled(taskId: number): Promise<boolean> {
  return (await getRedis().exists(redisKeys.cancelTask(taskId))) === 1;
}

export async function clearCancelFlag(taskId: number): Promise<void> {
  await getRedis().del(redisKeys.cancelTask(taskId));
}
