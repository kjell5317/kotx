# kotx — personal concurrent Codex agent

A private coding agent that reacts to GitHub activity on issues/PRs that involve
you, runs Codex in isolated Docker containers on a Hetzner VPS, and acts **as
you** (commits, pushes, comments). It is **headless** — it exposes a
Bearer-protected JSON API for an external frontend to drive. It never opens PRs
on its own, never merges, and never deploys.

See [SPEC.md](SPEC.md) for the full design and the decisions behind it.

## The three workflows

1. **Task** — an issue is assigned to you, or someone comments / reviews on an
   issue or PR you're assigned to. kotx runs a read-only **draft** pass (Codex
   inspects the repo) and produces a `TASK.md` brief + plan. You review it in the
   frontend and **start** it; only then does Codex implement, push the branch, and
   post a summary comment. The brief reads differently on a first assignment vs. a
   follow-up.
2. **Conflict** — a PR assigned to you becomes unmergeable. Codex resolves the
   conflicts automatically (no approval) and pushes the merge.
3. **Review** — your review is requested on a PR (or such a PR gets new commits).
   Codex does a **read-only** review and writes `REVIEW.md`. You approve it in the
   frontend; only then is it posted as a PR comment.

There are **no labels and no `/agent` commands** — triggers are plain GitHub
webhook events (or polling for repos without webhook rights).

## Layout

```text
config/        operator-owned config (defaults.yml, repos.yml) — never read from target repos
migrations/    Postgres schema (node-pg-migrate)
packages/
  shared/      types, zod schemas, config, db, github, queue
  app/         Fastify webhook receiver, trigger pipeline, JSON API, poller
  worker/      orchestrator: git, dockerode, codex runner, classify, GitHub outputs
prompts/       Codex prompts (draft / implement / resolve-conflict / review)
runner/        codex-runner image (holds no credentials)
Dockerfile     builds app + worker
docker-compose.yml
```

## API (consumed by your frontend)

All `/api/*` routes require `Authorization: Bearer $API_TOKEN`.

| Method & path | Purpose |
| --- | --- |
| `GET /api/tasks?scope=active\|all` | tasks where you're assignee or reviewer, with `status` (e.g. *waiting on my approval*, *waiting on external approval*) |
| `GET /api/tasks/:id` | one task |
| `GET /api/tasks/:id/task` | the `TASK.md` brief |
| `PUT /api/tasks/:id/task` | edit the brief before starting (draft state only) |
| `POST /api/tasks/:id/start` | start the implementation (Branch 1, draft → queued) |
| `GET /api/tasks/:id/review` | the `REVIEW.md` |
| `POST /api/tasks/:id/approve` | post `REVIEW.md` to the PR (Branch 3) |
| `POST /api/tasks/:id/stop` | cancel a task |
| `GET /api/containers` | live `docker ps` of the running codex runners |

## Local / first run

> Requires Node 20+, Docker, and a GitHub personal access token.
>
> Auth uses your **personal account** via a PAT (prefer a fine-grained PAT scoped
> to the allowlisted repos: Contents + Issues + Pull requests r/w + Metadata).
> The agent commits, pushes, and comments **as you**. For webhooks, add a per-repo
> webhook (repo Settings → Webhooks) pointing at `$PUBLIC_BASE_URL/github/webhook`,
> content type `application/json`, same `GITHUB_WEBHOOK_SECRET`, sending **issues,
> pull_request, pull_request_review, issue_comment, pull_request_review_comment**,
> and **push** events.

```bash
cp .env.example .env          # fill in GITHUB_TOKEN, webhook secret, commit identity, API_TOKEN
# edit config/repos.yml to allowlist your repo + set assignee_login (your login)

npm install
npm run build
npm run typecheck             # whole-workspace type check

# Codex auth, once, on the host that runs the worker:
export CODEX_HOME=/srv/agent/codex-home
codex login --device-auth

# the `migrate` service applies pending DB migrations automatically before
# app/worker start — no manual migrate step needed.
docker compose pull
docker compose up -d
```

## Images & CI

`.github/workflows/build-images.yml` builds and pushes two images to GHCR on
every push to `main` (and on `v*` tags):

- `ghcr.io/<owner>/kotx-app` — the app + worker (root `Dockerfile`)
- `ghcr.io/<owner>/kotx-runner` — the short-lived `codex-runner`

Compose pulls `kotx-app` for both the `app` and `worker` services
(`KOTX_IMAGE`). The worker pulls `kotx-runner` itself the first time it launches
a task (`CODEX_RUNNER_IMAGE`); set `GHCR_USERNAME`/`GHCR_TOKEN` (a PAT with
`read:packages`) if the packages are private. `config/` and `prompts/` are
bind-mounted from the cloned repo, so editing `repos.yml` or a prompt needs only a
`docker compose up -d` (restart the worker to clear its compiled-prompt cache),
not a rebuild.
