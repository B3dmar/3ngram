// SPDX-License-Identifier: Apache-2.0
// Public middleware barrel. Exposes the combined /api/v1
// authentication gate so the private repo can mount hosted-only authenticated
// routes behind the SAME credential handling the Apache transports use — binding
// the SAME `req.userId` (X-API-Key OR session Bearer) without re-implementing auth
// (hard rule 5). This is an Apache→private export (the private repo imports it);
// the reverse is what CI bans.
export { apiOrSessionAuth } from './api-or-session.js'
