# kotx API

A small JSON API for an external frontend to view tasks and drive the three
workflows (see [SPEC.md](SPEC.md) §0). Served by the `app` service.

## Connecting

- **Base URL**: `$PUBLIC_BASE_URL` (e.g. `https://agent.example.com`).
- **Auth**: every `/api/*` request needs `Authorization: Bearer $API_TOKEN`.
  Missing/blank token → `401`; if the server has no `API_TOKEN` set → `503`.
- **CORS**: set `CORS_ORIGIN` to your frontend's origin to allow browser calls.
- **Content types**: list/detail, `/api/repos`, and `…/merge/context` return
  JSON; the `…/task` and `…/review` endpoints return `text/markdown`.
- **Push**: set `WEBHOOK_URL`/`WEBHOOK_SECRET` to receive every task state
  change as a signed webhook (see [State-transition webhook](#state-transition-webhook))
  instead of tight polling.

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  https://agent.example.com/api/tasks?scope=active
```

## Endpoints

| Method & path | Returns / does |
| --- | --- |
| `GET /healthz` | `{ ok: true }` — unauthenticated liveness check |
| `POST /api/runs` | manually start work. With `{ "type": "implement" \| "review" \| "resolve", "number": 123, "repo"?: "owner/name" }`, enqueue an existing GitHub issue/PR. With `{ "repo"?: "owner/name", "title": "...", "body"?: "..." }`, create a new issue, assign it to the repo's configured assignee, and let the normal assignment path draft it. `repo` accepts full names plus the per-repo `aliases` from `config/repos.yml` (see `GET /api/repos`) |
| `GET /api/repos` | the enabled repo allowlist: `[{ fullName, aliases, assignee, mergeMethod }]` — cheap and static, straight from `config/repos.yml` |
| `GET /api/tasks?scope=active\|all` | array of tasks where I'm assignee or reviewer. `active` (default) = non-terminal only; `all` = everything |
| `GET /api/tasks?updatedSince=<ISO>` | reconciliation mode: every task — **terminal ones included**, regardless of `scope` — whose `updatedAt` is at or after the timestamp. The polling fallback for missed webhooks |
| `GET /api/tasks/:id` | one task object |
| `GET /api/tasks/:id/task` | the `TASK.md` brief (markdown). `404` if not generated yet |
| `PUT /api/tasks/:id/task` | overwrite the brief before starting. Only allowed while `state = draft`. Body: raw markdown, or JSON `{ "content": "…" }` |
| `POST /api/tasks/:id/start` | **Branch 1**: start the implementation. Only valid from `state = draft` → `queued` |
| `GET /api/tasks/:id/review` | the `REVIEW.md` (markdown). `404` if not generated yet |
| `PUT /api/tasks/:id/review` | edit the review before approving/commenting. Only allowed while `state = awaiting_approval`. Body: raw markdown, or JSON `{ "content": "…" }`; empty content is allowed for a bodyless approval |
| `POST /api/tasks/:id/comment` | **Branch 3** (`kind = review`): post non-empty `REVIEW.md` as a plain PR comment. Empty or whitespace-only review text is rejected. Only valid from `state = awaiting_approval` → `awaiting_external` |
| `GET /api/tasks/:id/pr` | **Branch 1**: the proposed PR as JSON `{ title, body }`. `404` if there's no proposal |
| `PUT /api/tasks/:id/pr` | edit the proposed PR title/description before approving. Only allowed while `kind = implement` and `state = awaiting_approval`. Body: JSON `{ "title"?: "…", "body"?: "…" }` (send either or both) |
| `GET /api/tasks/:id/merge/context` | **Branch 1**: structured merge proposal context as JSON `{ prNumber, approvedBy, reviewUrl, commentMarkdown }`. `approvedBy` and `reviewUrl` come from the approving PR review metadata, while `commentMarkdown` is the approval comment (`MERGE_APPROVAL.md`). `404` if there's no merge proposal; `409` if the task is not awaiting merge confirmation |
| `POST /api/tasks/:id/merge` | **Branch 1**: confirm the merge proposal. Merges the tracked PR using the repo's configured `merge_method` (`squash` by default), marks the task `done`, and clears its notification. `409` if the task has no tracked PR or GitHub says the PR is missing/not mergeable |
| `POST /api/tasks/:id/approve` | approve the proposal (see `proposes`). **Branch 3** (`kind = review`): submit an approving PR review using `REVIEW.md` as the body; if the trimmed review is empty, the approval has no body. **Branch 1 PR opening** (`kind = implement`, no tracked PR): merge the default branch into the pushed branch and open the proposed PR (returns `{ ok, prNumber, prUrl }`), then mark it `awaiting_external`. **Branch 1 merge** (`kind = implement`, tracked PR): same as `POST …/merge`. Only valid from `state = awaiting_approval` |
| `POST /api/tasks/:id/discard` | dismiss a task of any kind from the active list → `state = cancelled`, with `stateReason = "discarded from the API"`. Also signals cancel. `409` if already terminal |

The document endpoints (`GET …/task`, `GET …/review`, `GET …/pr`) keep serving
their last content after a task reaches a terminal state (`done` / `failed` /
`cancelled`) — the artifacts live in a per-task directory that garbage
collection never touches, so consumers can (re-)index them at any time.

> Removed in the runs/tasks consolidation (their only client no longer uses
> them): `GET /api/tasks/:id/prompt`, `GET /api/tasks/:id/log` (and its
> pagination), `GET /api/tasks/:id/merge` (raw markdown — use
> `GET …/merge/context`), and `GET /api/containers` (the app no longer mounts
> the Docker socket).

Mutating endpoints return `{ ok: true }` on success. Errors return
`{ "error": "…" }` with a `4xx`/`503` status (`409` = wrong state for the action).

The `…/task` and `…/review` `PUT` endpoints take the new content as the **request
body**. Send it as `Content-Type: text/markdown` (or `text/plain`) with the raw
markdown, or as `application/json` with `{ "content": "…" }`. A `PUT` with no
recognized content type is rejected by the server with `415 Unsupported Media Type`.
The task brief cannot be empty; the review text may be empty so `POST …/approve`
can submit a bodyless approval. `POST …/comment` requires the saved review text
to be non-empty after trimming. The `…/pr` `PUT` differs: it takes
`application/json` with `{ "title"?, "body"? }`.

```bash
# raw markdown
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  --data-binary @TASK.md \
  "https://agent.example.com/api/tasks/21/task"
```

## Manual runs

`POST /api/runs` supports two modes.

When `number` is present, it explicitly enqueues work by GitHub issue/PR number,
without requiring the issue to be assigned to you or the PR to request your
review. In this mode, `type` is required and the server still checks that the
requested action applies:

- `implement` accepts an open issue or open PR and creates the normal draft task.
- `review` accepts only an open PR and creates or refreshes a review task. The
  response also includes an `assignees` array (the PR's assignee logins) so the
  caller knows who owns the PR being reviewed.
- `resolve` accepts only an open PR that is currently conflicting; mergeable PRs
  return `409`.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"review","number":42,"repo":"owner/name"}' \
  "https://agent.example.com/api/runs"
```

When `number` is omitted, the endpoint creates a new GitHub issue in the
selected repository and assigns it to that repo's configured `assignee_login`.
It returns `201` with the created issue details and does not enqueue a task
directly; the normal assignment webhook or poller path creates the draft task.
In this mode, `title` is required because GitHub requires one, and `body` is
optional.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"repo":"Social Ai","title":"Add import progress","body":"Show progress while CSV imports run."}' \
  "https://agent.example.com/api/runs"
```

Successful issue creation returns:

```json
{
  "status": "created",
  "repo": "TUM-Social-AI/AflaConnect",
  "issueNumber": 42,
  "issueUrl": "https://github.com/TUM-Social-AI/AflaConnect/issues/42",
  "assignee": "your-login"
}
```

`repo` is optional when exactly one repo is enabled in `config/repos.yml` (it's
inferred). When more than one repo is enabled, `repo` is **required** — omitting
it returns `409` with the list of enabled repos. A `repo` that isn't in the
enabled allowlist returns `409`. Full repo names continue to work, with simple
whitespace and trailing slashes normalized. Each repo's `aliases` from
`config/repos.yml` (as returned by `GET /api/repos`) resolve to its full name
before allowlist validation, matched case- and whitespace-insensitively.

With zero enabled repos it returns `409`. Missing GitHub numbers return `404`;
closed subjects, plain issues for `review`/`resolve`, mergeable PRs for
`resolve`, and active-task conflicts return `409` with the pipeline `reason`.
GitHub create, assignment, and lookup failures return `500`.

## One task per subject and kind

While a **non-terminal** task exists for a `(repo, subjectNumber, kind)` tuple,
any further trigger for the same tuple — a repeated review request, a follow-up
comment on an assigned issue/PR, a manual `POST /api/runs` — updates/refreshes
that task (and fires the state-transition webhook) instead of creating a new
row. In-flight drafts and pending reviews are re-run with the new input; a task
that is running or waiting on its PR just records the new trigger. A new task
for the same subject and kind is only created after the previous one is
terminal. Consumers can therefore key their own bookkeeping on
`repo` + `subjectNumber` + `kind` and treat every update as an upsert.

A task matches its tuple by its own subject number **or** its tracked
`prNumber`: once an issue-origin task has opened PR *N*, feedback addressed to
PR *N* (a comment on the PR, or `POST /api/runs` with `number: N`) folds into
the issue task rather than opening a second implement task. This is unambiguous
because GitHub issues and PRs share one number space.

## State-transition webhook

Set `WEBHOOK_URL` and `WEBHOOK_SECRET` in the environment to have every task
state change POSTed to that URL:

```jsonc
{
  "event": "task.state_changed",
  "previousState": "drafting",     // null when the task was just created
  "task": { /* the full task object, same shape as GET /api/tasks/:id */ },
  "occurredAt": "2026-07-03T10:00:00.000Z"
}
```

- The raw request body is signed with HMAC-SHA256 using `WEBHOOK_SECRET` and
  sent as `X-Kotx-Signature: sha256=<hex>` — verify before parsing.
- Fires for **all** kinds (filter `resolve_conflict` client-side if you don't
  surface it) and **all** transitions, terminal ones included, plus follow-up
  refreshes of an existing task.
- Delivery is at-least-once, unordered, best-effort: non-2xx responses are
  retried a handful of times with backoff, then dropped. `task` always carries
  the task's state at delivery time, so treat each delivery as an upsert and
  reconcile misses with `GET /api/tasks?updatedSince=…` (e.g. on startup and on
  a slow loop).

## The task object

```jsonc
{
  "id": 42,
  "repo": "owner/repo",
  "subjectType": "issue",          // "issue" | "pull_request"
  "subjectNumber": 31,
  "title": "Add a metadata index", // issue/PR title at task creation; null for pre-existing rows
  "kind": "implement",             // "implement" | "resolve_conflict" | "review"
  "role": "assignee",              // "assignee" | "reviewer"
  "state": "draft",                // drafting|draft|queued|running|awaiting_approval|awaiting_external|done|failed|cancelled
  "status": "awaiting approval", // human-readable label for `state`
  "stateReason": null,             // reason for failed/cancelled, when set
  "branch": "31-add-metadata-index",
  "prNumber": null,                // set after a PR is opened from the pushed branch
  "trackedPrNumber": null,         // PR this task is waiting on; for PR-subject tasks this is subjectNumber
  "triggeredBy": "octocat",
  "outcome": null,                 // last run outcome, once finished
  "attempt": 1,
  "startedAt": null,
  "finishedAt": null,
  "createdAt": "2026-06-30T10:00:00.000Z",
  "updatedAt": "2026-06-30T10:00:05.000Z",
  "githubUrl": "https://github.com/owner/repo/issues/31",
  "canStart": true,                // POST …/start is valid now
  "canApprove": false,             // POST …/approve is valid now (review, PR opening, or merge)
  "canMerge": false,               // POST …/merge is valid now
  "canComment": false,             // POST …/comment is valid now (review tasks only)
  "proposes": null,                // what approve does: "review" | "pr" | "merge" | null
  "canDiscard": true               // POST …/discard is valid now
}
```

Use `status` for display and the `can*` flags to decide which buttons to show.
When `canApprove` is true, `proposes` says what the approve button does: `"review"`
submits an approving PR review with `REVIEW.md` as the body (fetch via
`GET …/review`), `"pr"` opens the proposed PR (fetch via `GET …/pr`), and
`"merge"` merges the tracked PR (fetch approver identity, review URL, and the
approval comment via `GET …/merge/context`; `POST …/merge` is the explicit
confirmation endpoint). When
`canComment` is true, `POST …/comment` posts the same `REVIEW.md` as a plain PR
comment instead of approving the PR; it is rejected if the saved review is empty
or whitespace-only.

### Status meanings

| status | meaning |
| --- | --- |
| `preparing task` | draft run in flight (`drafting`) |
| `awaiting approval` | a `TASK.md` is ready to start, or a `REVIEW.md` is ready to approve/comment |
| `queued` / `running` | execution is queued / a container is running |
| `waiting on PR` | issue work has been pushed to `branch`, but no PR from that branch to the default branch has been found yet |
| `in review` | a relevant PR is known; waiting for it to merge or close |
| `done` / `failed` / `cancelled` | terminal (excluded from `scope=active`). Timeouts are `failed` with `stateReason = "the run timed out"`; discarded tasks are `cancelled` with a discard reason |

## Typical flows

- **Branch 1 (task)**: watch the webhook (or poll `GET /api/tasks`) → open a
  task with `canStart` →
  `GET …/task` (optionally `PUT …/task` to tweak) → `POST …/start` → it moves to
  `running`, then comes back with `canApprove` and `proposes = "pr"`. Review the
  proposed PR via `GET …/pr` (optionally `PUT …/pr` to edit the title/body) →
  `POST …/approve` to open the PR. It then shows `in review` until that PR merges
  (`done`) or closes (`cancelled`). If the PR receives an approving review first,
  the same task returns to `awaiting approval` with `proposes = "merge"`; fetch
  `GET …/merge/context` to read the approver, review URL, and approval comment
  and `POST …/merge` (or `POST …/approve`) to merge the PR and mark the task
  done.
- **Branch 3 (review)**: a task appears with `kind=review`, `canApprove`, and
  `canComment` → `GET …/review` → either `POST …/approve` to submit an approving
  PR review or `POST …/comment` to post non-empty review text as a plain PR
  comment. It then stays `in review` until the PR merges or closes.
- **Branch 2 (conflict)** runs automatically; it just shows up and pushes a fix.
