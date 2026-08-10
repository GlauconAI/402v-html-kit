# Artifact Contract v2

Contract v2 is the neutral standalone HTML format emitted by the current
builders. Core, not the theme, owns document structure and protocol elements.

## Required identifiers

A v2 artifact has a plain HTML doctype, exactly one title, and these unique head
metadata entries:

- `meta[name="generator"]` with `402v HTML Kit`;
- `meta[name="html-kit-artifact-contract"]` with `2`;
- `meta[name="html-kit-artifact-mode"]` with `note` or `interactive`;
- `meta[name="html-kit-source-hash"]` with the canonical data SHA-256;
- `meta[name="html-kit-theme-id"]` and
  `meta[name="html-kit-theme-version"]`;
- viewport, description, and `html-kit-eyebrow` metadata.

There is exactly one `[data-html-kit-root]`. Core emits one
`style[data-html-kit-core]` overflow guard and may emit one
`style[data-html-kit-theme]`.

Canonical data blocks are ordered `<script type="application/json" id="ID">`
elements. IDs match `[A-Za-z][A-Za-z0-9_.:-]{0,127}`. Their stable JSON is the
only input to `html-kit-source-hash`.

## Modes and runtime

Note artifacts contain no runtime and no consumer script. Interactive artifacts
contain exactly one ordered `script[data-html-kit-runtime]`, followed only by
declared classic `script[data-html-kit-consumer-script]` elements. The runtime
creates one non-writable, non-configurable global:

```js
window.__htmlKitArtifact = Object.freeze({
  getData(id),
  dataIds(),
  root,
});
```

`getData(id)` returns a fresh parsed value for a declared block or `undefined`.
`dataIds()` returns a copy of sorted IDs. `root` is the single neutral artifact
root.

## Offline and safety invariants

All scripts and styles are inline. Imports, dynamic imports, module scripts,
external styles, frames, objects, media resources, forms with network side
effects, event-handler attributes, unsafe URLs, CSS dependencies, and external
SVG references are rejected. Images in the final document must be inline data
URLs. A note source may mention a remote image, but the Markdown compiler turns
it into an ordinary passive hyperlink; it does not emit a remote `<img>`.

Passive `http`, `https`, `mailto`, `tel`, fragment, and relative navigation
links are allowed when they do not have network side-effect attributes. The
artifact therefore opens and runs without network access, although a user can
choose to follow a link.

The verifier checks canonical JSON, source hash, ordering, one root, strict
UTF-8 file input, bounded resources, accessible and contained SVG, classic
JavaScript, stylesheet safety, overflow protection, and interactive startup
without uncaught errors. It does not require 402v theme classes, labels, links,
or CSS variables.

## Verification

```js
import { verifyArtifact, verifyArtifactHtml } from "@402v/html-kit-core";

verifyArtifact({ path: "artifact.html", requiredDataBlocks: ["dashboard"] });
verifyArtifactHtml(html, { startupTimeoutMs: 2_000 });
```

Success returns `{ ok: true, contractVersion: 2, mode, sourceHash,
dataBlockIds, issues: [] }`. Failure throws `ArtifactBuildError`; see the
[security model](security-model.md). Contract detection happens before the
version-specific verifier. Contract-v1 behavior is documented separately in
[the migration guide](migration-from-internal-v1.md).
