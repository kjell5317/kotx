import Docker from "dockerode";
import { loadDefaults, loadEnv, logger } from "@kotx/shared";

let docker: Docker | undefined;
function getDocker(): Docker {
  if (!docker) docker = new Docker(); // unix:///var/run/docker.sock
  return docker;
}

function parseMemory(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([gmk]?)b?$/i.exec(s.trim());
  if (!m) throw new Error(`bad memory string: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mult =
    unit === "g" ? 2 ** 30 : unit === "m" ? 2 ** 20 : unit === "k" ? 2 ** 10 : 1;
  return Math.floor(n * mult);
}

export function containerName(taskRunId: number): string {
  return `codex-task-${taskRunId}`;
}

/**
 * Run one short-lived codex-runner container. The container reads TASK.md from
 * the run-output dir and writes codex.jsonl there; it edits the worktree at
 * /workspace. Mounts only: worktree (rw), CODEX_HOME (ro), run-output (rw).
 * No Docker socket, no creds, no host home (SPEC §10.1/§14).
 *
 * Resolves with the container exit code (137 if killed). Throws only on
 * Docker-level errors (image missing, daemon down).
 */
export async function runCodexContainer(opts: {
  name: string;
  worktreePath: string;
  runOutputDir: string;
}): Promise<number> {
  const env = loadEnv();
  const defaults = loadDefaults();
  const { container: c, codex } = defaults;

  const script = [
    "codex",
    "exec",
    "--json",
    `--sandbox ${codex.sandbox}`,
    // approval policy is a config value in exec mode (no --ask-for-approval flag)
    `-c approval_policy=${codex.approval_policy}`,
    "-",
    "< /run-output/TASK.md",
    "> /run-output/codex.jsonl 2>&1",
  ].join(" ");

  const dk = getDocker();
  const created = await dk.createContainer({
    Image: c.image,
    name: opts.name,
    WorkingDir: "/workspace",
    Env: [`CODEX_HOME=/home/codex/.codex`],
    Cmd: ["bash", "-lc", script],
    HostConfig: {
      Binds: [
        `${opts.worktreePath}:/workspace:rw`,
        `${env.codexHome}:/home/codex/.codex:ro`,
        `${opts.runOutputDir}:/run-output:rw`,
      ],
      NetworkMode: c.network,
      NanoCpus: Math.floor(c.cpus * 1e9),
      Memory: parseMemory(c.memory),
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
  });

  try {
    await created.start();
    const res = (await created.wait()) as { StatusCode: number };
    return res.StatusCode;
  } finally {
    await created.remove({ force: true }).catch((err) => {
      logger.warn({ err, name: opts.name }, "container remove failed");
    });
  }
}

export async function killContainer(name: string): Promise<void> {
  try {
    await getDocker().getContainer(name).kill();
  } catch {
    /* already gone */
  }
}
