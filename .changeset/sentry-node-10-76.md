---
"@3ngram/config": patch
---

Bump `@sentry/node` from 10.56.0 to 10.76.0, the newest 10.x release past the 7-day release-age cooldown. Default integrations, the legacy `sendDefaultPii`-off data-collection mapping, request-body capture and `beforeSend`/`beforeSendTransaction` processing are unchanged for this config; `enableLogs` now defaults to `true` upstream, but no log-forwarding integration is enabled here, so nothing new is sent.
