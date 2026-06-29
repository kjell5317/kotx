# Concurrent Codex Agent — Technical Spec

Status: draft v1 · Scope: decision-complete spec for the MVP, no app code yet.

This document refines the implementation plan into something buildable. Every
ambiguity in the original plan is resolved here with a concrete decision. Places
where this spec **deviates** from the original plan are marked **[DEVIATION]**
with the reason. Genuinely open choices that need your input are collected in
§16.

---

## 0. Key decisions (read this first)

| # | Decision | Why |
|---|----------|-----|
| D1 | **Language: TypeScript on Node 20+.** | Best GitHub ecosystem (`@octokit/*`, `@octokit/webhooks`), mature Redis queue (BullMQ). Python is a viable alt but loses tooling here. |
| D2 | **The worker — not the Codex container — owns all git operations** (fetch, worktree add, commit, push). The Codex container only edits files and writes output files. **[DEVIATION]** | Solves three problems at once: (a) `git worktree`'s `.git` gitfile points to an absolute host path outside the container mount, so commits *inside* the container would fail anyway; (b) the Codex container then needs **no** git credentials and no network git access — much tighter isolation; (c) commit/push policy stays centralized. Codex suggests the commit message; the worker authors the commit. |
| D3 | **HITL pause/resume is implemented as stateless re-runs, not live session suspension.** On approval, the worker starts a *fresh* `codex exec` whose prompt includes the prior approval decision; the worktree already holds prior edits. **[DEVIATION]** | `codex exec` is one-shot and non-interactive — there is no process to "pause". Re-running against the persisted worktree is robust and avoids depending on Codex session-storage internals. Faithful session-resume (`codex exec resume`) is a post-MVP upgrade (§16). |
| D4 | **Codex auth is refreshed host-side in a pre-flight step; containers mount the auth dir read-only.** **[DEVIATION]** | ChatGPT/Codex subscription tokens expire and need refresh. A read-only mount cannot refresh; a read-write mount shared across concurrent containers races. Host-side pre-flight refresh keeps the mount read-only and race-free. |
| D5 | **Per-repo config lives centrally on the agent host (`config/repos.yml`), never read from the target repo.** **[DEVIATION]** | Reading config from the target repo lets any repo escalate its own privileges. Config is operator-controlled only. |
| D6 | **Output files are the source of truth for task outcome; container exit code is secondary.** | Codex's exit code is a weak signal. The presence/contents of `AGENT_RESULT.md` and `HITL_REQUEST.json` deterministically classify the outcome. |

Everything else follows the original plan.

---

## 1. Tech stack

```
Runtime        Node 20 LTS, TypeScript (strict)
Web            Fastify
GitHub         @octokit/app, @octokit/webhooks, @octokit/rest
Queue          BullMQ on Redis 7
DB             PostgreSQL 16, accessed via `pg`; migrations via node-pg-migrate
Container ctl  dockerode (Docker Engine API) from the worker
Proxy          Caddy (automatic TLS)
Codex          Codex CLI inside `codex-runner` image, `codex exec --json`
Config         YAML (config/*.yml), validated with zod
```

Two long-running services share Postgres + Redis:

- **app** — Fastify HTTP server: receives webhooks, validates, persists, enqueues.
- **worker** — BullMQ consumer: orchestrates git + Docker + Codex, posts to GitHub.

The worker launches short-lived `codex-runner` containers via the Docker socket.
**The Docker socket is mounted into the *worker* only, never into a
`codex-runner` container.**

---

## 2. Repository layout

```
kotx/
├─ SPEC.md
├─ docker-compose.yml
├─ Caddyfile
├─ .env.example
├─ config/
│  ├─ repos.yml              # allowlist + per-repo overrides (operator-owned)
│  └─ defaults.yml           # global defaults
├─ migrations/               # node-pg-migrate SQL
├─ packages/
│  ├─ shared/                # db client, types, config loader, github client, zod schemas
│  ├─ app/                   # Fastify webhook receiver
│  └─ worker/                # queue consumer + orchestrator
├─ runner/
│  ├─ Dockerfile             # codex-runner image
│  └─ entrypoint.sh
└─ prompts/
   ├─ implement.md.hbs       # TASK.md template for /agent run
   ├─ review.md.hbs          # review-mode prompt
   └─ resume.md.hbs          # HITL resume prompt
```

Host data dirs (outside the repo, on the VPS):

