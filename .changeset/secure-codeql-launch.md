---
'@3ngram/server': patch
'@3ngram/core': patch
'@3ngram/llm': patch
'@3ngram/sdk': patch
'3ngram': patch
---

Bound every non-health HTTP surface with a coarse per-IP rate limit and replace trailing-slash regular expressions with linear-time normalization.
