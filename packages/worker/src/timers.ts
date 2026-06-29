import {
  decideHitl,
  findExpiredApprovals,
  getOctokit,
  loadDefaults,
  logger,
  postIssueComment,
  setTaskState,
} from "@kotx/shared";

const SWEEP_INTERVAL_MS = 60_000;

/** Periodically cancel tasks stuck awaiting approval past the TTL (SPEC §11.2). */
export function startApprovalSweeper(): NodeJS.Timeout {
  const ttl = loadDefaults().timeouts.awaiting_approval_ttl_sec;
  const tick = async () => {
    try {
      const expired = await findExpiredApprovals(ttl);
      for (const { task, hitl } of expired) {
        await decideHitl(hitl.id, "expired", null);
        await setTaskState(task.id, "cancelled");
        try {
          const octokit = getOctokit();
          await postIssueComment(
            octokit,
            task.repo_full_name,
            task.subject_number,
            `🤖 Approval timed out after ${Math.round(ttl / 3600)}h; task #${task.id} cancelled.`,
          );
        } catch (err) {
          logger.warn({ err, taskId: task.id }, "expiry comment failed");
        }
        logger.info({ taskId: task.id }, "approval expired; cancelled");
      }
    } catch (err) {
      logger.error({ err }, "approval sweep failed");
    }
  };
  return setInterval(() => void tick(), SWEEP_INTERVAL_MS);
}