```
/srv/agent/repos/OWNER__REPO.git      # bare mirror, one per repo
/srv/agent/worktrees/<task_run_id>/   # one per run, never reused
/srv/agent/runs/<task_run_id>/        # container output (codex.jsonl, AGENT_RESULT.md, …)
/srv/agent/codex-home/                # CODEX_HOME, host-refreshed, mounted RO
```

---

## 3. Configuration

### 3.1 `config/defaults.yml`

```yaml
concurrency:
  max_global_workers: 2
  max_workers_per_repo: 1
timeouts:
  task_wall_clock_sec: 1800          # hard kill of a codex-runner
  awaiting_approval_ttl_sec: 172800  # 48h, then auto-cancel
container:
  cpus: 2
  memory: "4g"
  image: "codex-runner:latest"
codex:
  sandbox: "workspace-write"
  auth_refresh_skew_sec: 600         # refresh if token expires within 10 min
policy:
  auto_merge: false                  # invariant, not configurable per repo
  auto_deploy: false                 # invariant
  require_label_or_command: true
```

### 3.2 `config/repos.yml`

```yaml
repos:
  - full_name: "kjell/example"
    enabled: true
    default_branch: "main"
    assignee_login: "kjell"          # task eligible only if assigned to this login
    allow_infra_changes: false
    allow_secret_access: false
    overrides:
      max_workers_per_repo: 1
```

A repo not present (or `enabled: false`) is rejected at the webhook stage.
`auto_merge`/`auto_deploy` are **invariants** and cannot be enabled anywhere.

---

## 4. Data model (PostgreSQL)

```sql
-- enums ---------------------------------------------------------------
CREATE TYPE task_kind   AS ENUM ('implement', 'review');
CREATE TYPE task_state  AS ENUM (
  'queued', 'running', 'awaiting_approval',
  'done', 'failed', 'cancelled', 'timed_out'
);
CREATE TYPE run_outcome AS ENUM (
  'completed', 'needs_approval', 'failed', 'timed_out', 'cancelled'
);
CREATE TYPE hitl_state  AS ENUM ('open', 'approved', 'rejected', 'expired');

-- one logical unit of work, keyed to a GitHub issue/PR -----------------
CREATE TABLE tasks (
  id              BIGSERIAL PRIMARY KEY,
  repo_full_name  TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL,            -- 'issue' | 'pull_request'
  subject_number  INTEGER     NOT NULL,
  kind            task_kind   NOT NULL,
  state           task_state  NOT NULL DEFAULT 'queued',
  branch_name     TEXT,                            -- agent/issue-NN or agent/task-<id>
  pr_number       INTEGER,                         -- set once a PR exists
  triggered_by    TEXT        NOT NULL,            -- github login
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- at most one active task per (repo, subject); see §8
  CONSTRAINT uq_active_subject UNIQUE (repo_full_name, subject_type, subject_number, state)
    DEFERRABLE INITIALLY IMMEDIATE
);
-- Note: the UNIQUE above is illustrative; active-task uniqueness is enforced
-- via a partial unique index instead (a subject may have many terminal-state rows):
CREATE UNIQUE INDEX uq_one_active_task
  ON tasks (repo_full_name, subject_type, subject_number)
  WHERE state IN ('queued', 'running', 'awaiting_approval');

-- one execution attempt of a task (re-runs after HITL create new rows) --
CREATE TABLE task_runs (
  id              BIGSERIAL PRIMARY KEY,
  task_id         BIGINT      NOT NULL REFERENCES tasks(id),
  attempt         INTEGER     NOT NULL,            -- 1,2,3…
  worktree_path   TEXT        NOT NULL,
  container_name  TEXT,
  outcome         run_outcome,
  exit_code       INTEGER,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  jsonl_path      TEXT,                            -- /srv/agent/runs/<id>/codex.jsonl
  result_md       TEXT,                            -- captured AGENT_RESULT.md
  UNIQUE (task_id, attempt)
);

-- webhook idempotency --------------------------------------------------
CREATE TABLE github_deliveries (
  delivery_id   TEXT PRIMARY KEY,                  -- X-GitHub-Delivery header
  event         TEXT        NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- human-in-the-loop gates ---------------------------------------------
CREATE TABLE hitl_requests (
  id              BIGSERIAL PRIMARY KEY,
  task_id         BIGINT      NOT NULL REFERENCES tasks(id),
  task_run_id     BIGINT      NOT NULL REFERENCES task_runs(id),
  state           hitl_state  NOT NULL DEFAULT 'open',
  reason          TEXT        NOT NULL,
  proposed_action TEXT        NOT NULL,
  risk            TEXT        NOT NULL,            -- low|medium|high
  alternatives    JSONB       NOT NULL DEFAULT '[]',
  comment_id      BIGINT,                          -- the GitHub comment we posted
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`updated_at` is maintained by a trigger or in the data-access layer.

---

## 5. Task state machine

```
                 enqueue
   (webhook) ───────────────▶ queued
                                │ worker picks up + acquires repo lock
                                ▼
                             running ──────────────┐
                                │                   │ codex writes HITL_REQUEST.json
        codex completes ok      │                   ▼
                                │            awaiting_approval
                                ▼                   │  /agent approve  → enqueue resume → running
   commit→push→PR/comment ──▶ done                  │  /agent reject   → cancelled
                                                    │  TTL expires     → cancelled
   any run: nonzero/no result ─────────────────────────────▶ failed
   /agent stop, or kill ───────────────────────────────────▶ cancelled
   wall-clock exceeded ────────────────────────────────────▶ timed_out
