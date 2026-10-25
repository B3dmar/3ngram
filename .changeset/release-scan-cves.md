---
'@3ngram/schema': patch
'@3ngram/config': patch
'@3ngram/sdk': patch
'@3ngram/server': patch
'3ngram': patch
---

Security: zod 4.6.6 (CVE-2023-54404, denial of service via unbounded array validation) on every package that pins it, and body-parser 2.4.0 under express (CVE-2026-111181, denial of service via an unhandled decompression stream error) through the workspace advisory override. The v1.9.0 release image scan blocked publication on both. body-parser 2.4.0 is newer than the 7-day registry cooldown, so it is a reviewed exact-version `minimumReleaseAgeExclude` entry until it matures. No API or behaviour change.
