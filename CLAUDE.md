# CLAUDE.md

Canonical agent instructions live in **[AGENTS.md](AGENTS.md)** — read that first; it is the single source of truth for repo rules, commands, and workflow.

Claude-specific notes:

- Use `gh` for all GitHub operations locally; `main` and `staging` reject direct pushes (ruleset) — always branch → PR.
- **Claude Code cloud sessions** (claude.ai/code): prefer the GitHub MCP tools (`mcp__github__*`); `gh` authenticates through the proxy only for repositories configured on the environment or Routine (REST via `gh api` only, `gh pr`/`gh issue` use GraphQL and get 403), so use it as a fallback for what the MCP tools do not cover. The SessionStart hook in `.claude/hooks/session-start.sh` installs Node 24 + a frozen `pnpm install` before the first turn (cloud only; local sessions are untouched). Cross-repo cloud-session + Routine runbook lives in 3ngram-platform `docs/operations/cloud-sessions.md`.
- Read the relevant `docs/concepts/` design docs before implementing.
