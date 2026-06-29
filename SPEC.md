# kotx — Personal Codex Agent (as-built spec)

Status: v2 · This describes the system **as built and deployed**, which has
diverged substantially from the original design (GitHub App + HITL + PR
opening). The original design notes are summarized in §13 (Changelog) for
context. For how to run it, see [README.md](README.md).

---

## 1. What's working

Verified end-to-end on `TUM-Social-AI/AflaConnect` during bring-up:

- **Ingestion → queue → worker.** Webhook receiver verifies the HMAC signature,
  de-dupes deliveries, checks eligibility, creates a task, and enqueues it.
  Tasks flow `queued → running → done/failed`.
- **GitHub auth via PAT.** All REST + git-over-HTTPS uses a personal access
  token; the agent acts as the user (commits, pushes, comments are yours).
- **Per-repo locking + worktrees.** The worker takes a Redis repo lock, fetches
  the bare mirror, and creates an isolated git worktree. Branch creation is
  idempotent across retries (`git worktree add -B`).
- **Codex actually runs.** Inside the runner container Codex authenticates,
  resolves git, has network + root, and `node`/`python`/`uv` available; it
  inspects the repo, makes changes, and writes a summary (`AGENT_RESULT.md`) and
  commit message (`COMMIT_MSG.md`).
- **CI images + auto-migrate.** GitHub Actions builds and pushes `kotx-app` and
  `kotx-runner` to GHCR; compose runs a one-shot `migrate` service before
  app/worker start.

**Pending verification** (implemented, not yet confirmed live):

- The tail of the issue happy path — worker **commits, pushes the branch, and
  posts the summary comment** (no PR). Should work; confirm on a real issue.
