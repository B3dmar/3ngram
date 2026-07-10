<!-- SPDX-License-Identifier: Apache-2.0 -->

# @3ngram/server

The Apache-2.0 3ngram MCP server and REST API. It exposes side-effect-free
composition seams for custom deployments; the hosted dashboard and billing
components are proprietary and are not part of this package.

For a complete deployment, use the supported Docker Compose setup or the GHCR
runtime image documented in the
[3ngram repository](https://github.com/B3dmar/3ngram). Advanced composition
roots can import `@3ngram/server/app` or `@3ngram/server/boot`.

```ts
import { bootstrap } from '@3ngram/server/boot'

await bootstrap()
```

Runtime configuration is validated at startup. See the repository's local
development and self-hosting documentation before booting the server.