```

Allowed transitions (anything else is a bug):

| From | To | Trigger |
|------|----|---------|
| — | queued | eligible webhook |
| queued | running | worker dequeue + lock acquired |
| queued | cancelled | `/agent stop` before start |
| running | done | run outcome `completed` + push/PR ok |
| running | awaiting_approval | run outcome `needs_approval` |
| running | failed | run outcome `failed` |
| running | timed_out | wall-clock kill |
| running | cancelled | `/agent stop` |
| awaiting_approval | running | `/agent approve` (new attempt enqueued) |
| awaiting_approval | cancelled | `/agent reject` or TTL or `/agent stop` |

Terminal states: `done`, `failed`, `cancelled`, `timed_out`.
The partial unique index (§4) guarantees a subject has ≤1 non-terminal task.

---

## 6. GitHub webhook contract

### 6.1 Endpoint

```
POST /github/webhook
Headers: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256
Response: 202 Accepted (always, once persisted) — processing is async.
          400 on bad signature. 200 fast-path for ignored events.
```

Subscribed events: `issues`, `pull_request`, `issue_comment`,
`pull_request_review_comment`.

### 6.2 Ingestion pipeline (in `app`)

```
1. Verify X-Hub-Signature-256 (HMAC-SHA256 of raw body, GITHUB_WEBHOOK_SECRET). Fail → 400.
2. INSERT delivery_id into github_deliveries. Conflict → 200 (duplicate, drop).
3. Resolve repo in config/repos.yml. Not enabled → 200 (ignore).
4. Parse intent (§6.3). No actionable intent → 200 (ignore).
5. Resolve eligibility (§6.4). Ineligible → optionally post a one-line reason, 200.
6. Create/transition task (§6.5) inside a tx honoring uq_one_active_task.
7. Enqueue BullMQ job. → 202.
```

Signature verification needs the **raw** request body — register Fastify with a
raw-body capture before JSON parsing.

### 6.3 Intent parsing

**Labels** (from `issues`/`pull_request` `labeled` actions or current label set):

```
agent:ready    → kind=implement
agent:review   → kind=review
agent:ignore   → suppress all automation for this subject
```

**Comment commands** — a comment body whose first non-empty line matches
`^/agent\s+(run|review|stop|status|approve|reject)\b`. Only one command per
comment; first match wins. **Commands are accepted only from the repo's
`assignee_login`** — the single authorized commander. Comments from anyone else
are ignored (no `operators` list in the MVP).

```
/agent run      → kind=implement, force start
/agent review   → kind=review
/agent stop     → cancel active task
/agent status   → post current state (no task change)
/agent approve  → resolve open HITL → resume
/agent reject   → resolve open HITL → cancel
```

### 6.4 Eligibility resolution (ordered; first decisive rule wins)

```
1. Repo not enabled in config            → ignore
2. agent:ignore present                  → ignore
3. Comment command present:
     - command author not authorized      → ignore (+ optional comment)
     - approve/reject but no open HITL     → ignore (+ comment)
     - stop/status                         → handle directly (no new task)
     - run/review                          → candidate (kind from command)
4. Else label present (ready/review)      → candidate (kind from label)
5. Else                                   → ignore
Then, for a candidate:
   - subject must be OPEN
   - subject must be assigned to assignee_login
   - require_label_or_command must be satisfied (it is, by reaching here)
   - if an active task exists for the subject:
        run/review → ignore (+ "already running" comment)
        (stop/approve/reject handled in step 3)
