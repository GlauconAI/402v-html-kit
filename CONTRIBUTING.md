# Contributing

## Development setup

Use a supported Node.js runtime (`^22.13.0 || >=24.0.0`) and npm 10 or newer.

```sh
npm ci
npm run typecheck
npm test
npm run pack:check
npm audit --omit=dev
```

The full suite includes unit, contract-v1 compatibility, deterministic example,
real-Chrome browser, package-shape, license, and forbidden-content coverage.
`pack:check` additionally packs the three workspaces and exercises an isolated
tarball-only consumer.

Keep pull requests narrow. Add a failing test before a behavior change, update
the relevant contract document in the same change, and never include generated
HTML, package tarballs, credentials, local absolute paths, or site publisher
code. Run `git diff --check` before requesting review.

## Compatibility and versioning

This project follows Semantic Versioning (SemVer). During the `0.x` period,
contract or public API changes require at least a minor version; fixes that do
not change a documented contract use a patch version. The first release keeps
all three package versions synchronized. A release change must update all three
package manifests, the lockfile, and [CHANGELOG.md](CHANGELOG.md).

Artifact Contract v2 and Theme Contract v1 changes require explicit contract
review. Do not silently rewrite contract-v1 artifacts, widen the trusted-code
boundary, add a publisher, or introduce remote module loading.

## Review and releases

GlauconAI maintainers own release approval and execution. Contributors do not
publish packages from local machines. A maintainer release requires a reviewed
commit, clean CI, an exact signed annotated `vX.Y.Z` tag, synchronized package
versions, and the trusted-publishing workflow.

External setup is a gate: the public repository, npm scope/package ownership,
GitHub `npm` environment, and npm trusted-publisher mapping for
`.github/workflows/release.yml` must be confirmed before the tag is pushed. The
repository ruleset must make signed annotated release tags matching `v*.*.*`
immutable by preventing updates and deletion. The workflow has no npm token
secret and resumably publishes the exact verified tarballs in core, theme, then
CLI order. Existing registry releases are accepted only when integrity and
SLSA v1 provenance match; mismatches or missing provenance fail closed.
Publishing or deploying a downstream website is separate work and requires
separate authorization.

## Reporting problems

Use the issue templates for reproducible bugs and bounded feature proposals
after the public repository exists. Security findings follow
[SECURITY.md](SECURITY.md) and must not be posted publicly.
