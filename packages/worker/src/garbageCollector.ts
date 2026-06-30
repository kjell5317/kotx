import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import Docker from "dockerode";
import {
  listActiveRunIds,
  listFinishedNonLatestRunsOlderThan,
  listRetainableFinishedNonLatestRuns,
  loadDefaults,
  loadEnv,
  logger,
  runDirFor,
  worktreePathFor,
  type GcRunCandidate,
} from "@kotx/shared";
import { dindNetwork, dindVolume } from "./runner.js";

interface SizedRun extends GcRunCandidate {
  bytes: number;
}

interface GarbageCollectorHandle {
  stop: () => Promise<void>;
}

function expectedNumericChildPath(
  dataDir: string,
  childDir: "runs" | "worktrees",
  runId: number,
  path: string,
): boolean {
  const resolved = resolve(path);
  const parent = resolve(dataDir, childDir);
  const leaf = basename(resolved);
  return (
    dirname(resolved) === parent &&
    leaf === String(runId) &&
    /^\d+$/.test(leaf)
  );
}

async function pathSize(path: string): Promise<number> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;

  let total = st.size;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    total += await pathSize(resolve(path, entry.name));
  }
  return total;
}

async function removeRunPath(
  dataDir: string,
  childDir: "runs" | "worktrees",
  runId: number,
): Promise<void> {
  const path =
    childDir === "runs"
      ? runDirFor(dataDir, runId)
      : worktreePathFor(dataDir, runId);
  if (!expectedNumericChildPath(dataDir, childDir, runId, path)) {
    logger.warn({ path, childDir, runId }, "refusing unsafe gc path");
    return;
  }
  await rm(path, { recursive: true, force: true });
}

async function sizedRuns(
  dataDir: string,
  runs: GcRunCandidate[],
): Promise<SizedRun[]> {
  const sized: SizedRun[] = [];
  for (const run of runs) {
    sized.push({
      ...run,
      bytes: await pathSize(runDirFor(dataDir, run.id)),
    });
  }
  return sized;
}

async function runsOverByteLimit(
  dataDir: string,
  maxRetainedRunBytes: number | null,
): Promise<Set<number>> {
  if (maxRetainedRunBytes === null) return new Set();

  const runs = await sizedRuns(dataDir, await listRetainableFinishedNonLatestRuns());
  let retainedBytes = runs.reduce((sum, run) => sum + run.bytes, 0);
  const deleteIds = new Set<number>();
  for (const run of runs) {
    if (retainedBytes <= maxRetainedRunBytes) break;
    deleteIds.add(run.id);
    retainedBytes -= run.bytes;
  }
  return deleteIds;
}

async function collectFilesystem(): Promise<void> {
  const env = loadEnv();
  const gc = loadDefaults().garbage_collection;
  const cutoff = new Date(Date.now() - gc.run_retention_sec * 1000);
  const ageEligible = await listFinishedNonLatestRunsOlderThan(cutoff);
  const byteEligible = await runsOverByteLimit(
    env.agentDataDir,
    gc.max_retained_run_bytes,
  );
  const runIds = new Set<number>([
    ...ageEligible.map((run) => run.id),
    ...byteEligible,
  ]);

  for (const runId of runIds) {
    await removeRunPath(env.agentDataDir, "runs", runId).catch((err) => {
      logger.warn({ err, runId }, "failed to remove run dir during gc");
    });
    await removeRunPath(env.agentDataDir, "worktrees", runId).catch((err) => {
      logger.warn({ err, runId }, "failed to remove worktree during gc");
    });
  }

  if (runIds.size > 0) {
    logger.info({ runIds: [...runIds] }, "garbage-collected run artifacts");
  }
}

function runIdFromExactName(
  name: string,
  prefixes: readonly string[],
): number | null {
  for (const prefix of prefixes) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(name);
    if (match) return Number(match[1]);
  }
  return null;
}

async function collectDocker(): Promise<void> {
  const dk = new Docker();
  const activeRunIds = new Set(await listActiveRunIds());

  try {
    const containers = await dk.listContainers({ all: true });
    for (const container of containers) {
      const name = container.Names.find((n) => {
        const clean = n.replace(/^\//, "");
        return runIdFromExactName(clean, ["codex-task", "kotx-dind"]) !== null;
      });
      if (!name) continue;
      const clean = name.replace(/^\//, "");
      const runId = runIdFromExactName(clean, ["codex-task", "kotx-dind"]);
      if (runId === null || activeRunIds.has(runId)) continue;
      await dk
        .getContainer(container.Id)
        .remove({ force: true })
        .catch((err) =>
          logger.warn({ err, name: clean, runId }, "failed to remove gc container"),
        );
    }

    const volumes = await dk.listVolumes();
    for (const volume of volumes.Volumes ?? []) {
      const runId = runIdFromExactName(volume.Name, ["kotx-dind"]);
      if (runId === null || activeRunIds.has(runId)) continue;
      await dk
        .getVolume(dindVolume(runId))
        .remove({ force: true })
        .catch((err) =>
          logger.warn({ err, name: volume.Name, runId }, "failed to remove gc volume"),
        );
    }

    const networks = await dk.listNetworks();
    for (const network of networks) {
      const runId = runIdFromExactName(network.Name, ["kotx-run"]);
      if (runId === null || activeRunIds.has(runId)) continue;
      await dk
        .getNetwork(dindNetwork(runId))
        .remove()
        .catch((err) =>
          logger.warn({ err, name: network.Name, runId }, "failed to remove gc network"),
        );
    }
  } catch (err) {
    logger.warn({ err }, "docker garbage collection failed");
  }
}

export async function sweepGarbage(): Promise<void> {
  const gc = loadDefaults().garbage_collection;
  if (!gc.enabled) return;
  await collectFilesystem();
  await collectDocker();
}

export function startGarbageCollector(): GarbageCollectorHandle {
  const gc = loadDefaults().garbage_collection;
  if (!gc.enabled) return { stop: async () => {} };

  let running: Promise<void> | null = null;
  const run = (): void => {
    if (running) return;
    running = sweepGarbage()
      .catch((err) => logger.warn({ err }, "garbage collection sweep failed"))
      .finally(() => {
        running = null;
      });
  };

  run();
  const interval = setInterval(run, gc.sweep_interval_sec * 1000);
  return {
    stop: async () => {
      clearInterval(interval);
      await running;
    },
  };
}

export const gcPathGuards = { expectedNumericChildPath };
