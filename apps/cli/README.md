<!-- SPDX-License-Identifier: Apache-2.0 -->

# 3ngram CLI

Command-line access to a 3ngram server through the typed REST API.

```bash
npm install --global 3ngram
3ngram --help
```

Configure the server origin and an API key with `THREENGRAM_BASE_URL` and
`THREENGRAM_API_KEY`, or pass `--base-url` and `--api-key`. The CLI supports
`remember`, `search`, and `facts`; add `--json` for machine-readable output.

```bash
3ngram search "release decision" --scope work --project 3ngram
3ngram --version
```

Documentation and self-hosting instructions are in the
[3ngram repository](https://github.com/B3dmar/3ngram).
