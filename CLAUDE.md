# CLAUDE.md

Canonical agent instructions live in **[AGENTS.md](AGENTS.md)** — read that first; it is the single source of truth for repo rules, commands, and workflow.

Claude-specific notes:

- Use `gh` for all GitHub operations; `main` and `staging` reject direct pushes (ruleset) — always branch → PR.
- Read the relevant `docs/concepts/` design docs before implementing.
