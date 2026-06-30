# kotx API

A small JSON API for an external frontend to view tasks and drive the three
workflows (see [SPEC.md](SPEC.md) §0). Served by the `app` service.

## Connecting

- **Base URL**: `$PUBLIC_BASE_URL` (e.g. `https://agent.example.com`).
- **Auth**: every `/api/*` request needs `Authorization: Bearer $API_TOKEN`.
  Missing/blank token → `401`; if the server has no `API_TOKEN` set → `503`.
- **CORS**: set `CORS_ORIGIN` to your frontend's origin to allow browser calls.
- **Content types**: list/detail and `…/log` endpoints return JSON; the
  `…/task` and `…/review` endpoints return `text/markdown`.

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  https://agent.example.com/api/tasks?scope=active
```

## Endpoints

| Method & path | Returns / does |
| --- | --- |
| `GET /healthz` | `{ ok: true }` — unauthenticated liveness check |
| `GET /api/tasks?scope=active\|all` | array of tasks where I'm assignee or reviewer. `active` (default) = non-terminal only; `all` = everything |
| `GET /api/tasks/:id` | one task object |
| `GET /api/tasks/:id/task` | the `TASK.md` brief (markdown). `404` if not generated yet |
| `PUT /api/tasks/:id/task` | overwrite the brief before starting. Only allowed while `state = draft`. Body: raw markdown, or JSON `{ "content": "…" }` |
| `POST /api/tasks/:id/start` | **Branch 1**: start the implementation. Only valid from `state = draft` → `queued` |
| `GET /api/tasks/:id/review` | the `REVIEW.md` (markdown). `404` if not generated yet |
| `PUT /api/tasks/:id/review` | edit the review before approving. Only allowed while `state = awaiting_approval`. Body: raw markdown, or JSON `{ "content": "…" }` |
| `GET /api/tasks/:id/prompt` | the exact prompt piped into Codex on the latest run (markdown). `404` until a run has started |
| `GET /api/tasks/:id/log` | a bounded JSON page of the latest run's Codex transcript. Defaults to the newest 200 JSONL entries; `404` until a log exists |
| `POST /api/tasks/:id/approve` | **Branch 3**: post `REVIEW.md` as a PR comment. Only valid from `state = awaiting_approval` → `awaiting_external` (`status = in review`) |
| `POST /api/tasks/:id/stop` | cancel the task (signals the worker / kills the container). `409` if already terminal |
| `POST /api/tasks/:id/discard` | dismiss a task of any kind from the active list → `state = cancelled`, with `stateReason = "discarded from the API"`. Also signals cancel. `409` if already terminal |
| `GET /api/containers` | live `docker ps` of the running codex runners |

Mutating endpoints return `{ ok: true }` on success. Errors return
`{ "error": "…" }` with a `4xx`/`503` status (`409` = wrong state for the action).

The two `PUT` endpoints take the new content as the **request body**. Send it as
`Content-Type: text/markdown` (or `text/plain`) with the raw markdown, or as
`application/json` with `{ "content": "…" }`. A `PUT` with no recognized
content type is rejected by the server with `415 Unsupported Media Type`.

```bash
# raw markdown
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  --data-binary @TASK.md \
  "https://agent.example.com/api/tasks/21/task"
```

## Log pagination

`GET /api/tasks/:id/log` reads `codex.jsonl` from the task's latest run and
returns a JSON object instead of the raw NDJSON file. By default it returns the
newest 200 complete JSONL lines without loading the full log into memory.

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `limit` | Number of JSONL lines to return. Default `200`, maximum `1000`. Values outside `1..1000` return `400`. |
| `before` | Optional byte cursor. Return the newest `limit` lines ending before this offset. Use `page.nextBefore` from the previous response to page older. Must be a non-negative integer, cannot exceed the current log size, and must point to a line boundary unless it equals the end of the file. |

Response shape:

```jsonc
{
  "runId": 123,
  "entries": [
    { "offset": 77120, "record": { "type": "event", "message": "..." } },
    { "offset": 77308, "raw": "not json", "parseError": "Unexpected token ..." }
  ],
  "page": {
    "limit": 200,
    "count": 2,
    "startOffset": 77120,
    "endOffset": 77488,
    "sizeBytes": 77488,
    "hasMoreBefore": true,
    "hasMoreAfter": false,
    "nextBefore": 77120
  }
}
```

To fetch older entries:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://agent.example.com/api/tasks/21/log?limit=200&before=77120"
```

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
  "triggeredBy": "octocat",
  "outcome": null,                 // last run outcome, once finished
  "attempt": 1,
  "startedAt": null,
  "finishedAt": null,
  "createdAt": "2026-06-30T10:00:00.000Z",
  "updatedAt": "2026-06-30T10:00:05.000Z",
  "githubUrl": "https://github.com/owner/repo/issues/31",
  "canStart": true,                // POST …/start is valid now
  "canApprove": false,             // POST …/approve is valid now
  "canStop": true                  // POST …/stop is valid now
}
```

Use `status` for display and the `can*` flags to decide which buttons to show.

### Status meanings

| status | meaning |
| --- | --- |
| `preparing task` | draft run in flight (`drafting`) |
| `awaiting approval` | a `TASK.md` is ready to start, or a `REVIEW.md` is ready to post |
| `queued` / `running` | execution is queued / a container is running |
| `waiting on PR` | issue work has been pushed to `branch`, but no PR from that branch to the default branch has been found yet |
| `in review` | a relevant PR is known; waiting for it to merge or close |
| `done` / `failed` / `cancelled` | terminal (excluded from `scope=active`). Timeouts are `failed` with `stateReason = "the run timed out"`; discarded tasks are `cancelled` with a discard reason |

## The container object (`GET /api/containers`)

```jsonc
{
  "id": "a1b2c3d4e5f6",
  "name": "codex-task-42",
  "runId": 42,
  "image": "ghcr.io/your-github-owner/kotx-runner:latest",
  "state": "running",
  "status": "Up 2 minutes",
  "createdAt": 1751277600         // unix seconds
}
```

## Typical flows

- **Branch 1 (task)**: poll `GET /api/tasks` → open one with `canStart` →
  `GET …/task` (optionally `PUT …/task` to tweak) → `POST …/start` → it moves to
  `running`, then `waiting on PR`, then `in review` after a PR is opened from the
  pushed branch, then `done` when that PR merges.
- **Branch 3 (review)**: a task appears with `kind=review`, `canApprove` →
  `GET …/review` → `POST …/approve` to post it to the PR, then it stays `in
  review` until the PR merges or closes.
- **Branch 2 (conflict)** runs automatically; it just shows up and pushes a fix.