```

### 6.5 Task creation / transition

- New candidate, no active task → INSERT `tasks` (`queued`), INSERT `task_runs`
  (attempt 1), enqueue.
- `/agent approve` on `awaiting_approval` → mark HITL `approved`, INSERT new
  `task_runs` (attempt+1), set task `running`-bound, enqueue **resume** job.
- `/agent reject` → mark HITL `rejected`, task → `cancelled`.
- `/agent stop` → signal worker to kill container (§8.4), task → `cancelled`.

---

## 7. Internal queue & job contract

Single BullMQ queue `tasks`. Job payload:

```ts
type Job = {
  taskId: number;
  taskRunId: number;
  mode: "implement" | "review" | "resume";
  repoFullName: string;
  subject: { type: "issue" | "pull_request"; number: number };
  // resume only:
  hitlRequestId?: number;
  approvalNote?: string;
};
```

BullMQ settings: `attempts: 1` (no automatic retry — re-runs are explicit via
HITL or operator), `removeOnComplete: false` (we keep our own state in PG),
worker `concurrency = max_global_workers`.

---

## 8. Concurrency & locking

### 8.1 Global limit
BullMQ worker `concurrency = config.max_global_workers` (start: 2).

### 8.2 Per-repo limit
A Redis lock per repo. Before processing, the worker attempts
`SET lock:repo:<full_name> <taskRunId> NX EX <wall_clock+buffer>`. If it fails,
the job is re-queued with a short backoff (it does **not** fail the task).
Lock released in `finally`. `max_workers_per_repo` > 1 would use N lock slots;
MVP keeps it at 1.

### 8.3 Active-task uniqueness
Enforced at the DB layer by `uq_one_active_task` (§4), independent of the lock.

### 8.4 Cancellation
`/agent stop` sets a Redis flag `cancel:task:<taskId>` and, if a container is
running, the worker (which holds `container_name` in `task_runs`) calls
`docker kill`. The orchestrator checks the cancel flag at each phase boundary.

### 8.5 Wall-clock timeout
Worker arms a timer for `task_wall_clock_sec`; on expiry it `docker kill`s the
container and records outcome `timed_out`.

---

## 9. Git / worktree lifecycle (worker-owned)

All git runs on the **host** (worker process), never in the Codex container.

### 9.1 Mirror bootstrap (once per repo)
```bash
git clone --mirror https://x-access-token:<TOKEN>@github.com/OWNER/REPO.git \
  /srv/agent/repos/OWNER__REPO.git
```
`<TOKEN>` is a short-lived GitHub App **installation** token, minted per
operation (never stored on disk; remote URL is rewritten before fetch/push).

### 9.2 Per-run worktree
```bash
cd /srv/agent/repos/OWNER__REPO.git
git fetch --prune origin
# implement: branch off default branch
git worktree add /srv/agent/worktrees/<run_id> -b agent/issue-<NN> origin/main
# review:    check out the PR head (read-only intent)
git worktree add /srv/agent/worktrees/<run_id> --detach origin/pull/<PR>/head
```
Worktrees are never reused; removed (`git worktree remove --force`) after the
run except when the task is `awaiting_approval` (the resume attempt reuses the
*same worktree path* so prior edits persist — this is the one intentional reuse,
within a single task across attempts).

### 9.3 Commit & push (implement mode, on `completed`)
```bash
cd /srv/agent/worktrees/<run_id>
git add -A
git -c user.name="<bot>" -c user.email="<bot>@users.noreply.github.com" \
    commit -F /srv/agent/runs/<run_id>/COMMIT_MSG.md   # authored by Codex (§10)
git push https://x-access-token:<TOKEN>@github.com/OWNER/REPO.git HEAD:agent/issue-<NN>
```
Then open/update the PR (§12). **The agent never merges and never pushes to a
PR's own branch in review mode.**

---

## 10. Codex runner I/O contract

### 10.1 Container invocation
```bash
docker run --rm \
  --name codex-task-<run_id> \
  --network <egress-only>           \  # see §14
  --cpus=2 --memory=4g \
  -v /srv/agent/worktrees/<run_id>:/workspace \
  -v /srv/agent/codex-home:/home/codex/.codex:ro \
  -v /srv/agent/runs/<run_id>:/run-output \
  -w /workspace \
  -e CODEX_HOME=/home/codex/.codex \
  codex-runner:latest \
  bash -lc 'codex exec --json --sandbox workspace-write --ask-for-approval never - \
            < /run-output/TASK.md > /run-output/codex.jsonl 2>&1'
