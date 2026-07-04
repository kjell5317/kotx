# Home Assistant Notification Handoff

This document describes the non-failure Home Assistant mobile notification
behavior that kotx no longer owns. Downstream task UI should replace these
prompts by consuming kotx `task.state_changed` webhooks and calling the kotx API
for user actions.

kotx still sends direct Home Assistant notifications for failed tasks. Normal
progress, approval, and merge prompts should be driven from the signed webhook
payload instead.

## Replacement signal

Configure `WEBHOOK_URL` and `WEBHOOK_SECRET` so kotx sends signed
`task.state_changed` webhooks. Each payload contains the full task DTO, matching
`GET /api/tasks/:id`, plus `previousState` and `occurredAt`.

Use the webhook task as an upsert:

- Verify `X-Kotx-Signature` before parsing.
- Key downstream task state by `task.id`, or by `repo` + `subjectNumber` +
  `kind` if the downstream system owns a separate task model.
- Use `task.state`, `task.kind`, `task.canStart`, `task.canApprove`,
  `task.canMerge`, `task.canComment`, and `task.proposes` to choose UI actions.
- Remove or mark replacement prompts as stale when a later webhook no longer
  matches one of the prompt conditions below, for example `queued`, `running`,
  `awaiting_external`, `done`, `cancelled`, or `failed`.
- Reconcile missed events with `GET /api/tasks?updatedSince=<ISO>`.

See [API.md](API.md#state-transition-webhook) for the webhook contract and
[API.md](API.md#the-task-object) for the full task shape.

## Removed prompt mapping

| Old Home Assistant prompt | Webhook condition for replacement UI | Old HA action id | Old kotx API endpoint |
| --- | --- | --- | --- |
| `Start implementation` | `task.kind = "implement"` and `task.state = "draft"` (`canStart = true`) | `kotx-task-<taskId>-start` | `POST /api/tasks/:id/start` |
| `Open PR` | `task.kind = "implement"`, `task.state = "awaiting_approval"`, and `task.proposes = "pr"` (`canApprove = true`) | `kotx-task-<taskId>-approve` | `POST /api/tasks/:id/approve` |
| `Confirm merge` | `task.kind = "implement"`, `task.state = "awaiting_approval"`, and `task.proposes = "merge"` (`canMerge = true`) | `kotx-task-<taskId>-approve` | `POST /api/tasks/:id/approve`; `POST /api/tasks/:id/merge` is the explicit merge-confirmation endpoint |
| `Comment review` | `task.kind = "review"` and `task.state = "awaiting_approval"` (`canComment = true`, `canApprove = true`, `proposes = "review"`) | None; the notification opened the task URL | No old HA action. The replacement UI can use `POST /api/tasks/:id/comment` or `POST /api/tasks/:id/approve` |

The old notification title was based on the GitHub subject, for example
`Issue #123 Fix flaky login` or `PR #45 Add search`. Tapping a notification
opened the frontend task URL when kotx knew `CORS_ORIGIN`; the URL used the
`#run/<kotxTaskId>` alias so the frontend could resolve the kotx task to its own
task record.

## State details

### Start implementation

A draft implement task has finished producing `TASK.md` and is waiting for a
human to start the write phase.

Expected replacement behavior:

- Surface the task for review when `canStart` is true.
- Fetch the brief with `GET /api/tasks/:id/task`.
- Optionally save edits with `PUT /api/tasks/:id/task`.
- Start work with `POST /api/tasks/:id/start`.

### Open PR

An implement task has completed coding and produced a proposed pull request for
an issue-origin branch.

Expected replacement behavior:

- Surface the PR proposal when `canApprove` is true and `proposes = "pr"`.
- Fetch the proposed PR title and body with `GET /api/tasks/:id/pr`.
- Optionally save edits with `PUT /api/tasks/:id/pr`.
- Open the PR with `POST /api/tasks/:id/approve`.

### Confirm merge

An implement task that is already tracking a PR moved back to
`awaiting_approval` because an approving PR review created a merge proposal.

Expected replacement behavior:

- Surface merge confirmation when `canMerge` is true or `proposes = "merge"`.
- Fetch approver, review URL, PR number, and approval comment with
  `GET /api/tasks/:id/merge/context`.
- Confirm with `POST /api/tasks/:id/merge`.
- `POST /api/tasks/:id/approve` remains equivalent for this old action path.

### Comment review

A review task has produced `REVIEW.md` and is waiting for a human decision.
The old Home Assistant notification was informational only and opened the
frontend task view.

Expected replacement behavior:

- Surface review completion when `canComment` or `canApprove` is true.
- Fetch the review with `GET /api/tasks/:id/review`.
- Post it as a plain PR comment with `POST /api/tasks/:id/comment`, or submit
  it as an approving PR review with `POST /api/tasks/:id/approve`.

## Compatibility details

Legacy notification tags used `kotx-task-<taskId>`. Reusing one tag per task
let later notifications replace earlier prompts and let kotx clear stale
prompts after a task moved on.

kotx may still call `clearNotification("kotx-task-<taskId>")` after normal
state changes and API actions. These calls are harmless and are intended to
dismiss prompts left behind by older deployments.

kotx also still listens for Home Assistant
`mobile_app_notification_action` events carrying legacy action ids:

- `kotx-task-<taskId>-start` dispatches to `POST /api/tasks/:id/start`.
- `kotx-task-<taskId>-approve` dispatches to `POST /api/tasks/:id/approve`.

If a legacy action dispatch fails, kotx sends an `Action failed` Home Assistant
notification with the same `kotx-task-<taskId>` tag. This listener is only a
backward-compatibility bridge for old phone notifications; downstream
replacement UI should call the kotx API directly.

Failure notifications are intentionally not part of this handoff. kotx still
sends a Home Assistant notification when a task reaches final state `failed`.
