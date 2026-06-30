# kotx API

A small JSON API for an external frontend to view tasks and drive the three
workflows (see [SPEC.md](SPEC.md) §0). Served by the `app` service.

## Connecting

- **Base URL**: `$PUBLIC_BASE_URL` (e.g. `https://agent.example.com`).
- **Auth**: every `/api/*` request needs `Authorization: Bearer $API_TOKEN`.
  Missing/blank token → `401`; if the server has no `API_TOKEN` set → `503`.
- **CORS**: set `CORS_ORIGIN` to your frontend's origin to allow browser calls.
- **Content types**: list/detail endpoints return JSON; the `…/task` and
  `…/review` endpoints return `text/markdown`.

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
| `GET /api/tasks/:id/log` | the raw Codex transcript (JSONL) for the latest run — useful for diagnosing failures |
| `POST /api/tasks/:id/approve` | **Branch 3**: post `REVIEW.md` as a PR comment. Only valid from `state = awaiting_approval` → `done` |
| `POST /api/tasks/:id/stop` | cancel the task (signals the worker / kills the container). `409` if already terminal |
| `POST /api/tasks/:id/discard` | dismiss a task of any kind from the active list → `state = discarded`. Also signals cancel. `409` if already terminal |
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

## The task object

```jsonc
{
  "id": 42,
  "repo": "owner/repo",
  "subjectType": "issue",          // "issue" | "pull_request"
  "subjectNumber": 31,
  "kind": "implement",             // "implement" | "resolve_conflict" | "review"
  "role": "assignee",              // "assignee" | "reviewer"
  "state": "draft",                // drafting|draft|queued|running|awaiting_approval|awaiting_external|done|failed|cancelled|timed_out|discarded
  "status": "waiting on my approval", // human-readable label for `state`
  "branch": "31-add-metadata-index",
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
| `waiting on my approval` | a `TASK.md` is ready to start, or a `REVIEW.md` is ready to post |
| `queued` / `running` | execution is queued / a container is running |
| `waiting on external approval` | my changes are pushed; waiting on others to review/merge |
| `done` / `failed` / `cancelled` / `timed out` / `discarded` | terminal (excluded from `scope=active`) |

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
  `running` then `awaiting external approval`.
- **Branch 3 (review)**: a task appears with `kind=review`, `canApprove` →
  `GET …/review` → `POST …/approve` to post it to the PR.
- **Branch 2 (conflict)** runs automatically; it just shows up and pushes a fix.
