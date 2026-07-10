# Security Policy

We take the security of 3ngram seriously. Thank you for helping keep the
project and its users safe.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Report vulnerabilities
privately through GitHub's coordinated-disclosure channel:

- [Open a private security advisory](https://github.com/B3dmar/3ngram/security/advisories/new)

This routes the report directly to the maintainer, keeps the details private
until a fix is available, and lets us collaborate on a patch and a CVE if one is
warranted.

Please include, where you can:

- the affected component (package/app) and version or commit,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested remediation.

## Response expectations

This is a single-maintainer project (see [`MAINTAINERS.md`](MAINTAINERS.md)), so
timelines are best-effort rather than contractual:

- **Acknowledgement**: within 5 business days of a valid report.
- **Triage and severity assessment**: within 10 business days.
- **Fix and disclosure**: coordinated with the reporter; we aim to ship a patch
  before public disclosure and will credit reporters who want recognition.

If you do not receive an acknowledgement within the window above, please send a
follow-up via a new advisory rather than disclosing publicly.

## Supported versions

3ngram v1 ships from a single supported line of development. Security fixes
land on the latest v1 release; older releases do not receive backports. Run the
most recent release to stay covered.

| Version | Supported |
|---------|-----------|
| Latest `1.x` release | Yes |
| Older `1.x` and pre-1.0 releases | No (upgrade to latest) |

## Scope

In scope: the code in this repository — the memory core, MCP server, REST API
(including routes consumed by the hosted dashboard), SDK, CLI, and worker. Out
of scope: the proprietary dashboard UI and other hosted-service code maintained
in a separate private repository, plus third-party dependencies (report those
upstream; we track advisories via Dependabot).
