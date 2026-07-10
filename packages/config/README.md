<!-- SPDX-License-Identifier: Apache-2.0 -->

# @3ngram/config

Shared configuration, structured logging, request context, redaction, metrics,
and observability bootstrap for 3ngram. Environment parsing is fail-closed and
uses the same validated configuration across the server and worker.

This is a low-level package used by the 3ngram runtime. Its supported exports
are declared in `package.json`; see the
[3ngram repository](https://github.com/B3dmar/3ngram) for deployment guidance.
