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

export async function enqueueTask(job: TaskJob): Promise<void> {
  await getTaskQueue().add(job.mode, job, {
    jobId: `run-${job.taskRunId}`, // idempotent per attempt
  });
}

// ── Redis keys for locks/flags (SPEC §8) ────────────────────────────────────
export const redisKeys = {
  repoLock: (repoFullName: string) => `lock:repo:${repoFullName}`,
  codexAuthLock: () => `lock:codex-auth`,
  cancelTask: (taskId: number) => `cancel:task:${taskId}`,
};

/** Acquire a repo lock. Returns true on success. */
export async function acquireRepoLock(
  repoFullName: string,
  holderId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const res = await getRedis().set(
    redisKeys.repoLock(repoFullName),
    holderId,
    "EX",
    ttlSeconds,
    "NX",
  );
  return res === "OK";
}

/** Release a repo lock only if we still hold it (compare-and-delete). */
export async function releaseRepoLock(
  repoFullName: string,
  holderId: string,
): Promise<void> {
  const lua = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end`;
  await getRedis().eval(lua, 1, redisKeys.repoLock(repoFullName), holderId);
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
