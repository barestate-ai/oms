# Agent image for the Solana Bench cells: the vendor CLIs the codex-web and claude-code-web cells run, and the base of the
# solbench-harness image. It holds no credential; a run mounts its own staged login. Ubuntu 22.04 matches this VM's host glibc
# library overlays. BASE_IMAGE also accepts a mirror of the same Ubuntu release.
ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep xz-utils jq \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.319 @openai/codex@0.167.0
