#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# SessionStart hook for Claude Code cloud sessions.
#
# Brings a fresh cloud container to CI parity so `pnpm run check` / `pnpm run test`
# work from the first turn: Node 24 (the version .github/workflows pin) and a
# frozen-lockfile install under the repo's supply-chain posture (pnpm-workspace.yaml).
# Local sessions exit immediately — the developer's own toolchain is authoritative.
#
# Idempotent and non-interactive. Runs synchronously (the session waits for it),
# so the agent never races a half-finished install.
#
# SessionStart stdout is injected into the model context, so installer noise goes
# to stderr and stdout carries only the two "session-start:" status lines.
set -euo pipefail
# A failure below must reach the model, not only the terminal: SessionStart
# cannot block the session, its stderr goes to the user alone, and stdout is
# added to the session context only on exit 0. So the trap puts one line on
# stdout and exits 0; the line, not the exit status, is what fails closed.
trap 'echo "session-start: FAILED (exit $? at line $LINENO). Dependencies may be stale or missing: run pnpm install --frozen-lockfile, read its error and fix it before pnpm check or test."; exit 0' ERR

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

NODE_MAJOR=24

# --- Node 24 via nvm (the cloud image ships Node 22 + nvm at /opt/nvm) -------------
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  if ! nvm ls "$NODE_MAJOR" >/dev/null 2>&1; then
    nvm install "$NODE_MAJOR" --no-progress >&2
  fi
  nvm use "$NODE_MAJOR" >/dev/null
  nvm alias default "$NODE_MAJOR" >/dev/null
  NODE_BIN="$(dirname "$(nvm which "$NODE_MAJOR")")"
  # Persist for every later shell in this session (hooks run in a subshell).
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    {
      echo "export NVM_DIR=\"$NVM_DIR\""
      echo "export PATH=\"$NODE_BIN:\$PATH\""
    } >> "$CLAUDE_ENV_FILE"
  fi
else
  echo "session-start: nvm not found at $NVM_DIR; continuing with $(node --version)" >&2
fi

# --- pnpm: the version pinned by package.json#packageManager -----------------------
# pnpm >= 10 self-switches to the pinned version on first run; corepack is the
# fallback when no pnpm is on PATH at all.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm >&2
fi

echo "session-start: node $(node --version), pnpm $(pnpm --version)"

# --- Install (frozen) — same command CI runs; lifecycle scripts stay denied --------
# strictDepBuilds + allowBuilds in pnpm-workspace.yaml make this fail closed on any
# new postinstall, exactly as in CI. Cached by the container snapshot after first run.
pnpm install --frozen-lockfile >&2

echo "session-start: dependencies ready"
