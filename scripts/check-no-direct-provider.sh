#!/usr/bin/env bash
# No direct LLM-provider calls outside packages/llm.
# Every LLM/embedding call MUST go through the single client module (@3ngram/llm);
# a raw provider fetch or a provider-SDK import anywhere else bypasses operation
# routing, cost tracking, and the content-confidentiality boundary. Biome plugins
# apply repo-wide and cannot path-exclude packages/llm, so this is a hermetic
# guard in the CI hygiene lane (mirrors check-no-skip.sh / check-db-access.sh:
# --self-test + real run, fail-closed).
#
# Scope: the PRODUCTION surface only — apps/ and packages/ EXCEPT packages/llm
# (the one legal caller). eval/ is intentionally NOT scanned: the eval harness
# compares providers directly by design (S2 embedding spike), which is not an
# app bypass.
set -euo pipefail

# (a) a known provider HOST in a URL literal, or (b) an import/require of a
# provider SDK package. Anchored loosely enough to catch the realistic bypasses,
# tight enough to avoid matching prose.
HOST_PATTERN='(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.cohere\.ai|api\.mistral\.ai)'
# Static `from '<sdk>'`, CommonJS `require('<sdk>')`, AND dynamic `import('<sdk>')`
# — a dynamic import would otherwise bypass the gate.
SDK_PATTERN="(from|require[[:space:]]*\\(|import[[:space:]]*\\()[[:space:]]*[\"'](openai|@anthropic-ai/|@google/generative-ai|cohere-ai|@mistralai/)"
PATTERN="${HOST_PATTERN}|${SDK_PATTERN}"

if [[ "${1:-}" == "--self-test" ]]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  fail=0
  # Each of these MUST be flagged (a real bypass).
  breaches=(
    "await fetch('https://api.openai.com/v1/embeddings')"
    'await fetch("https://api.anthropic.com/v1/messages")'
    "fetch('https://generativelanguage.googleapis.com/v1/models')"
    "import OpenAI from 'openai'"
    'import { Anthropic } from "@anthropic-ai/sdk"'
    "import { GoogleGenerativeAI } from '@google/generative-ai'"
    "const { CohereClient } = require('cohere-ai')"
    "import MistralClient from '@mistralai/mistralai'"
    "const { default: OpenAI } = await import('openai')"
    'const sdk = await import("@anthropic-ai/sdk")'
  )
  for form in "${breaches[@]}"; do
    printf '%s\n' "$form" > "$tmp/f.ts"
    grep -qE "$PATTERN" "$tmp/f.ts" || { echo "SELF-TEST FAIL: missed -> $form" >&2; fail=1; }
  done
  # Each of these MUST NOT be flagged (the sanctioned path / unrelated code).
  clean=(
    "await gateway.embed(texts, 'memory.embed')"
    "const { createApp } = await import('./app.js')"
    "const { assertSigningKeysUsable } = await import('@3ngram/core/auth')"
    "import { createOpenAIGateway } from '@3ngram/llm'"
    "const url = \`\${baseUrl}/embeddings\`"
    "import { z } from 'zod'"
  )
  for form in "${clean[@]}"; do
    printf '%s\n' "$form" > "$tmp/c.ts"
    grep -qE "$PATTERN" "$tmp/c.ts" && { echo "SELF-TEST FAIL: false positive -> $form" >&2; fail=1; }
  done
  [[ $fail -eq 0 ]] && echo "no-direct-provider self-test: OK"
  exit $fail
fi

# Real run: production TS, excluding the one legal caller (packages/llm) and eval/.
violations=$(git ls-files 'apps/**/*.ts' 'apps/**/*.tsx' 'packages/**/*.ts' 'packages/**/*.tsx' \
  | grep -vE '^packages/llm/' \
  | xargs -r grep -lnE "$PATTERN" || true)

if [[ -n "$violations" ]]; then
  echo "ERROR: direct LLM-provider call outside packages/llm:" >&2
  echo "$violations" >&2
  echo "Use the injected Gateway from @3ngram/llm; never call a provider directly." >&2
  exit 1
fi
echo "no-direct-provider: OK"
