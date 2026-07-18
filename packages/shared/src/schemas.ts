import { z } from "zod";

export const pullRequestMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = z.infer<typeof pullRequestMergeMethodSchema>;

// ── Config: defaults.yml (SPEC §3.1) ────────────────────────────────────────
export const defaultsSchema = z.object({
  concurrency: z.object({
    max_global_workers: z.number().int().positive(),
    max_workers_per_repo: z.number().int().positive(),
  }),
  timeouts: z.object({
    task_wall_clock_sec: z.number().int().positive(),
    awaiting_approval_ttl_sec: z.number().int().positive(),
    repo_lock_buffer_sec: z.number().int().nonnegative(),
  }),
  garbage_collection: z.object({
    enabled: z.boolean().default(true),
    run_retention_sec: z.number().int().nonnegative(),
    sweep_interval_sec: z.number().int().positive(),
    max_retained_run_bytes: z.number().int().positive().nullable().default(null),
  }),
  container: z.object({
    cpus: z.number().positive(),
    memory: z.string(),
    image: z.string(),
    network: z.string(),
    // When true, each run gets a throwaway privileged docker:dind sidecar on a
    // private per-run network; the (still hardened) runner talks to it via
    // DOCKER_HOST so Codex can spin up test containers. Killing the sidecar at
    // run end destroys every nested container — automatic cleanup.
    dev_containers: z.boolean().default(false),
    dind_image: z.string().default("docker:27-dind"),
  }),
  codex: z.object({
    sandbox: z.string(),
    // maps to `-c approval_policy=<value>`; values: untrusted|on-failure|on-request|never
    approval_policy: z.string(),
    auth_refresh_skew_sec: z.number().int().nonnegative(),
    // maps to `-c model=<value>`. Omit to use the config.toml default.
    model: z.string().optional(),
    // maps to `-c model_reasoning_effort=<value>` (requires a reasoning model).
    // Omit to use the model/config.toml default.
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    // maps to `-c web_search=<value>`; live lets Codex retrieve current web docs.
    web_search: z.enum(["disabled", "cached", "live"]).default("disabled"),
  }),
  policy: z.object({
    // auto_merge / auto_deploy are invariants — must be false if present.
    auto_merge: z.literal(false).default(false),
    auto_deploy: z.literal(false).default(false),
  }),
});
export type Defaults = z.infer<typeof defaultsSchema>;

// ── Config: repos.yml (SPEC §3.2) ───────────────────────────────────────────
export const repoConfigSchema = z.object({
  full_name: z.string(),
  enabled: z.boolean(),
  default_branch: z.string().default("main"),
  assignee_login: z.string(),
  // Friendly names accepted by POST /api/runs `repo` and surfaced by
  // GET /api/repos so clients can route without hardcoding them.
  aliases: z.array(z.string()).default([]),
  merge_method: pullRequestMergeMethodSchema.default("squash"),
  // true = poll this repo (no webhook rights); false = rely on webhooks.
  // The poller diffs GitHub state against existing tasks to find new triggers
  // (assignments, review requests, conflicts) — no labels or commands involved.
  poll: z.boolean().default(false),
  overrides: z
    .object({
      max_workers_per_repo: z.number().int().positive().optional(),
    })
    .default({}),
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const reposFileSchema = z.object({
  repos: z.array(repoConfigSchema),
});
