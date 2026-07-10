#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# License-surface gate (LICENSING.md rule 3; Apache-only).
#
# 1. Every tracked source file must carry an SPDX header whose value is
#    EXACTLY `Apache-2.0` — presence alone is not enough; any other
#    identifier (e.g. a resurrected FSL-1.1-Apache-2.0) fails.
# 2. Every tracked package.json `license` field, when present, must equal
#    `Apache-2.0`. Publishable packages (no `"private": true`) MUST carry
#    the field; private packages may omit it (the root manifest does).
set -euo pipefail

APACHE_HEADER_RE='SPDX-License-Identifier:[[:space:]]*Apache-2\.0[[:space:]]*$'

bad_headers=$(git ls-files 'apps/**/*.ts' 'apps/**/*.tsx' 'packages/**/*.ts' 'packages/**/*.tsx' 'eval/**/*.ts' 'cmd/**/*.go' \
  | while read -r f; do
      header=$(head -3 "$f" | grep 'SPDX-License-Identifier:' || true)
      if [[ -z "$header" ]]; then
        echo "$f: missing SPDX-License-Identifier header"
      elif [[ -n "$(grep -vE "$APACHE_HEADER_RE" <<<"$header")" ]]; then
        # grep -v: fail if ANY matched SPDX line is not exactly Apache-2.0, so
        # a resurrected FSL line alongside an Apache line still trips the gate.
        # (-n on output, not -qv: ugrep's -qv exit semantics differ from GNU.)
        echo "$f: SPDX identifier is not Apache-2.0 ($(tr '\n' ' ' <<<"$header" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'))"
      fi
    done)

if [[ -n "$bad_headers" ]]; then
  echo "ERROR: SPDX header violations (must be exactly 'Apache-2.0'):" >&2
  echo "$bad_headers" >&2
  exit 1
fi

bad_manifests=$(git ls-files 'package.json' '*/package.json' \
  | while read -r f; do
      node -e '
        const fs = require("fs");
        const f = process.argv[1];
        const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
        if (pkg.license !== undefined && pkg.license !== "Apache-2.0") {
          console.log(`${f}: license field is ${JSON.stringify(pkg.license)}, must be "Apache-2.0"`);
        } else if (pkg.license === undefined && pkg.private !== true) {
          console.log(`${f}: publishable package (not private) must declare "license": "Apache-2.0"`);
        }
      ' "$f"
    done)

if [[ -n "$bad_manifests" ]]; then
  echo "ERROR: package.json license-field violations (Apache-only):" >&2
  echo "$bad_manifests" >&2
  exit 1
fi

echo "spdx: OK (headers and manifest license fields are Apache-2.0)"
