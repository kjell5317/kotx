# kotx — Personal Codex Agent (as-built spec)

Status: v3 · This describes the system **as built**. v3 made it **headless** (a
Bearer-protected JSON API replaced the bundled UI), replaced labels/`/agent`
commands with **three role-aware webhook workflows** (task / conflict / review),
and decoupled task creation from execution (a reviewable `TASK.md` you start from
the frontend). The v2→v3 changes are summarized in §14; older history in §13. For
how to run it, see [README.md](README.md).

## 0. The v3 workflow model

Triggers are plain GitHub events (or polling) keyed to your role on the subject
(`assignee_login` in `repos.yml`). No labels, no commands.

1. **Task (Branch 1)** — issue assigned to you, or a comment/review on an
   issue/PR you're assigned to. A read-only **draft** Codex run produces
   `TASK.md` (brief + plan) and the task waits in `draft` ("waiting on my
   approval"). You review/edit it via the API and `POST …/start`; the **execute**
   run then implements and pushes the branch. For issue work it also proposes a
   PR (title + description following the repo's PR template and `CONTRIBUTING.md`)
   and waits in `awaiting_approval`; you review/edit the proposal (`GET/PUT …/pr`)
   and `POST …/approve`, which merges the default branch into the pushed branch
   and opens the PR. The task then waits for that PR to merge or close.
2. **Conflict (Branch 2)** — a PR assigned to you is unmergeable (`mergeable_state
   = dirty`), detected on `pull_request` synchronize/open or a `push` to the
   default branch. Codex resolves the in-progress merge automatically (no
   approval) and pushes; the task waits for that PR to merge or close.
3. **Review (Branch 3)** — your review is requested on a PR, or such a PR gets new
   commits. A read-only review run writes `REVIEW.md`; the task waits in
   `awaiting_approval`. `POST …/approve` posts it as a PR comment, then the task
   waits for that PR to merge or close.

Opened/reopened PRs from pushed issue branches are recorded on the task. A
merged/closed PR closes its tracked open tasks (`done`/`cancelled`).

---

## 1. What's working

Verified during bring-up on a private allowlisted repository:

- **Ingestion → queue → worker.** Webhook receiver verifies the HMAC signature,
  de-dupes deliveries, checks eligibility, creates a task, and enqueues it.
  Tasks flow `queued → running → done/failed`.
- **GitHub auth via PAT.** All REST + git-over-HTTPS uses a personal access
  token; the agent acts as the user (commits, pushes, comments are yours).
- **Per-repo locking + worktrees.** The worker takes one of N Redis repo slots
  (`max_workers_per_repo`), fetches the bare mirror, and creates an isolated git
  worktree. Branch creation is idempotent across retries (`git worktree add -B`).
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
4. **Per-repo concurrency.** Done: a counting semaphore over N Redis slot keys
   (`acquireRepoSlot`) honors `max_workers_per_repo`. A busy repo re-enqueues the
   run with a delay and a fresh job id (re-adding the same id would be
   de-duplicated by BullMQ and dropped); slot keys carry a TTL so a crashed run
   frees its slot. (Still bounded by `max_global_workers`.)
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
Codex in isolated Docker containers on an operator-owned Docker host, and **pushes branches +
posts plain summaries as me**. It opens PRs only from an approved proposal (you
review the title/description first); it never merges, never deploys, and nothing
it writes should read as machine-authored.

---

## 4. Architecture

```text
GitHub issue/PR  ──(webhook)──┐        ┌── app: Fastify receiver + 3-branch
   assigned / review-req'd /   ├──────▶ │   ingestion + JSON API (also: poller)
   commented + push to main   ─┘        └── enqueue (Redis/BullMQ)
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
  Subscribe to **issues, pull_request, pull_request_review, issue_comment,
  pull_request_review_comment, push**.
- **Polling** (`poll: true`): the app polls every `POLL_INTERVAL_SEC` for repos
  where I can't register a webhook. It diffs GitHub state against existing tasks
  to find new assignments, review requests, conflicts, and follow-up comments —
  **no labels or commands**. Without a label to clear, assignment/review triggers
  fire at most once per subject (`hasAnyTask` guard); follow-ups arrive via the
  comment cursor (de-duped by comment id); conflict checks self-limit (only fire
  when the PR is dirty and has no active task).

### 5.3 Triggers (no labels, no commands)
All labels (`agent:*`) and `/agent` commands were **removed** in v3. Triggers are
the three role-aware workflows in §0, driven by webhook events:

- `issues` assigned / `issue_comment` / `pull_request_review[_comment]` on a
  subject I'm assigned to → Branch 1 (draft). My own comments are ignored (the
  agent comments as me — this prevents a self-loop).
- `pull_request` review_requested (me) / synchronize while my review is requested
  → Branch 3.
- `pull_request` synchronize/open + `push` to the default branch, for PRs assigned
  to me → Branch 2 (only when `mergeable_state = dirty`).
- `pull_request` opened/reopened from a pushed issue branch → record the PR and
  show the task as in review.
- `pull_request` closed → close tracked open tasks as `done` when merged or
  `cancelled` with a reason when closed unmerged.
- Polling performs the same PR-open and PR-closed reconciliation, so lifecycle
  state does not depend on receiving every webhook.

### 5.4 Eligibility
Repo allowlisted + enabled; subject open; my role on the subject matches the
branch (assignee for Branch 1/2, requested reviewer for Branch 3); and at most one
**active** task per subject (the partial unique index — `awaiting_external` and
terminal states don't count, so a follow-up can open a new task).

---

## 6. Behavior model

Kinds (`task_kind`): `implement` (Branch 1, two phases — `draft` then `execute`),
`resolve_conflict` (Branch 2), `review` (Branch 3, read-only). Behavior is decided
by the **subject + kind/phase**, not how it was triggered. Each run pipes
`PROMPT.md` (rendered by the worker) into Codex; the durable artifacts the
frontend reads (`TASK.md`, `REVIEW.md`) live in a per-task dir so they survive a
draft refresh, the execute run, and human edits.

- **draft** (read-only): inspect the repo + issue/PR/discussion → write
  `/workspace/TASK.md` (goal · context · plan). Saved to the task dir; state →
  `draft`. Never commits. First-assignment vs. follow-up tone via an `isFollowUp`
  flag (a re-triggered draft is attempt > 1).
- **implement/execute**: pipe the approved (possibly edited) `TASK.md` as the
  brief → merge the default branch in → Codex implements → commit + push the
  branch → comment the `AGENT_RESULT.md` summary. Issue branch is GitHub-style
  `<n>-<slug>` off default; PR follow-up uses the PR's own head branch. Issue
  work moves to `awaiting_external` as "waiting on PR" until a PR is opened from
  that branch to the default branch, then "in review" until merge/close.
- **resolve_conflict**: merge the default branch (leaving conflicts), Codex
  resolves them, commit the merge + push → `awaiting_external` ("in review").
  Conflict-marker safety net before commit.
- **review** (read-only): write `/workspace/REVIEW.md` as a ready-to-post PR
  comment; saved to the task dir; state → `awaiting_approval`. Never commits.
  `POST …/approve` posts it verbatim → `awaiting_external` ("in review") until
  the PR merges or closes.

Read-only is structural: git creds never enter the container (SPEC §12), and the
worker simply doesn't commit/push for draft/review. Fork PRs can't be pushed to,
so the write-kinds bail with a failure comment; the read-only review reads a
fork's head via the mirror's `refs/pull/*` namespace.

All agent-authored text is plain developer voice — **never** mentions being an
AI/agent/assistant or automation; no `🤖`/"generated by" footer. Commits and
comments are authored as me.

---

## 7. Data model (PostgreSQL)

```text
tasks         one unit of work per (repo, subject); partial unique index
              enforces ≤1 active task per subject
task_runs     one attempt per task (worktree path, container, outcome, logs)
github_deliveries   webhook + poll-comment idempotency (delivery/comment ids)
```

`tasks.role` (`assignee` | `reviewer`) records my relationship to the subject and
drives which list the frontend shows it in. `hitl_requests`/`hitl_state` were
dropped earlier (`1700000001000_drop_hitl.sql`).

Task states (`1700000003000_workflow_v3.sql` added `drafting`, `draft`,
`awaiting_external`; `awaiting_approval` was a pre-existing inert value, now
reused):

```text
Branch 1: drafting → draft → (start) → queued → running → awaiting_external(waiting on PR) → awaiting_external(in review) → done
Branch 2:                                queued → running → awaiting_external(in review) → done
Branch 3:                                queued → running → awaiting_approval → (approve) → awaiting_external(in review) → done
any:                                     … → failed | cancelled
```

`displayStatus()` maps these to human labels — `draft`/`awaiting_approval` →
"awaiting approval"; API task DTOs map `awaiting_external` to "waiting on
PR" when no PR number is known and "in review" once a PR is known or the subject
itself is a PR.
The active-slot guard (`uq_one_active_task`) covers
`drafting,draft,queued,running,awaiting_approval`. `awaiting_external` and the
terminal states are excluded from the active-slot guard so follow-up comments can
create new work while a previous branch is waiting externally. `scope=active`
still means all non-terminal tasks, including `awaiting_external`.

Task terminal states are consolidated to `done`, `failed`, and `cancelled`.
Timeouts become `failed` with `state_reason = 'the run timed out'`; discarded
tasks become `cancelled` with a discard reason.

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
            < /run-output/PROMPT.md > /run-output/codex.jsonl 2>&1'
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
the expected primary artifact present (`AGENT_RESULT.md` for write-kinds, `TASK.md`
for draft, `REVIEW.md` for review) + exit 0 → `completed`; cancel/timeout kills →
run outcomes `cancelled`/`timed_out`, which map to task states `cancelled` and
`failed` respectively; else `failed`.

### 9.1 Dev containers (DinD sidecar)

When `container.dev_containers` is true, the worker gives each run a way to create
test containers (e.g. a database) without exposing the host daemon:

- A private per-run network `kotx-run-<runId>` and an anonymous volume for the
  nested daemon's `/var/lib/docker` (overlay2 needs a real fs).
- A **privileged** `docker:dind` sidecar `kotx-dind-<runId>` on that network,
  aliased `dind`, serving a plain-TCP daemon at `tcp://dind:2375` (private network
  only, no host mounts).
- The runner stays **cap-dropped / no-new-privileges** and joins the same network
  with `DOCKER_HOST=tcp://dind:2375` + the `docker` CLI; the run script waits for
  the daemon before invoking Codex. The prompts tell Codex services are reachable
  at host `dind`.

**Cleanup is automatic and total:** at run end (including timeout/cancel) the
worker removes the sidecar — which kills its daemon and every nested container —
then the volume and the network. Privilege is confined to the throwaway sidecar;
the code-execution container keeps the §12 hardening. When disabled, the runner
uses the configured `container.network` and Codex has no Docker access.

---

## 10. Deployment (Docker + CI)

- Single operator-owned host, Docker + Compose. Codex CLI logged in **on the host**
  once; auth copied/seeded into `CODEX_HOME`, then copied per-run into runners.
- **CI** (`.github/workflows/build-images.yml`) builds + pushes `kotx-app` and
  `kotx-runner` to GHCR under the operator's repository owner on push to `main`
  / `v*` tags. `kotx-runner` pins the Codex CLI version and `uv` version.
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
  (`approval_policy` retained but the runner currently bypasses sandbox/approval;
  `reasoning_effort` maps to `-c model_reasoning_effort=<value>`, omit for the
  model default).
- `config/repos.yml` — operator-owned allowlist; per repo: `enabled`,
  `default_branch`, `assignee_login` (my login — also the review-request login),
  `poll`. Never read from a target repo. (The unused `allow_infra_changes`/
  `allow_secret_access`/`require_label_or_command` flags were removed in v3.)
- `.env` — PAT, webhook secret, commit identity, image refs, GHCR pull creds,
  paths, poll interval, plus `API_TOKEN` (Bearer gate for `/api/*`) and optional
  `CORS_ORIGIN` for the browser frontend.

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
- v3 trade-off: the **app** now mounts the Docker socket (for `GET
  /api/containers`) and the data dir read-write (to serve/edit `TASK.md`). The
  socket is read-only in intent (list/inspect) but is still host-level access;
  acceptable for a single-user personal tool, behind the `API_TOKEN` gate.
- Dev-container trade-off (`container.dev_containers`): the runner still gets **no
  host socket**; Codex's Docker access targets a per-run **privileged** `docker:dind`
  sidecar isolated on a private network with no host mounts (§9.1). The sidecar is
  host-root-adjacent if escaped, but it's throwaway and runs no untrusted workload
  beyond what Codex (acting as me) starts. Set it false to remove Docker entirely.

### 12.1 JSON API

`/api/*` is gated by `Authorization: Bearer $API_TOKEN` (timing-safe compare;
503 if `API_TOKEN` is unset). `CORS_ORIGIN` enables the browser frontend.
Endpoints: `GET /api/tasks?scope=active|all`, `GET /api/tasks/:id`,
`GET|PUT /api/tasks/:id/task`, `GET|PUT /api/tasks/:id/review`,
`GET /api/tasks/:id/prompt` (the exact Codex prompt) and `…/log` (a JSON page
of the latest run transcript, newest 200 JSONL entries by default; `limit`
1..1000 and `before` byte cursor for older pages),
`POST /api/tasks/:id/{start,approve,stop,discard}`,
`GET /api/containers`. `discard` moves a task of any kind to `cancelled` with a
discard reason. See [API.md](API.md) for the table.

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

## 14. Changelog v2 → v3

| Area | v2 | v3 |
|------|----|----|
| Interface | bundled HTML dashboard (`/ui`, Basic auth) | headless JSON API (`/api/*`, Bearer) for an external frontend |
| Triggers | `agent:*` labels + `/agent` commands | three role-aware webhook workflows; **no labels/commands** |
| Task vs run | trigger → run immediately | Branch 1 produces a reviewable `TASK.md`; I `start` it from the frontend |
| Kinds | implement / review (review wrote to the PR) | implement (draft+execute) / resolve_conflict / review (**read-only**) |
| Conflicts | left for the agent mid-implement | dedicated auto Branch 2 (resolve + push, no approval) |
| Review | wrote to the PR branch | read-only → `REVIEW.md`, posted to the PR on my approval |
| States | queued/running/done/… | + `drafting`, `draft`, `awaiting_approval`, `awaiting_external`; `role` column |
| Codex stdin | `TASK.md` | `PROMPT.md` (TASK.md/REVIEW.md are per-task artifacts) |
| Polling | polled labels + commands | diffs GitHub state for assignments/reviews/conflicts/comments |
