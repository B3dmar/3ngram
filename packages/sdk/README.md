<!-- SPDX-License-Identifier: Apache-2.0 -->

# @3ngram/sdk

Typed TypeScript client for the 3ngram REST API.

```bash
npm install @3ngram/sdk
```

```ts
import { ThreengramClient } from '@3ngram/sdk'

const client = new ThreengramClient({
  baseUrl: 'https://api.example.com',
  apiKey: process.env.THREENGRAM_API_KEY!,
})

const results = await client.search('release decision', {
  scope: 'work',
  project: '3ngram',
})
```

The client currently covers remember, search, facts, revise, and commitment
resolution. Inputs and outputs come from `@3ngram/schema`.

See the [3ngram repository](https://github.com/B3dmar/3ngram) for API and
self-hosting documentation.
