---
---

Server image build no longer sets `npm_config_ignore_scripts`, restoring the `strictDepBuilds` supply-chain tripwire during `docker build` (same fix the worker image received in #181). No runtime behavior change.
