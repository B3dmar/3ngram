---
"@3ngram/schema": minor
"@3ngram/config": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Cap how often the Stop debrief nudge re-arms. Re-entry was one nudge per turn that produced new provenance, so a long session that kept writing was asked to debrief after nearly every turn, including the turn right after a debrief. `triage/begin` now declines with the new reason `cooldown` while the run's last armed attempt is younger than `SESSION_TRIAGE_REARM_COOLDOWN_MINUTES` (default 30; `0` switches it off; blank reads as unset). The declined signal stays untriaged, so the first Stop past the window arms on it and the closer still sees it. A run's first nudge is unchanged.

`TriageDebounceThresholds` and `SessionTriageConfig` gain the required `rearmCooldownMs`, so a composition root that builds the thresholds by hand must supply it; `loadSessionTriageConfig()` already does. `triageDeclineReasonSchema` gains `cooldown`; hooks treat any decline other than `pending` as "no nudge", so an installed `3ngram-hook` needs no update.
