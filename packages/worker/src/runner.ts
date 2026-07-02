import { cp, mkdir, readFile } from "node:fs/promises";
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

// Per-run names for the optional dev-container (DinD) sidecar.
export const dindName = (runId: number) => `kotx-dind-${runId}`;
export const dindNetwork = (runId: number) => `kotx-run-${runId}`;
export const dindVolume = (runId: number) => `kotx-dind-${runId}`;
// Hostname the runner uses to reach the sidecar daemon (network alias).
const DIND_HOST = "dind";

/**
 * Bring up the per-run dev-container sidecar: a private network, an anonymous
 * volume for the nested daemon's /var/lib/docker (overlay2 needs a real fs, not
 * overlay-on-overlay), and a privileged `docker:dind` container that exposes a
 * plain-TCP daemon at tcp://dind:2375 on that network. Returns the network name
 * the runner must join. Privilege is confined to this throwaway sidecar — the
 * runner itself stays cap-dropped.
 */
async function setupDind(dk: Docker, runId: number): Promise<string> {
  const c = loadDefaults().container;
  const network = dindNetwork(runId);
  await ensureImage(dk, c.dind_image);
  await dk.createNetwork({ Name: network, Driver: "bridge" });
  const dind = await dk.createContainer({
    Image: c.dind_image,
    name: dindName(runId),
    // empty TLS cert dir → dockerd listens on plain tcp 2375 (private network only)
    Env: ["DOCKER_TLS_CERTDIR="],
    HostConfig: {
      Privileged: true,
      NetworkMode: network,
      Binds: [`${dindVolume(runId)}:/var/lib/docker`],
      AutoRemove: false,
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [DIND_HOST] } } },
  });
  await dind.start();
  return network;
}

/** Tear the sidecar down: removing the dind container kills its daemon and every
 *  nested container with it; then drop the volume and the private network. */
async function teardownDind(dk: Docker, runId: number): Promise<void> {
  await dk
    .getContainer(dindName(runId))
    .remove({ force: true })
    .catch(() => {});
  await dk.getVolume(dindVolume(runId)).remove({ force: true }).catch(() => {});
  await dk.getNetwork(dindNetwork(runId)).remove().catch(() => {});
}

/**
 * Run one short-lived codex-runner container. The container reads PROMPT.md from
 * the run-output dir and writes codex.jsonl there; it edits the worktree at
 * /workspace. Mounts only: worktree (rw), CODEX_HOME (ro), run-output (rw).
 * No host Docker socket, no creds, no host home (SPEC §10.1/§14).
 *
 * When dev-containers are enabled, a privileged `docker:dind` sidecar is started
 * first on a private per-run network and the runner is pointed at it via
 * DOCKER_HOST, so Codex can create test containers. Both the runner and the
 * sidecar (and everything nested in it) are removed when the run ends.
 *
 * Resolves with the container exit code (137 if killed). Throws only on
 * Docker-level errors (image missing, daemon down).
 */
