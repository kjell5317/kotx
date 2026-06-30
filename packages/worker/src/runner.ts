import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
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

/** The runner image: env override (e.g. a GHCR ref) wins over the config default. */
function runnerImage(): string {
  return process.env.CODEX_RUNNER_IMAGE ?? loadDefaults().container.image;
}

/** Auth for pulling a private GHCR image, or undefined for public images. */
function ghcrAuthConfig(): Docker.AuthConfig | undefined {
  const password = process.env.GHCR_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!password) return undefined;
  return {
    username: process.env.GHCR_USERNAME ?? "x-access-token",
    password,
    serveraddress: "ghcr.io",
  };
}

/** Pull the runner image if it isn't present locally (no-op if already pulled). */
async function ensureImage(dk: Docker, image: string): Promise<void> {
  try {
    await dk.getImage(image).inspect();
    return; // already present
  } catch {
    /* not present — pull below */
  }
  logger.info({ image }, "pulling runner image");
  const authconfig = ghcrAuthConfig();
  await new Promise<void>((resolve, reject) => {
    dk.pull(image, { authconfig }, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("no pull stream"));
      dk.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}

/**
 * Run one short-lived codex-runner container. The container reads PROMPT.md from
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
  mirrorPath: string;
}): Promise<number> {
  const env = loadEnv();
  const defaults = loadDefaults();
  const { container: c } = defaults;

  const script = [
    "codex",
    "exec",
    "--json",
    "--ephemeral",
    // The Docker container IS the sandbox (caps dropped, no socket, minimal
    // mounts, no host creds). Codex's own bwrap sandbox can't create a user
    // namespace inside it, so bypass it and let the container be the boundary.
    "--dangerously-bypass-approvals-and-sandbox",
    "-",
    "< /run-output/PROMPT.md",
    "> /run-output/codex.jsonl 2>&1",
  ].join(" ");

  // Codex needs a WRITABLE CODEX_HOME (app-server init, PATH aliases). Give each
  // run its own private copy seeded with the auth, so concurrent runners never
  // share/race a writable auth dir (preserves the intent of SPEC §D4).
  const perRunCodexHome = join(opts.runOutputDir, "codex-home");
  await mkdir(perRunCodexHome, { recursive: true });
  for (const f of ["auth.json", "config.toml"]) {
    await cp(join(env.codexHome, f), join(perRunCodexHome, f)).catch(() => {
      /* config.toml is optional; auth.json missing will surface as a Codex error */
    });
  }

  const dk = getDocker();
  const image = runnerImage();
  await ensureImage(dk, image);
  const created = await dk.createContainer({
    Image: image,
    name: opts.name,
    WorkingDir: "/workspace",
    Env: [`CODEX_HOME=/home/codex/.codex`],
    Cmd: ["bash", "-lc", script],
    HostConfig: {
      Binds: [
        `${opts.worktreePath}:/workspace:rw`,
        `${perRunCodexHome}:/home/codex/.codex:rw`,
        `${opts.runOutputDir}:/run-output:rw`,
        // mount the bare mirror at the SAME path so the worktree's .git gitfile
        // (gitdir: <mirror>/worktrees/<id>) resolves and git works in-container
        `${opts.mirrorPath}:${opts.mirrorPath}:rw`,
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
