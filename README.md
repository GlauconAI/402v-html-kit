# 402v HTML Kit

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/GlauconAI/402v-html-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/GlauconAI/402v-html-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Build once. Open anywhere. Verify offline.

402v HTML Kit turns Markdown and structured JSON into deterministic,
self-contained HTML artifacts. The result is one portable file: no server for
the reader, no runtime dependency after the build, and no surprise network
requests in a verified contract-v2 artifact.

Use it for durable notes, AI-agent reports, interactive data briefs, project
archives, or any deliverable that should remain readable long after its build
environment is gone.

```text
Markdown or manifest + JSON
          ↓
deterministic build + trusted theme
          ↓
contract-v2 verification
          ↓
one atomic, offline-ready HTML file
```

## Why 402v HTML Kit?

- **One file, not a deployment.** Scripts, styles, local images, canonical
  data, and the interactive runtime are embedded in the artifact.
- **Deterministic by design.** The same accepted source, data, renderer, and
  theme produce the same bytes.
- **Verifiable output.** The verifier checks the contract, source hash,
  canonical data, ordering, resource limits, active external resources,
  unsafe markup, overflow guards, and interactive startup.
- **Notes and real interactions.** Build clean reading pages from Markdown or
  data-backed reports with search, filters, counts, deep links, and stable data
  blocks.
- **Atomic updates.** Existing files survive failed builds; replacement is
  explicit, and interactive data can be updated by block ID.
- **Presentation stays replaceable.** The neutral compiler and artifact
  contract do not depend on the official 402v theme.
- **Structured automation.** Every operational CLI command returns one JSON
  value with stable error codes.

## Packages

This npm-workspaces monorepo contains three independently versioned packages:

| Package | Responsibility |
| --- | --- |
| `@402v/html-kit-core` | Neutral builders, artifact contracts, canonical data, verification, resource limits, and atomic writes |
| `@402v/html-kit-cli` | The `402v-html-kit` CLI, bounded workers, manifest loading, theme resolution, and structured terminal output |
| `@402v/theme-402v` | The official 402v presentation theme, selected by the CLI by default |

Supported build runtimes are Node.js `^22.13.0 || >=24.0.0` and npm 10 or
newer. CI runs Node 22 and Node 24. The produced HTML has no Node.js or npm
runtime dependency.

## Quick start from source

Until the npm release is available, use the locked repository checkout:

```sh
git clone https://github.com/GlauconAI/402v-html-kit.git
cd 402v-html-kit
npm ci
npm exec -- 402v-html-kit --help
```

## Note quick start

Start with Markdown:

```md
---
title: Field Notes
description: A portable record that stays readable offline.
---

# What changed

The artifact contains its own presentation and local images.
```

Build and verify it:

```sh
npm exec -- 402v-html-kit build examples/note/input.md \
  --output examples/note/output.html --force

npm exec -- 402v-html-kit verify examples/note/output.html
```

Success is machine-readable:

```json
{"ok":true,"contractVersion":2,"mode":"note","dataBlockIds":[],"issues":[]}
```

Note artifacts contain no runtime or consumer script. Open the generated file
directly with `file://` in a browser.

## Interactive quick start

Interactive mode uses a trusted local manifest, named JSON blocks, and a local
renderer. A minimal manifest looks like this:

```js
export default {
  contractVersion: 2,
  mode: "interactive",
  rootDirectory: ".",
  metadata: {
    title: "Offline Project Brief",
    description: "A deterministic data-backed report.",
    eyebrow: "Project Brief",
    lang: "en",
  },
  dataBlocks: [{ id: "dashboard", source: "./data.json" }],
  renderer: "./renderer.mjs",
  styles: [],
  scripts: [],
  svgAssets: [],
  requiredDataBlocks: ["dashboard"],
  theme: "@402v/theme-402v",
};
```

The renderer exports `renderArtifact` and returns bounded HTML slots:

```js
export function renderArtifact({ data }) {
  const count = data.dashboard.items.length;
  return {
    navigation: '<nav><a href="#overview">Overview</a></nav>',
    heroSupplementary: `<p>${count} tracked items</p>`,
    mainSections: '<section id="overview"><h2>Overview</h2></section>',
    rail: "",
    footer: "<p>Built and verified locally.</p>",
  };
}
```

Build it twice when exact-byte determinism matters, then verify every required
block:

```sh
npm exec -- 402v-html-kit build-artifact examples/interactive/artifact.mjs \
  --output examples/interactive/output.html --force

npm exec -- 402v-html-kit verify examples/interactive/output.html \
  --required-block dashboard
```

Browser code can read frozen canonical data without coupling to the theme:

```js
const dashboard = window.__htmlKitArtifact.getData("dashboard");
const ids = window.__htmlKitArtifact.dataIds();
```

Update one stable block without hand-editing the HTML:

