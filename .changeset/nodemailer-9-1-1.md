---
'@3ngram/server': patch
---

Bump `nodemailer` 9.0.1 → 9.1.1. Clears four runtime advisories on the mail transport: GHSA-2x7j-588g-ccc2 (high, quadratic address-list parsing enabling remote denial of service), GHSA-wmmp-3585-3rmp and GHSA-cc9r-2j5m-2m83 (medium, recipient-domain allow-list bypasses via IDN and RFC 5322 comment mis-parsing) and GHSA-8m3c-c648-2xjj (medium, `resolveContent()` bypassing `disableFileAccess`/`disableUrlAccess` on the legacy signature). The high advisory tripped the release image scan and burned the v1.6.2 tag before anything was published. Both 9.1.x releases are past the 7-day release-age window, so no exclusion entry is needed.
