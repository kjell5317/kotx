import { Worker } from "bullmq";
import {
  closePool,
  getRedis,
  loadDefaults,
  loadEnv,
  loadRepos,
  logger,
  TASK_QUEUE_NAME,
  type TaskJob,
} from "@kotx/shared";
import { startGarbageCollector } from "./garbageCollector.js";
import { processJob } from "./orchestrator.js";

loadEnv();
const defaults = loadDefaults();
loadRepos();

const worker = new Worker<TaskJob>(
  TASK_QUEUE_NAME,
  async (job) => {
    await processJob(job.data);
  },
  {
    connection: getRedis(),
    concurrency: defaults.concurrency.max_global_workers,
  },
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "job failed (worker level)");
});
worker.on("ready", () => logger.info("worker ready"));

const garbageCollector = startGarbageCollector();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down worker");
  await garbageCollector.stop();
  await worker.close();
  await closePool();
  await getRedis().quit();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
