# codex-runner: short-lived container that executes one Codex task.
# Holds NO credentials of its own — CODEX_HOME is bind-mounted read-only at run
# time and the worktree is bind-mounted at /workspace (SPEC §10/§14).
FROM node:20-bookworm-slim

# Base toolchains so the common project types work out of the box:
#  - Node 20 + npm come from the base image
#  - Python 3 (+ pip/venv, and `python` → python3 so `python …` works)
#  - git/bash/curl for tooling
# Codex runs as root with network access, so it can apt/pip/npm/uv-install
# anything else a project needs at runtime (see the prompts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ca-certificates bash curl make build-essential \
       python3 python3-pip python3-venv python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

# The runner runs with --cap-drop ALL, so apt can't drop to the `_apt` user
# (needs CAP_SETUID) — make apt run as root so RUNTIME `apt-get install` still
# works for projects that need extra system packages.
RUN printf 'APT::Sandbox::User "root";\n' > /etc/apt/apt.conf.d/99-kotx-no-sandbox

# uv (fast Python package/env manager used by many projects). Copy the static
# binaries from the official image; pin the tag for reproducible builds.
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /usr/local/bin/

# Docker CLI (client only — no daemon). When dev-containers are enabled the
# worker runs a per-run `docker:dind` sidecar and points us at it via
# DOCKER_HOST, so Codex can `docker run` a throwaway test DB etc. The client
# binary is copied from the official docker image (no apt repo needed).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# Playwright: Chromium's system libraries plus a pre-fetched browser build in a
# shared cache. PLAYWRIGHT_BROWSERS_PATH points every project-local playwright
# install at /ms-playwright, so the pre-seeded Chromium is reused when versions
# match; a project pinned to a different playwright just downloads its matching
# build into the same cache at runtime (`npx playwright install chromium` —
# network + root are available). Running as root with CapDrop ALL is fine:
# Playwright launches Chromium with its own sandbox disabled by default, and the
# container is the isolation boundary here. Firefox/WebKit are not pre-seeded;
# `npx playwright install --with-deps firefox|webkit` works at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG PLAYWRIGHT_VERSION=latest
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

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
CMD ["bash", "-lc", "codex exec --json --sandbox workspace-write -c approval_policy=never - < /run-output/PROMPT.md > /run-output/codex.jsonl 2>&1"]
