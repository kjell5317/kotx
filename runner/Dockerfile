# codex-runner: short-lived container that executes one Codex task.
# Holds NO credentials of its own — CODEX_HOME is bind-mounted read-only at run
# time and the worktree is bind-mounted at /workspace (SPEC §10/§14).
FROM node:20-bookworm-slim

# git is handy for diffs inside the sandbox; bash for the entrypoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

# Install the Codex CLI. PIN the version. Verified against `codex exec --help`:
# --json (JSONL), -s/--sandbox, prompt via '-' (stdin). NOTE: exec has NO
# --ask-for-approval flag — approval policy is set via `-c approval_policy=...`.
ARG CODEX_VERSION=latest
RUN npm install -g @openai/codex@${CODEX_VERSION} \
  && codex --version

# NOTE: runs as root so it can write the worktree + /run-output bind mounts
# (created by the root worker) and read the root-owned auth. Acceptable here:
# the container drops all caps, no-new-privileges, no docker socket, minimal
# binds, and is destroyed after each task. To run unprivileged instead, have the
# worker chown the worktree/run dirs to this uid before launch, then re-enable:
#   RUN useradd -m -u 1001 codex
#   USER codex
ENV CODEX_HOME=/home/codex/.codex
WORKDIR /workspace

# The worker overrides CMD with the actual `codex exec …` invocation, but this
# documents the expected shape.
CMD ["bash", "-lc", "codex exec --json --sandbox workspace-write -c approval_policy=never - < /run-output/TASK.md > /run-output/codex.jsonl 2>&1"]