export async function runCodexContainer(opts: {
  name: string;
  runId: number;
  worktreePath: string;
  runOutputDir: string;
  mirrorPath: string;
}): Promise<number> {
  const env = loadEnv();
  const defaults = loadDefaults();
  const { container: c } = defaults;
  const dk = getDocker();
  const useDind = c.dev_containers;

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

  // With a sidecar, wait for its daemon to come up before handing off to Codex
  // (no-op cost if Codex never uses docker), then run codex.
  const wait = useDind
    ? "for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done; "
    : "";
  const effort = defaults.codex.reasoning_effort;
  const script =
    wait +
    [
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      // The Docker container IS the sandbox (caps dropped, no host socket,
      // minimal mounts, no host creds). Codex's own bwrap sandbox can't create a
      // user namespace inside it, so bypass it and let the container be the
      // boundary; any docker use targets the isolated sidecar daemon.
      "--dangerously-bypass-approvals-and-sandbox",
      // operator-configured reasoning effort (omitted → model/config.toml default)
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "-",
      "< /run-output/PROMPT.md",
      "> /run-output/codex.jsonl 2>&1",
    ].join(" ");

  const containerEnv = [`CODEX_HOME=/home/codex/.codex`];
  if (useDind)
    containerEnv.push(`DOCKER_HOST=tcp://${DIND_HOST}:2375`, "DOCKER_TLS_CERTDIR=");

  const image = runnerImage();
  await ensureImage(dk, image);

  try {
    const network = useDind ? await setupDind(dk, opts.runId) : c.network;
    const created = await dk.createContainer({
      Image: image,
      name: opts.name,
      WorkingDir: "/workspace",
      Env: containerEnv,
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
        // user-defined per-run network (DinD) still has egress + DNS for `dind`
        NetworkMode: network,
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
  } finally {
    if (useDind) await teardownDind(dk, opts.runId);
  }
}

/**
 * Commit the worktree inside the sandbox with the repository's own git hooks
 * ENABLED, so a `pre-commit`/`commit-msg` hook that rejects the change fails the
 * commit here instead of on the worker host (untrusted repo code stays in the
 * same locked-down container Codex runs in). A commit is purely local — no creds
 * or remote — so the host still owns the push afterwards.
 *
 * Reads the message from /run-output/COMMIT_MSG.txt and tees the hook output to
 * /run-output/HOOKS.log. Resolves with:
 *   - "committed":   a commit was created (hooks passed)
 *   - "nothing":     nothing staged to commit (no-op; not a failure)
 *   - "hook_failed": git commit exited non-zero (a hook rejected it)
 * `hookOutput` carries the tee'd log for the "hook_failed" case (empty otherwise).
 *
 * A present `.pre-commit-config.yaml` whose git hook isn't wired up is treated as
 * a failure (not a silent pass): the framework's checks would otherwise be
 * skipped entirely. Wiring the hook (`pre-commit install`, persisted via the
 * mirror) is Codex's job; this container supplies the `pre-commit` CLI the wired
 * hook invokes, since a global install in Codex's own container doesn't persist.
 */
export async function runCommitContainer(opts: {
  name: string;
  worktreePath: string;
  runOutputDir: string;
  mirrorPath: string;
}): Promise<{
  status: "committed" | "nothing" | "hook_failed";
  exitCode: number;
  hookOutput: string;
}> {
  const env = loadEnv();
  const defaults = loadDefaults();
  const { container: c } = defaults;
  const dk = getDocker();

  // `exit 3` = clean tree (nothing to commit); `exit 4` = a pre-commit config is
  // present but its hook isn't installed (its checks would be skipped); any other
  // non-zero = a hook (or git) rejected the commit. safe.directory '*' avoids
  // git's dubious-ownership guard for the bind-mounted worktree/mirror.
  const script = [
    "set -o pipefail",
    "git config --global --add safe.directory '*'",
    "cd /workspace",
    "git add -A",
    'if [ -z "$(git status --porcelain)" ]; then exit 3; fi',
    // A pre-commit config that isn't wired up would let the commit pass while
    // skipping every configured check. Fail so the repair loop tells Codex to
    // `pre-commit install`; then make the CLI the hook calls available here.
    "if [ -f .pre-commit-config.yaml ] || [ -f .pre-commit-config.yml ]; then",
    '  hook="$(git rev-parse --git-path hooks/pre-commit)";',
    '  if ! grep -qi pre-commit "$hook" 2>/dev/null; then',
    '    { echo "This repository has a .pre-commit-config.yaml but its pre-commit git hook is not installed, so its checks would be skipped."; echo "Install and wire it up: pip install pre-commit && pre-commit install"; } > /run-output/HOOKS.log;',
    "    exit 4;",
    "  fi;",
    "  command -v pre-commit >/dev/null 2>&1 || python -m pip install --break-system-packages --quiet pre-commit >/dev/null 2>&1 || true;",
    "fi",
    'git -c user.name="$GIT_COMMITTER_NAME" -c user.email="$GIT_COMMITTER_EMAIL"' +
      " commit -F /run-output/COMMIT_MSG.txt > /run-output/HOOKS.log 2>&1",
  ].join("\n");

  const image = runnerImage();
  await ensureImage(dk, image);

  const created = await dk.createContainer({
    Image: image,
    name: opts.name,
    WorkingDir: "/workspace",
    Env: [
      `GIT_COMMITTER_NAME=${env.github.committerName}`,
      `GIT_COMMITTER_EMAIL=${env.github.committerEmail}`,
    ],
    Cmd: ["bash", "-lc", script],
    HostConfig: {
      Binds: [
        `${opts.worktreePath}:/workspace:rw`,
        `${opts.runOutputDir}:/run-output:rw`,
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

  let exitCode: number;
  const wallClock = defaults.timeouts.task_wall_clock_sec;
  const timeout = setTimeout(() => void killContainer(opts.name), wallClock * 1000);
  try {
    await created.start();
    const res = (await created.wait()) as { StatusCode: number };
    exitCode = res.StatusCode;
  } finally {
    clearTimeout(timeout);
    await created.remove({ force: true }).catch((err) => {
      logger.warn({ err, name: opts.name }, "commit container remove failed");
    });
  }

  if (exitCode === 3) return { status: "nothing", exitCode, hookOutput: "" };
  if (exitCode === 0) return { status: "committed", exitCode, hookOutput: "" };
  const hookOutput = await readFile(join(opts.runOutputDir, "HOOKS.log"), "utf8").catch(
    () => "",
  );
  return { status: "hook_failed", exitCode, hookOutput };
}

export async function killContainer(name: string): Promise<void> {
  try {
    await getDocker().getContainer(name).kill();
  } catch {
    /* already gone */
  }
}