- The **PR path** (push to the PR's head branch). The code is in place but the
  last live run hit a stale worker image; re-verify after redeploying the worker.
- **Polling mode** end-to-end on a `poll: true` repo.

---

## 2. Next steps

Ordered roughly by priority:

1. **Confirm the issue happy path** (commit → push `<n>-<slug>` → summary
   comment) and the **PR path** (push to PR head) on freshly-deployed images.
2. **Egress policy.** Today the runner uses the default `bridge` network (open
   egress) — required because Codex installs dependencies at runtime. If you
   later want to restrict egress, you must either bake all deps into the runner
   image or run a per-project setup step. Tracked but intentionally open.
3. **Poll comment cursor persistence.** The poller's "comments since" cursor is
   in-memory with a 1h startup lookback; comments during a >1h outage can be
   missed (labels can't be — they're level-triggered). Persist the cursor in a
   small table to close the gap.
4. **Per-repo concurrency > 1.** The repo lock is a single slot
   (`max_workers_per_repo` effectively 1). Use N lock slots if you want parallel
   tasks per repo.
5. **Re-run / force-push edge case.** Re-running implement on an issue whose
   branch already exists resets the local branch to base (`-B`) and publishes
   with `--force-with-lease` on worker-owned issue branches. PR-review pushes
   stay normal fast-forward pushes so user-owned branch updates are not
   overwritten.
6. **Toolchain coverage.** Runner has Node + Python + uv. Codex `apt-get`s the
   rest at runtime; bake in more (e.g. `build-essential`, Go, Rust) if common.
7. **Observability / retention.** Run logs (`/srv/agent/runs/<id>/codex.jsonl`)
   and worktrees accumulate; add retention/cleanup and basic metrics.
8. **Token refresh.** Each run gets a private **writable** `CODEX_HOME` copy, so
   Codex can refresh an expiring token mid-run. Long-idle hosts may still want a
   host-side pre-refresh (`CODEX_REFRESH_CMD`, already wired, currently unset).

---

## 3. Goal

A private coding agent that reacts to GitHub issues/PRs assigned to me, runs
Codex in isolated Docker containers on a Hetzner VPS, and **pushes branches +
posts plain summaries as me**. It never opens PRs, never merges, never deploys,
and nothing it writes should read as machine-authored.

---

## 4. Architecture

```text
GitHub issue/PR  ──(webhook)──┐
   assigned to me             │        ┌── app: Fastify receiver + ingestion
   + label / /agent command   ├──────▶ │   (also: poller for poll:true repos)
                              ─┘        └── enqueue (Redis/BullMQ)
                                                    │
                                                    ▼
                                         worker: one job at a time per repo
                                          ├─ git worktree (host-side)
                                          ├─ run codex-runner container
                                          ├─ commit + push branch
                                          └─ post summary comment
```

Services (Docker Compose, all from CI-built GHCR images):

```text
proxy     Caddy (TLS, reverse proxy to app) — only needed for webhook repos
app       webhook receiver + poller; enqueues jobs
worker    BullMQ consumer; orchestrates git + Docker + Codex; posts to GitHub
migrate   one-shot node-pg-migrate before app/worker start
postgres  task state
redis     job queue + locks/flags
codex-runner   short-lived per-task container (launched by worker via the socket)
```

`app` and `worker` share one image (`kotx-app`). The worker launches
`kotx-runner` containers via the Docker socket (mounted into the worker only).

---

## 5. GitHub integration

### 5.1 Auth — personal access token
A PAT (prefer fine-grained, scoped to the allowlisted repos: Contents, Issues,
Pull requests r/w + Metadata) is used for both the REST API and git push/fetch.
The agent therefore acts as **me**. No GitHub App, no installation tokens.

### 5.2 Two input modes (per repo)
- **Webhook** (`poll: false`): a repo webhook → `/github/webhook`, HMAC-verified.
- **Polling** (`poll: true`): the app polls the repo every `POLL_INTERVAL_SEC`
  for trigger labels and `/agent` commands — for repos where I can't register a
  webhook. To avoid level-triggered re-firing, the **trigger label is removed
  once a task is enqueued**; re-add it to run again. Comments are de-duped by id.

### 5.3 Triggers and commands
Trigger labels (added by me): `agent:ready` (issue → implement),
`agent:review` (PR → work on the PR), `agent:ignore` (suppress).

Commands (comment, **only honored from the repo's `assignee_login`**):

```text
/agent run      start work on the issue
/agent review   work on the PR
/agent stop     cancel the active task
/agent status   report state
```

(`approve`/`reject` were removed with HITL.) Webhook label triggering fires only
on the `labeled` action; comment events trigger only via an explicit command —
this prevents the agent's own comments (posted as me) from re-triggering runs.

### 5.4 Eligibility
A task is eligible when: repo is allowlisted + enabled; no `agent:ignore`; the
issue/PR is **open and assigned to `assignee_login`**; a trigger label/command is
present; and no active task already exists for that subject.

---

## 6. Behavior model (the core change)

**No HITL, no PRs.** The agent does whatever it needs inside the container, then:

- **Issue** (`implement`): work on a fresh branch named GitHub-style
  `<number>-<slugified-title>` (e.g. `31-add-metadata-index`) off the default
  branch → commit → **push the branch** → comment a summary on the issue ending
  with “Changes pushed to `<branch>`.” **No PR is opened.**
- **PR** (`review`): check out the PR's **own head branch**, make changes →
  commit → **push back to that branch** (updating the PR) → comment a summary.
  Fork PRs are detected and skipped (can't push to a fork's branch).

The summary is exactly what Codex wrote to `AGENT_RESULT.md`; the prompts
instruct it to write in plain developer voice and **never** mention being an AI,
agent, assistant, or automation. No `🤖`, no "generated by" footer. Commits and
comments are authored as me.

---

## 7. Data model (PostgreSQL)

```text
tasks         one unit of work per (repo, subject); partial unique index
              enforces ≤1 active task per subject
task_runs     one attempt per task (worktree path, container, outcome, logs)
github_deliveries   webhook + poll-comment idempotency (delivery/comment ids)
```

`hitl_requests` and the `hitl_state` enum were **dropped** (migration
`1700000001000_drop_hitl.sql`). The unused enum *values* `awaiting_approval`
(task_state) / `needs_approval` (run_outcome) are left in place (dropping enum
values is invasive and they're inert).

Task states in use: `queued → running → done | failed | cancelled | timed_out`.

---

## 8. Worktree / git strategy (worker-owned)

All git runs on the host (worker), never with credentials inside the runner.

- One bare mirror per repo at `/srv/agent/repos/OWNER__REPO.git`, fetched with
  refspecs into `refs/remotes/origin/*` so `--prune` can't delete agent
  branches.
- Per-run worktree at `/srv/agent/worktrees/<run_id>`, created with
  `git worktree add -B <branch> <path> <start-ref>` (idempotent across retries).
  - implement: branch = `<n>-<slug>`, start = `refs/remotes/origin/<default>`.
  - review: branch = the PR head ref, start = `refs/remotes/origin/<head>`.
- The worker commits (with my identity, message from `COMMIT_MSG.md`) and pushes
  over an ephemeral `https://oauth2:<PAT>@github.com/...` remote.
- The bare mirror is **bind-mounted into the runner at the same host path** so
  the worktree's `.git` gitfile resolves and git works inside the container.

---

## 9. Codex execution

Per task the worker launches a short-lived container:

```bash
docker run --rm --cpus=2 --memory=4g \
  --cap-drop ALL --security-opt no-new-privileges \
  -v <worktree>:/workspace:rw \
  -v <run-dir>/codex-home:/home/codex/.codex:rw \   # private per-run copy of auth
  -v <run-dir>:/run-output:rw \
  -v <mirror>:<mirror>:rw \                          # so git resolves
  -e CODEX_HOME=/home/codex/.codex \
  kotx-runner \
  bash -lc 'codex exec --json --ephemeral \
            --dangerously-bypass-approvals-and-sandbox - \
            < /run-output/TASK.md > /run-output/codex.jsonl 2>&1'
```

Key decisions, all forced by reality during bring-up:

- **The container is the sandbox.** Codex's own bwrap sandbox can't create a user
  namespace inside the (capability-dropped) container, so we
  `--dangerously-bypass-approvals-and-sandbox` and rely on the container for
  isolation: caps dropped, no-new-privileges, **no Docker socket**, no host
  creds, only the four mounts above. Consequence: Codex's shell has network
  (bridge) and runs as root — which is what lets it install deps.
- **Writable per-run `CODEX_HOME`.** Codex must write to `CODEX_HOME` at startup
  (app-server, PATH aliases) and to refresh tokens, so each run gets its own
  copy of `auth.json`/`config.toml` mounted rw (no cross-run races).
- **`--ephemeral`** so session files aren't persisted.
- **Toolchain in `kotx-runner`:** Node 20 + npm (base), Python 3 + pip + venv +
  `python-is-python3`, and `uv`. Codex installs anything else at runtime
  (`uv`/`pip`/`npm`/`apt-get`).
- Runner runs as **root** (so it can write the root-owned worktree/run mounts and
  read the auth). Verified Codex flags against `codex exec --help` 0.142.4.

Outcome classification (output files are authoritative; exit code breaks ties):
`AGENT_RESULT.md` present + exit 0 → `completed`; cancel/timeout kills →
`cancelled`/`timed_out`; else `failed`.

---

## 10. Deployment (Hetzner + Docker + CI)

- Single VPS (Ubuntu), Docker + Compose. Codex CLI logged in **on the host**
  once; auth copied/seeded into `CODEX_HOME`, then copied per-run into runners.
- **CI** (`.github/workflows/build-images.yml`) builds + pushes `kotx-app` and
  `kotx-runner` to GHCR on push to `main` / `v*` tags. `kotx-runner` pins the
  Codex CLI version and `uv` version.
- Compose pulls `kotx-app` for app/worker; the worker **auto-pulls
  `kotx-runner`** if missing (won't replace an existing `:latest` — `docker pull`
  to refresh after a new build).
- `config/` and `prompts/` are bind-mounted from the cloned repo, so editing
  `repos.yml` or prompts needs only a `docker compose up -d` (restart the worker
  to clear its compiled-prompt cache), not an image rebuild.
- **Migrations are NOT in image-build CI** (it can't reach the VPS DB). The
  `migrate` compose service applies them on every deploy, before app/worker.

---

## 11. Configuration

- `config/defaults.yml` — concurrency, timeouts, container limits, codex flags
  (`approval_policy` retained but the runner currently bypasses sandbox/approval).
- `config/repos.yml` — operator-owned allowlist; per repo: `enabled`,
  `default_branch`, `assignee_login`, `poll`. Never read from a target repo.
- `.env` — PAT, webhook secret, commit identity, image refs, GHCR pull creds,
  paths, poll interval. The `allow_infra_changes`/`allow_secret_access` flags
  exist in schema but are **not enforced** (HITL gating was removed); treat as
  documentation only.

---

## 12. Security model

- The runner is the isolation boundary: dropped caps, no-new-privileges, no
  Docker socket, no host creds, only worktree + per-run auth + run-dir + mirror
  mounted; destroyed after each task.
- Git creds never enter the runner — the worker pushes from the host with an
  ephemeral tokenized remote.
- PAT should be fine-grained and scoped to the allowlisted repos (a classic
  `repo` token can reach all your repos; the allowlist only gates *behavior*).
- Invariants: never opens PRs, never merges, never deploys, never force-pushes
  without intent. Open trade-off: bypassing Codex's sandbox means its shell has
  network + root *inside the container* (see §2.2).

---

## 13. Changelog vs the original design

| Area | Original | Now |
|------|----------|-----|
| GitHub auth | private GitHub App + installation tokens | personal PAT (acts as me) |
| Input | webhooks only | webhooks **and** per-repo polling |
| HITL | stop + `HITL_REQUEST.json` + approve/reject + resume | **removed**; agent runs autonomously |
| Output | open/update PR + structured review | push branch + plain summary comment; **no PR** |
| Review mode | read-only review comment | **work on the PR's branch** + push |
| Branch | `agent/issue-N` | GitHub-style `<n>-<slug>` (issues); PR head (PRs) |
| Voice | `🤖`/"generated by agent" | plain, never identifies as an agent |
| Codex sandbox | `--sandbox workspace-write` + approval policy | `--dangerously-bypass-approvals-and-sandbox` (container is the sandbox) |
| CODEX_HOME | read-only shared mount | private writable per-run copy |
| Runner image | Node only | Node + Python + uv; runs as root; pulls more at runtime |
| Images | built on the VPS | CI → GHCR; compose pulls; auto-migrate |
| Commands | run/review/stop/status/approve/reject | run/review/stop/status |
```
