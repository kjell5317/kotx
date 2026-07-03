# kotx — personal concurrent Codex agent

A private coding agent that reacts to GitHub activity on issues/PRs that involve
you, runs Codex in isolated Docker containers on your own Docker host, and acts
**as you** (commits, pushes, comments). It is **headless** — it exposes a
Bearer-protected JSON API for an external frontend to drive. It never opens PRs
or merges without human confirmation, and never deploys.

See [SPEC.md](SPEC.md) for the full design and the decisions behind it.

## The three workflows

1. **Task** — an issue is assigned to you, or someone comments / reviews on an
   issue or PR you're assigned to. kotx runs a read-only **draft** pass (Codex
   inspects the repo) and produces a `TASK.md` brief + plan. You review it in the
   frontend and **start** it; only then does Codex implement, push the branch, and
   post a summary comment. First drafts use the issue/PR body and discussion;
   follow-up drafts revise the reviewed `TASK.md` from the prior run using the
   latest triggering comment or review as the new input.
2. **Conflict** — a PR assigned to you, or a PR already tracked as in review,
   becomes unmergeable. Codex resolves the conflicts automatically (no
   approval), pushes the merge, and marks that conflict task done. Tracked
   in-review PRs are rechecked periodically, so a later conflict can enqueue a
   fresh resolve task after an earlier one has finished.
3. **Review** — your review is requested on a PR (or such a PR gets new commits).
   Codex does a **read-only** review and writes `REVIEW.md`. You approve it in the
   frontend; only then is it posted as a PR review/comment and marked done.
   Separately, an approving review on a PR assigned to you creates a merge
   confirmation for the existing in-review task.

There are **no labels and no `/agent` commands** — triggers are plain GitHub
webhook events (or polling for repos without webhook rights).

## Layout

```text
config/        operator-owned config (*.example.yml templates → copy to defaults.yml/repos.yml) — never read from target repos
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
| `POST /api/runs` | manually enqueue `implement`, `review`, or `resolve` for an existing GitHub issue/PR number, or create and assign a new issue when no number is supplied. `repo` accepts full names plus the per-repo `aliases` from `config/repos.yml` |
| `GET /api/repos` | the enabled repo allowlist (`fullName`, `aliases`, `assignee`, `mergeMethod`) |
| `GET /api/tasks?scope=active\|all` | tasks where you're assignee or reviewer, with `status` (e.g. *awaiting approval*, *in review*) |
| `GET /api/tasks?updatedSince=<ISO>` | every task (terminal included) updated at/after the timestamp — reconciliation for missed webhooks |
| `GET /api/tasks/:id` | one task |
| `GET /api/tasks/:id/task` | the `TASK.md` brief |
| `PUT /api/tasks/:id/task` | edit the brief before starting (draft state only) |
| `POST /api/tasks/:id/start` | start the implementation (Branch 1, draft → queued) |
| `GET /api/tasks/:id/review` | the `REVIEW.md` |
| `GET /api/tasks/:id/merge/context` | the pending merge proposal, when a tracked PR was approved |
| `POST /api/tasks/:id/approve` | approve the current proposal: submit review, open PR, or merge tracked PR |
| `POST /api/tasks/:id/merge` | confirm a tracked PR merge proposal |
| `POST /api/tasks/:id/discard` | dismiss or cancel a non-terminal task |

The document endpoints (`…/task`, `…/review`, `…/pr`) stay readable after a
task is terminal, so an external frontend can index them for search. With
`WEBHOOK_URL`/`WEBHOOK_SECRET` set, every task state change is also pushed as an
HMAC-signed `task.state_changed` webhook carrying the full task object — see
[API.md](API.md).

## Setup

Prerequisites:

- Node 20+ and npm
- Docker Engine with Compose
- GitHub CLI or a browser for creating a fine-grained personal access token
- Codex CLI installed on the host that runs the worker
- A GitHub repository under your control for publishing the two container images

Auth uses your **personal account** via a PAT. Prefer a fine-grained PAT scoped
only to the repos in `config/repos.yml` with Contents, Issues, and Pull requests
read/write plus Metadata read. The agent commits, pushes, and comments **as
you**. This is a personal tool, not a multi-tenant service or production-hardened
automation platform.

```bash
cp .env.example .env
# fill required values in .env
cp config/repos.example.yml config/repos.yml
cp config/defaults.example.yml config/defaults.yml
# edit config/repos.yml to allowlist your repo and set assignee_login to your login

npm install
npm run build
npm run typecheck             # whole-workspace type check

