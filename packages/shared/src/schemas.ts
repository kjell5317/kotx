import { z } from "zod";

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
  container: z.object({
    cpus: z.number().positive(),
    memory: z.string(),
    image: z.string(),
    network: z.string(),
  }),
  codex: z.object({
    sandbox: z.string(),
    // maps to `-c approval_policy=<value>`; values: untrusted|on-failure|on-request|never
    approval_policy: z.string(),
    auth_refresh_skew_sec: z.number().int().nonnegative(),
  }),
  policy: z.object({
    // auto_merge / auto_deploy are invariants — must be false if present.
    auto_merge: z.literal(false).default(false),
    auto_deploy: z.literal(false).default(false),
    require_label_or_command: z.boolean(),
  }),
});
export type Defaults = z.infer<typeof defaultsSchema>;

// ── Config: repos.yml (SPEC §3.2) ───────────────────────────────────────────
export const repoConfigSchema = z.object({
  full_name: z.string(),
  enabled: z.boolean(),
  default_branch: z.string().default("main"),
  assignee_login: z.string(),
  allow_infra_changes: z.boolean().default(false),
  allow_secret_access: z.boolean().default(false),
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

// ── Codex output: HITL_REQUEST.json (SPEC §11.1) ────────────────────────────
export const hitlRequestSchema = z.object({
  reason: z.string().min(1),
  proposed_action: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
  alternatives: z.array(z.string()).default([]),
});
export type HitlRequestPayload = z.infer<typeof hitlRequestSchema>;
