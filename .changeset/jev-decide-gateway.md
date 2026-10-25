---
"@3ngram/llm": minor
"@3ngram/config": minor
"@3ngram/core": patch
"@3ngram/server": patch
"@3ngram/worker": patch
---

Add `Gateway.decide()` for typed judgments and a Jev (TypeSafe AI) provider (issue #225). `createJevGateway` uses raw fetch with one bounded attempt and no retries. It checks every answer against the questions asked, and its errors carry counts only. `createOpenAIGateway().decide()` throws `NotImplementedError`. `composeGateway` routes `decide` to Jev, and the fake gateway records `calls.decide` with a fail-closed low default. New env vars `JEV_API_URL`, `JEV_API_KEY` and `JEV_MODEL` take an explicit model pin and refuse `-latest`. The new metered operation is `session.closer.decide`. Nothing calls `decide()` yet, and judgment stays off unless `JEV_*` is configured.

Breaking for custom `Gateway` implementations: `decide` is now a required method. A wrapper or test double that implements `Gateway` by hand must add one. It can reject with `NotImplementedError('decide')`, as the OpenAI gateway does.