```

**Flag rationale (verify exact spellings against the pinned CLI version — §16 Q6):**

- `exec` — non-interactive headless mode; runs to completion, no TUI.
- prompt via `-` / stdin — `codex exec` normally takes the prompt as a positional
  arg. If `-`-means-stdin is unsupported by the installed version, fall back to
  `codex exec "$(cat /run-output/TASK.md)"`. **Pin this in `runner/Dockerfile`.**
- `--json` — JSONL event stream → `codex.jsonl` (observability only; control flow
  keys off output files, not this stream — § D6).
- `--sandbox workspace-write` — OS sandbox for **shell commands the model runs**
  (not Codex's own API connection). **Network is disabled inside this sandbox**,
  so commands needing network (e.g. `npm install`) fail. This is *why* GitHub CI is
  the source of truth and `TASK.md` instructs Codex to run only local checks where
  deps already exist.
- `--ask-for-approval never` — **critical for headless operation.** Without it,
  Codex's *own* approval policy can block waiting for an interactive approval that
  never arrives, hanging the container until the wall-clock kill. We deliberately
  bypass Codex's built-in approvals: risky actions are surfaced through *our* HITL
  protocol (`HITL_REQUEST.json`, §11), not Codex's prompts. (`--full-auto` bundles
  sandbox + auto-approval and is an acceptable equivalent if preferred.)

### 10.2 Inputs (written by worker into `/run-output` before launch)
- `TASK.md` — rendered from `prompts/implement.md.hbs`, `review.md.hbs`, or
  `resume.md.hbs`. Contains: subject title/body, the Definition of Done (§ plan),
  review-mode rules, and for resume the approval decision + note.

### 10.3 Outputs (read by worker after the container exits)
| File | Meaning |
|------|---------|
| `codex.jsonl` | full event stream (always kept for observability) |
| `AGENT_RESULT.md` | required on success: summary, changed files, reasoning, tests considered/run, CI expectations, risks, follow-ups |
| `COMMIT_MSG.md` | Codex's suggested commit message (implement mode) |
| `REVIEW.md` | the structured review (review mode) |
| `HITL_REQUEST.json` | present iff Codex needs approval (schema §11) |

### 10.4 Outcome classification (worker)
```
HITL_REQUEST.json present                      → needs_approval
no HITL + exit 0 + AGENT_RESULT.md present      → completed
killed by timeout                               → timed_out
killed by cancel                                → cancelled
otherwise                                       → failed
```
Output files are authoritative; exit code only breaks ties (§ D6).

---

## 11. HITL protocol

### 11.1 `HITL_REQUEST.json` schema (written by Codex)
```json
{
  "reason": "string, why approval is needed",
  "proposed_action": "string, the exact action to be taken",
  "risk": "low | medium | high",
  "alternatives": ["string", "..."]
}
```
Risky categories that MUST trigger this (instructed in TASK.md): DB migrations,
auth/security changes, major dependency upgrades, infra changes, secret handling,
destructive commands, broad refactors, force-push, deployment.

### 11.2 Worker handling on `needs_approval`
```
1. Validate JSON against schema; invalid → outcome failed.
2. INSERT hitl_requests (open).
3. Post a GitHub comment rendering reason/action/risk/alternatives + how to
   respond (/agent approve | /agent reject). Store comment_id.
4. Task → awaiting_approval. Keep the worktree. Release repo lock.
5. Arm awaiting_approval_ttl_sec timer → on expiry, HITL expired + task cancelled.
```

### 11.3 Resume on `/agent approve`
```
1. hitl_requests → approved (decided_by, decided_at).
2. New task_runs (attempt+1), SAME worktree_path.
3. Enqueue mode=resume with approvalNote.
4. resume.md.hbs prompt: "A prior step requested approval for <action>.
   Decision: APPROVED. Note: <note>. The workspace already contains your earlier
   changes. Continue from there and finish per the Definition of Done."
```
**[DEVIATION]** This is a fresh `codex exec`, not a suspended session (§ D3).
Faithful session-resume via `codex exec resume <session_id>` is deferred (§16).

---

## 12. GitHub outputs

### 12.1 Implement → PR (open or update)
PR body template:
```
## Summary
## Changed files
## Reasoning
## Tests considered
## Tests run (if any)
## CI expectations
## Risks
## Follow-up work
---
🤖 Generated by the Codex agent · run #<task_run_id> · do not auto-merge
```
- New branch with no PR → create PR, base = default branch, link issue
  (`Closes #<NN>` when appropriate).
