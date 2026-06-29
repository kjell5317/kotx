# kotx — personal concurrent Codex agent

A private coding agent that reacts to GitHub issues/PRs assigned to you, runs
Codex in isolated Docker containers on a Hetzner VPS, opens PRs, reviews PRs, and
asks for human approval before risky actions. It **never merges or deploys**.

See [SPEC.md](SPEC.md) for the full design and the decisions behind it.

## Layout

```
config/        operator-owned config (defaults.yml, repos.yml) — never read from target repos
migrations/    Postgres schema (node-pg-migrate)
packages/
  shared/      types, zod schemas, config, db, github, queue, intent parsing
  app/         Fastify webhook receiver + ingestion pipeline (§6)
  worker/      orchestrator: git, dockerode, codex runner, classify, GitHub outputs, HITL
prompts/       TASK.md templates (implement / review / resume)
runner/        codex-runner image (holds no credentials)
Dockerfile     builds app + worker
docker-compose.yml
```

## How it flows

1. You assign an issue/PR to yourself and add `agent:ready` / `agent:review`, or
   comment `/agent run` / `/agent review`.
2. `app` verifies the webhook, checks eligibility, creates a task, enqueues it.
3. `worker` acquires a per-repo lock, builds an isolated git worktree, renders
   `TASK.md`, and runs Codex in a short-lived `codex-runner` container.
4. Codex edits files and writes `AGENT_RESULT.md` (+ `COMMIT_MSG.md`), or writes
   `HITL_REQUEST.json` and stops if it hits a risky action.
5. The worker commits + pushes + opens a PR (implement), posts a review comment
   (review), or posts an approval request (HITL). GitHub CI validates; you merge.

Commands (only honored from the repo's `assignee_login`):
`/agent run · review · stop · status · approve · reject`.

## Local / first run

> Requires Node 20+, Docker, and a GitHub personal access token.
>
> Auth uses your **personal account** via a PAT (prefer a fine-grained PAT
> scoped to the allowlisted repos: Contents + Issues + Pull requests r/w). The
> agent commits, opens PRs, and comments **as you**. For webhooks, add a
> per-repo webhook (repo Settings → Webhooks) pointing at
> `$PUBLIC_BASE_URL/github/webhook`, content type `application/json`, with the
> same `GITHUB_WEBHOOK_SECRET`, sending issues / pull_request / issue_comment /
> pull_request_review_comment events.

```bash
cp .env.example .env          # fill in GITHUB_TOKEN, webhook secret, commit identity
# edit config/repos.yml to allowlist your repo + set assignee_login (your login)

npm install
npm run build
npm run typecheck             # whole-workspace type check

# Codex auth, once, on the host that runs the worker:
export CODEX_HOME=/srv/agent/codex-home
codex login --device-auth

# bring up postgres/redis/app/worker/proxy
docker compose up -d --build
docker compose run --rm app node node_modules/.bin/node-pg-migrate up   # or run migrations from host

# build the runner image the worker launches
docker build -t codex-runner:latest runner/
```

## Status vs SPEC

Implements M1–M4 (webhook receiver, single worker, concurrency + locking +
cancel + timeout, HITL approve/reject/TTL-expiry). M5 hardening (log retention,
egress lockdown, richer observability) is left as follow-up. Two items still
need on-VPS verification, per SPEC §16 Q6:

- the exact `codex exec` flags / prompt-input form (pinned in `runner/Dockerfile`);
- the `CODEX_HOME/auth.json` shape and the host refresh command
  (`CODEX_REFRESH_CMD`), used by the auth pre-flight.
