# Maintainers & Governance

## Governance model

3ngram follows a **single-maintainer** ("benevolent dictator") model. One
maintainer holds final decision authority over the roadmap, architecture, code
review, releases, and the project's direction. This is a deliberate choice for a
young, opinionated project: it keeps the design coherent and the decision loop
short.

This model may evolve toward a small core team as the contributor base grows;
any change to governance will be recorded here.

## Current maintainers

| Maintainer | GitHub | Areas |
|---|---|---|
| Sebastian Gade | [@sebastianebg](https://github.com/sebastianebg) | All — architecture, releases, security, licensing, CI |

Code-ownership routing for security-, license-, release-, and CI-sensitive paths
is enforced via [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Decision-making

- **Day-to-day**: the maintainer decides, guided by the design decisions
  documented in [`docs/concepts/`](docs/concepts/).
- **Significant changes** are proposed as an issue or discussion first (see the
  contribution intake policy in [`CONTRIBUTING.md`](CONTRIBUTING.md)) so direction
  is agreed before code is written.
- **Architecture decisions** that change a documented design decision are
  proposed and reviewed before implementation.

## Contribution intake

3ngram welcomes contributions, but with a single maintainer the review budget is
finite. Please **open an issue before starting a non-trivial PR** so scope can be
agreed up front. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full policy,
the CI gates, and the DCO sign-off requirement.

## Becoming a maintainer

There is no formal ladder yet. Sustained, high-quality contributions and good
judgment in reviews are the path; the maintainer will reach out if and when it
makes sense to expand the team.

## Security

Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md) — never in a
public issue.
