# CLAUDE.md

Canonical agent instructions live in **[AGENTS.md](AGENTS.md)** — read that first; it is the single source of truth for repo rules, commands, and workflow.

Claude-specific notes:

- Use `gh` for all GitHub operations locally; `main` and `staging` reject direct pushes (ruleset) — always branch → PR.
- **Claude Code cloud sessions** (claude.ai/code): `gh` has no valid token there — use the GitHub MCP tools (`mcp__github__*`) instead. The SessionStart hook in `.claude/hooks/session-start.sh` installs Node 24 + a frozen `pnpm install` before the first turn (cloud only; local sessions are untouched). Cross-repo cloud-session + Routine runbook lives in 3ngram-platform `docs/operations/cloud-sessions.md`.
- Read the relevant `docs/concepts/` design docs before implementing.
