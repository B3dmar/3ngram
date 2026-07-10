// SPDX-License-Identifier: Apache-2.0
// Apache server entrypoint — the sole side-effectful boot for self-host. Delegates
// to the shared bootstrap() (boot.ts) so the private repo's entrypoint
// runs the IDENTICAL fail-closed sequence (initObservability → loadEnv →
// metered-op check → OAuth key validation → dynamic-import createApp). No
// extension here ⇒ the no-op default ⇒ self-host runs the public build. The
// load-order contract (OTel before express) lives in bootstrap().
import { bootstrap } from './boot.js'

await bootstrap()