- Existing agent PR → push new commits; update PR body; post a short "updated"
  comment.

### 12.2 Review → comment only
Post `REVIEW.md` as a single issue/PR comment. Sections per the plan's review
template, ending with a clear recommendation: **approve / request changes /
comment only**. No code changes, no branch, no push.

### 12.3 Status / errors
`/agent status` → comment with task state, attempt, branch/PR links.
`failed`/`timed_out` → comment with a short reason + pointer to retained logs
(no internal paths leaked; reference run id).

---

## 13. Codex auth (host-managed)

```bash
# one-time, interactive, on the VPS:
export CODEX_HOME=/srv/agent/codex-home
codex login --device-auth
```
**Pre-flight refresh** (worker, before each container launch): inspect token
expiry in `$CODEX_HOME`; if it expires within `auth_refresh_skew_sec`, run the
host-side refresh, serialized under a Redis lock `lock:codex-auth` so concurrent
workers don't race. Containers always mount `$CODEX_HOME` **read-only**
(§ D4). No `OPENAI_API_KEY`/API-key env vars in any container.

---

## 14. Security model

Mounted into `codex-runner` (and nothing else):
```
/workspace          (the task worktree, read-write)
/home/codex/.codex  (Codex auth, READ-ONLY)
/run-output         (task output dir, read-write)
```
Never mounted into `codex-runner`: host home, SSH keys, prod secrets, cloud
creds, **the Docker socket**, the bare mirror, GitHub tokens.

- Network: Codex container gets **egress only** to what Codex needs (OpenAI/Codex
  endpoints). No inbound. No git remotes reachable (git is worker-side anyway).
  MVP may start with unrestricted egress + no creds; tighten to an allowlist
  later (§16).
- GitHub tokens: short-lived installation tokens minted per operation, injected
  into remote URLs by the worker, never written to disk or into a container.
- Invariants (not configurable anywhere): no auto-merge, no auto-deploy, no
  pushing to a non-agent branch, no force-push without an approved HITL.
- Webhook auth: HMAC signature required; deliveries de-duped by id.

---

## 15. MVP milestones (mapped to this spec)

| Milestone | Delivers | Spec refs |
|-----------|----------|-----------|
| M1 Webhook receiver | `app`, signature verify, dedup, config, intent+eligibility, task rows, enqueue | §3,§4,§6,§7 |
| M2 Single worker | worktree, TASK.md render, run container, capture JSONL, classify, commit+push, open PR / post review | §9,§10,§12 |
| M3 Concurrency | BullMQ concurrency, repo lock, cancel flag, wall-clock timeout | §7,§8 |
| M4 HITL | parse HITL_REQUEST.json, post approval comment, approve/reject/TTL, resume re-run | §11 |
| M5 Hardening | log retention, per-repo overrides, failure recovery, richer PR/review bodies, observability | §3,§12 |

---

## 16. Open questions for you

1. ~~**Authorized commanders.**~~ **RESOLVED: assignee only.** No `operators`
   list in the MVP — commands are honored solely from the repo's `assignee_login`
   (§6.3). Everyone else's `/agent …` comments are ignored.
2. **Issue → PR linking.** Always `Closes #NN` (auto-close on merge), or just
   reference `#NN`? Default: `Closes`.
3. **Egress lockdown timing.** Start with unrestricted container egress (no
   creds mounted) and tighten to an endpoint allowlist in M5, or lock it down in
   M2? Default: unrestricted-but-credless first, tighten in M5.
4. **Faithful session resume.** Is stateless HITL resume (§ D3) acceptable for
   the MVP, with `codex exec resume <session_id>` as a later upgrade? Default:
   yes, stateless for MVP.
5. **Review-mode checkout depth.** Detached `origin/pull/<PR>/head` is enough for
   a diff review; do you also want the PR's base merge so Codex sees the merged
   result? Default: head only.
6. **`codex exec` flags (verification task, not a design choice).** On the VPS,
   run `codex exec --help` against the pinned CLI version and confirm: (a) `--json`
   exists and emits JSONL; (b) `--sandbox workspace-write` exists and its
   network-off behavior; (c) `--ask-for-approval never` (or `--full-auto`) exists
   and prevents interactive blocking; (d) how the prompt is supplied — positional
   arg vs. stdin via `-`. Record the exact, working command in
   `runner/Dockerfile`. See §10.1 for the rationale behind each flag.
```
