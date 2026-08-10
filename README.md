# 402v HTML Kit

402v HTML Kit builds deterministic, self-contained HTML artifacts that can be
opened and verified offline. This npm-workspaces repository contains three
packages:

- `@402v/html-kit-core` — the neutral compiler, contract primitives, and
  verifier;
- `@402v/html-kit-cli` — the `402v-html-kit` command-line interface;
- `@402v/theme-402v` — the separately versioned official 402v presentation
  theme used by the CLI by default.

The supported build runtime is Node.js `^22.13.0 || >=24.0.0`. CI runs the
immediately previous maintained LTS, Node 22, and the current Active LTS,
Node 24. npm 10 or newer is required for local development.

## Note quick start

From a checkout of this repository, these commands install the locked
dependencies, build the checked-in note example twice, and verify it:

```sh
npm ci
npm exec -- 402v-html-kit build examples/note/input.md --output examples/note/output.html --force
npm exec -- 402v-html-kit build examples/note/input.md --output examples/note/output.html --force
npm exec -- 402v-html-kit verify examples/note/output.html
```

The default theme is `@402v/theme-402v`. The CLI writes one JSON value to
stdout on success.

## Interactive quick start

The interactive example embeds its JSON, neutral runtime, renderer output,
and styles in one file:

```sh
npm ci
npm exec -- 402v-html-kit build-artifact examples/interactive/artifact.mjs --output examples/interactive/output.html --force
npm exec -- 402v-html-kit build-artifact examples/interactive/artifact.mjs --output examples/interactive/output.html --force
npm exec -- 402v-html-kit verify examples/interactive/output.html --required-block dashboard
```

The manifest may select a theme. An explicit `--theme` flag takes precedence,
then the manifest `theme`, then the official default.

## Custom theme quick start

Local theme modules are trusted local build-time code and are not sandboxed.
Review a module and its local dependency graph before selecting it.

```sh
npm ci
npm exec -- 402v-html-kit build examples/custom-theme/input.md --theme ./examples/custom-theme/artifact-theme.mjs --output examples/custom-theme/output.html --force
npm exec -- 402v-html-kit verify examples/custom-theme/output.html
```

The core API does not resolve theme specifiers. Programmatic callers import a
theme object themselves and pass it to `buildNote`,
`buildInteractiveArtifact`, or `updateArtifactData`.

## Offline guarantee

A verified contract-v2 artifact is self-contained and makes no network request
when opened. Scripts and styles are inline, local Markdown images are embedded
as data URLs, and active external resources are rejected. Remote Markdown
images and unresolved local images are preserved as deterministic passive links
rather than `<img>` requests; following such an HTTP(S) link is an explicit
user navigation and is not offline.

Contract-v1 note verification retains legacy remote image compatibility. A
verified v1 note can therefore contain a remote image or stylesheet and is not
covered by the contract-v2 offline guarantee. Keep existing v1 bytes immutable,
but rebuild from source as v2 before treating an artifact as strictly offline.

Determinism means the same accepted source, data, renderer, and theme produce
the same bytes. Output installation is atomic and refuses to replace an
existing file unless `--force` is supplied.

## CLI reference

<!-- cli-help:start -->
```text
402v HTML Kit

Usage:
  402v-html-kit init <directory> --title <title> [--theme <specifier>] [--force]
  402v-html-kit build <input.md> [--theme <specifier>] [--output <html>] [--force]
  402v-html-kit build-artifact <manifest.mjs> [--theme <specifier>] [--output <html>] [--preserve-data-from <html>] [--force]
  402v-html-kit update-data <artifact.html> --manifest <manifest.mjs> --id <id> --input <json> [--theme <specifier>] [--output <html>] [--upgrade-contract 2] [--force]
  402v-html-kit verify <artifact.html> [--required-block <id>]...
```
<!-- cli-help:end -->

`--help` is the only human-text output. Every command emits one JSON object;
failures exit non-zero with `{ "ok": false, "error": { "code", "message",
"details"? } }`. Unsupported options and shapes use
`INVALID_CLI_ARGUMENTS`. Build and verification failures preserve their stable
`ArtifactBuildError` code. The accepted `--preserve-data-from` option is
currently unavailable and returns `COMMAND_UNAVAILABLE`; it must not be used as
an implicit v1 migration path.

## Contracts and APIs

- [Architecture and exact public API](docs/architecture.md)
- [Artifact Contract v2](docs/artifact-contract-v2.md)
- [Theme Contract v1](docs/theme-contract-v1.md)
- [Migration from internal contract v1](docs/migration-from-internal-v1.md)
- [Security and resource model](docs/security-model.md)
- [Source provenance](docs/provenance.md)
- [Production dependency licenses](docs/dependency-licenses.md)

## Project boundary

Publishing is outside this project. The repository ends at verified local HTML;
it contains no CMS, database, account, Supabase, deployment, or website
publisher. A downstream owner must separately authorize and implement any
external write.

## External setup gates

The source is locally release-ready, but external resources are not yet assumed
to exist. Before release, GlauconAI must create or confirm the public GitHub
repository, control the `@402v` npm scope and all three package names, configure
the npm trusted publisher for `.github/workflows/release.yml` with GitHub
environment `npm`, and apply required branch/environment protection. The GitHub
repository ruleset must protect the `v*.*.*` tag pattern: release tags are
immutable, signed, annotated tags and must not be updated or deleted. Tag
creation must be restricted to the designated release maintainers or explicit
ruleset bypass actors. No GitHub repository creation, npm publication, or site
deployment is performed by this source change.

In npm settings for each of the three packages, the trusted publisher must name
the eventual GitHub repository, workflow `.github/workflows/release.yml`, and
environment `npm`. A repository-level environment alone is insufficient.

The trusted-publishing job is resumable after an interrupted run. It packs and
verifies all three tarballs before publishing any of them, then skips a package
only when the registry integrity and SLSA v1 provenance match the local
tarball. npm verifies the Sigstore attestation bundle; the workflow then binds
its subject digest, repository, workflow path, tag ref, and commit to the
verified release source. Any mismatch or missing provenance fails closed.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[changelog](CHANGELOG.md). The code is licensed under the [MIT License](LICENSE).