# Codex auth, once, on the host that runs the worker.
# Use the same path you put in .env as CODEX_HOME.
export CODEX_HOME=/srv/agent/codex-home
codex login --device-auth
```

Build and publish your own images before starting Compose:

```bash
# Option A: let GitHub Actions publish ghcr.io/<owner>/kotx-app and
# ghcr.io/<owner>/kotx-runner from your fork.

# Option B: build and push manually.
docker build -t ghcr.io/<owner>/kotx-app:latest .
docker build -t ghcr.io/<owner>/kotx-runner:latest runner
docker push ghcr.io/<owner>/kotx-app:latest
docker push ghcr.io/<owner>/kotx-runner:latest
```

Set `KOTX_IMAGE` and `CODEX_RUNNER_IMAGE` in `.env` to those image refs. If the
GHCR packages are private, run `docker login ghcr.io` on the host for Compose and
set `GHCR_USERNAME`/`GHCR_TOKEN` so the worker can pull the runner image.

For webhook mode, add a per-repo webhook in GitHub repo Settings -> Webhooks:

- Payload URL: `$PUBLIC_BASE_URL/github/webhook`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Events: `issues`, `pull_request`, `pull_request_review`, `issue_comment`, `pull_request_review_comment`, and `push`

For repos where you cannot add webhooks, set `poll: true` in `config/repos.yml`.
Webhook-only repos still run a lightweight reconciler that catches missed PR
lifecycle events and periodically rechecks tracked in-review PRs for conflicts.

Start the services:

```bash
# the `migrate` service applies pending DB migrations automatically before
# app/worker start — no manual migrate step needed.
docker compose pull
docker compose up -d
```

## Configuration

The repo ships `config/repos.example.yml` and `config/defaults.example.yml` as
templates; copy each to its non-`example` name (the app reads `config/repos.yml`
and `config/defaults.yml` at runtime). The live files are gitignored so your
allowlist and tuning never get committed. Set your allowlist + `assignee_login`
in `config/repos.yml` before running — a repo absent from it, or present with
`enabled: false`, is ignored.

`config/defaults.yml` also controls Codex runtime options. Set
`codex.web_search` to `disabled`, `cached`, or `live`; `live` lets Codex use its
web search capability to retrieve current external documentation when a task
needs it. This is separate from command network access inside the runner
container and does not expose GitHub credentials to Codex. Web results should be
treated as untrusted input.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE` | Personal access token used for GitHub REST plus git fetch/push |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret shared with each GitHub webhook |
| `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | Commit identity used by the worker |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `KOTX_IMAGE` | Your published app/worker image |
| `CODEX_RUNNER_IMAGE` | Your published runner image |

Common optional environment variables:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | Public URL used for webhooks and links; defaults to localhost in code |
| `PORT`, `HOST` | Fastify bind settings |
| `AGENT_DATA_DIR` | Host data directory for mirrors, worktrees, runs, and task artifacts |
| `CODEX_HOME` | Host Codex auth/config directory seeded by `codex login --device-auth` |
| `CONFIG_DIR` | Directory containing `defaults.yml` and `repos.yml` |
| `API_TOKEN` | Bearer token enabling `/api/*`; unset disables the API with `503` |
| `CORS_ORIGIN` | Browser frontend origin allowed by CORS |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | Outbound state-transition webhook target and its HMAC signing secret; unset URL disables webhooks |
| `GHCR_USERNAME`, `GHCR_TOKEN` | Credentials for worker pulls of private GHCR runner images |
| `POLL_INTERVAL_SEC` | Polling cadence for repos with `poll: true` |
| `HA_BASE_URL`, `HA_TOKEN`, `HA_NOTIFY_SERVICE` | Optional Home Assistant notification integration; all three are required to enable it |
| `LOG_LEVEL` | Pino log level |

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

## Security Notes

- Keep `.env` and the live `config/*.yml` out of git. Only the `.env.example` /
  `config/*.example.yml` templates (placeholders only) are committed.
- Use a fine-grained PAT scoped to the smallest set of allowlisted repositories.
  Rotate any token that was ever committed, pasted into an issue, or shared.
- `GITHUB_WEBHOOK_SECRET`, `API_TOKEN`, `GHCR_TOKEN`, and `HA_TOKEN` are secrets.
  Generate high-entropy values and do not reuse them.
- The sample Postgres password `kotx` is for local defaults only. Change
  `POSTGRES_PASSWORD` and `DATABASE_URL` before any exposed deployment.
- The app and worker mount the host Docker socket. Treat API access and host
  access as sensitive; this is intended for a single trusted operator.
- If GHCR packages are private, both the host Docker daemon and the worker need
  read access. If they are public, do not set unnecessary package tokens.
- Review `config/repos.yml`, `Caddyfile`, `.env`, and any deployment-specific
  docs for personal domains, repository names, usernames, and host paths before
  publishing a fork.
