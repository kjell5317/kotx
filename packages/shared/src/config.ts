import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  defaultsSchema,
  reposFileSchema,
  type Defaults,
  type RepoConfig,
} from "./schemas.js";

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Missing env var: ${name}`);
  return v;
}

function readToken(): string {
  const inline = process.env.GITHUB_TOKEN;
  if (inline && inline.trim() !== "") return inline.trim();
  const file = process.env.GITHUB_TOKEN_FILE;
  if (file && file.trim() !== "") return readFileSync(file, "utf8").trim();
  throw new Error("Missing GITHUB_TOKEN or GITHUB_TOKEN_FILE");
}

export interface Env {
  port: number;
  host: string;
  publicBaseUrl: string;
  github: {
    // Personal access token (prefer a fine-grained PAT scoped to the
    // allowlisted repos). Used for both the REST API and git-over-HTTPS.
    token: string;
    webhookSecret: string;
    // git commit identity — your own name/email (the agent acts as you).
    committerName: string;
    committerEmail: string;
  };
  databaseUrl: string;
  redisUrl: string;
  agentDataDir: string;
  codexHome: string;
  configDir: string;
  // Bearer token gating the JSON API consumed by the external frontend. Unset =
  // API disabled (endpoints return 503).
  apiToken?: string;
  // Allowed CORS origin for the external frontend (e.g. https://app.example.com).
  // Unset = no CORS headers (same-origin / non-browser clients only).
  corsOrigin?: string;
}

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    github: {
      token: readToken(),
      webhookSecret: req("GITHUB_WEBHOOK_SECRET"),
      committerName: req("GIT_COMMITTER_NAME"),
      committerEmail: req("GIT_COMMITTER_EMAIL"),
    },
    databaseUrl: req("DATABASE_URL"),
    redisUrl: req("REDIS_URL"),
    agentDataDir: process.env.AGENT_DATA_DIR ?? "/srv/agent",
    codexHome: process.env.CODEX_HOME ?? "/srv/agent/codex-home",
    configDir: process.env.CONFIG_DIR ?? "./config",
    apiToken: process.env.API_TOKEN || undefined,
    corsOrigin: process.env.CORS_ORIGIN || undefined,
  };
  return cachedEnv;
}

let cachedDefaults: Defaults | undefined;
let cachedRepos: Map<string, RepoConfig> | undefined;

export function loadDefaults(configDir = loadEnv().configDir): Defaults {
  if (cachedDefaults) return cachedDefaults;
  const raw = parseYaml(readFileSync(join(configDir, "defaults.yml"), "utf8"));
  cachedDefaults = defaultsSchema.parse(raw);
  return cachedDefaults;
}

export function loadRepos(
  configDir = loadEnv().configDir,
): Map<string, RepoConfig> {
  if (cachedRepos) return cachedRepos;
  const raw = parseYaml(readFileSync(join(configDir, "repos.yml"), "utf8"));
  const parsed = reposFileSchema.parse(raw);
  cachedRepos = new Map(parsed.repos.map((r) => [r.full_name, r]));
  return cachedRepos;
}

/** Returns the repo config iff the repo is present AND enabled, else undefined. */
export function getEnabledRepo(fullName: string): RepoConfig | undefined {
  const r = loadRepos().get(fullName);
  return r && r.enabled ? r : undefined;
}

/** Effective per-repo worker cap, honoring overrides. */
export function maxWorkersForRepo(repo: RepoConfig): number {
  return (
    repo.overrides.max_workers_per_repo ??
    loadDefaults().concurrency.max_workers_per_repo
  );
}