```sh
npm exec -- 402v-html-kit update-data reports/project-brief.html \
  --manifest reports/artifact.mjs \
  --id dashboard \
  --input reports/data.next.json \
  --force
```

See the checked-in [interactive example](examples/interactive/) for a complete
manifest, renderer, and dataset.

## Custom theme quick start

Themes are trusted local build-time code that implements Theme Contract v1 and
is not sandboxed. Review a theme and its dependency graph before selecting it:

```sh
npm exec -- 402v-html-kit build examples/custom-theme/input.md \
  --theme ./examples/custom-theme/artifact-theme.mjs \
  --output examples/custom-theme/output.html

npm exec -- 402v-html-kit verify examples/custom-theme/output.html
```

Theme precedence is exact:

1. explicit `--theme`;
2. manifest `theme`;
3. the official default `@402v/theme-402v`.

Core never resolves a theme specifier. Programmatic callers import a Theme
Contract v1 object and pass it to core.

## Install from npm

After the `0.1.0` npm release is live, CLI-only consumers can pin the exact
release:

```sh
npm install --save-dev --save-exact @402v/html-kit-cli@0.1.0
npm exec -- 402v-html-kit --help
```

The CLI declares compatible core and official-theme dependencies. Programmatic
consumers install exact compatible versions directly:

```sh
npm install --save-exact \
  @402v/html-kit-core@0.1.0 \
  @402v/theme-402v@0.1.0
```

```js
import { buildNote, verifyArtifact } from "@402v/html-kit-core";
import theme from "@402v/theme-402v";

await buildNote({
  inputPath: "input.md",
  outputPath: "output.html",
  theme,
});

await verifyArtifact({ path: "output.html" });
```

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

`--help` is the only human-text output. Every operational command emits one
JSON object. Failures exit non-zero with a stable
`{ "ok": false, "error": { "code", "message", "details"? } }` shape; branch
on `error.code`, not message text.

The parser currently accepts `--preserve-data-from`, but the command fails
closed with `COMMAND_UNAVAILABLE`. It is not a migration or preservation path.

## What “verified offline” means

A verified contract-v2 artifact:

- contains inline scripts and styles only;
- embeds final images as data URLs;
- rejects frames, objects, media resources, module imports, unsafe URLs,
  event-handler attributes, external SVG references, and CSS dependencies;
- validates canonical JSON, source hashes, ordering, one neutral root,
  resource ceilings, overflow protection, and interactive startup;
- opens and runs without network access.

Passive links may remain. Following an `https:`, `mailto:`, `tel:`, fragment,
or relative link is an explicit user navigation. Remote Markdown images are
rendered as passive links instead of active image requests.

Contract-v1 note verification retains remote image compatibility, so v1 notes
may contain legacy remote resources and do **not** receive the strict
contract-v2 offline guarantee. Preserve v1 bytes or rebuild from source as v2.

## Trust boundary

Markdown and JSON are treated as untrusted data: they are decoded, parsed,
bounded, canonicalized, and escaped. Themes, manifests, renderers, consumer
JavaScript/CSS, and installed dependencies are trusted local code and are not
sandboxed. Verification constrains the final artifact; it does not make an
unreviewed module safe to execute.

Publishing is outside this project. 402v HTML Kit ends at a verified local
file. CMS/database writes, accounts, visibility, hosting, deployment, and
website publishing are deliberately out of scope.

## External setup gates

The source is locally release-ready, but external resources are not yet
assumed to exist. GlauconAI must control the public GitHub repository, the
`@402v` npm scope, and all three package names before release.

The GitHub ruleset for `v*.*.*` must make every release an immutable signed
annotated tag: updates and deletion are blocked, and tag creation is restricted
to designated release maintainers or explicit bypass actors.

In npm settings for each of the three packages, the trusted publisher must name
repository `GlauconAI/402v-html-kit`, workflow
`.github/workflows/release.yml`, and environment `npm`. The workflow is
resumable and accepts an existing registry package only when its integrity and
provenance match the verified release source; any mismatch fails closed. The
root-only verifier pins `sigstore@4.1.1` (Apache-2.0) as a development
dependency and never ships it in a production package.

## Documentation

- [Architecture and exact public API](docs/architecture.md)
- [Artifact Contract v2](docs/artifact-contract-v2.md)
- [Theme Contract v1](docs/theme-contract-v1.md)
- [Migration from internal contract v1](docs/migration-from-internal-v1.md)
- [Security and resource model](docs/security-model.md)
- [Source provenance](docs/provenance.md)
- [Production dependency licenses](docs/dependency-licenses.md)
- [Release checklist](docs/release-checklist.md)

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Report
vulnerabilities privately through the process in [SECURITY.md](SECURITY.md),
not through a public issue. User-visible changes belong in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 GlauconAI.
