---
"@3ngram/db": patch
---

A Stop debrief nudge that was armed but never shown no longer starts the re-arm cooldown. When the hook releases an attempt with a defensive `triage/complete` (the debrief fetch failed or came back blank, the envelope could not be built, or a finalize-only Stop armed), the complete now clears `triage_armed_at`. Before, the run declined `cooldown` for `SESSION_TRIAGE_REARM_COOLDOWN_MINUTES` (default 30) after a nudge the user never saw. The attempt still appears in the nudge history with its `armedAt`, and an ordinary complete is unchanged. REST and export readers see `triageArmedAt: null` after a defensive complete, as before the run's first arm.
