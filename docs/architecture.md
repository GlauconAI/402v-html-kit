# Architecture

402v HTML Kit is a Node.js npm-workspaces monorepo whose output boundary is a
verified local HTML file.

```text
Markdown or manifest/data
        -> CLI theme resolution
        -> neutral core build + trusted theme render
        -> contract-v2 assembly + verification
        -> atomic local HTML file
```

`@402v/html-kit-core` owns parsing, canonical data, hashing, assembly,
verification, resource limits, and atomic writes. It accepts imported theme
objects and never resolves a theme package. `@402v/html-kit-cli` owns argument
parsing, bounded worker execution, starter generation, theme resolution, and
structured terminal output. `@402v/theme-402v` owns the official presentation
only; core does not import it.

Manifests and renderers are trusted local modules. The CLI loads them in a
bounded worker, while core validates their data and final output. The produced
artifact has no runtime dependency on Node.js or npm.

Publishing, identity, visibility, storage, delivery headers, hosting, database
access, and deployment are downstream concerns. They are deliberately absent
from all three packages.

## Public core API

The package root currently exports exactly these 15 runtime names:

<!-- public-api:start -->
- `ARTIFACT_RESOURCE_LIMITS`
- `ArtifactBuildError`
- `assembleArtifactV2`
- `buildInteractiveArtifact`
- `buildNote`
- `canonicalizeJson`
- `computeSourceHash`
- `detectArtifactContract`
- `extractDataBlocks`
- `renderThemeV1`
- `serializeDataBlocks`
- `stableJson`
- `updateArtifactData`
- `verifyArtifact`
- `verifyArtifactHtml`
<!-- public-api:end -->

Important current signatures are:

```js
buildNote({ inputPath, outputPath, force?, theme })
buildInteractiveArtifact({ manifestPath, outputPath, force?, theme, verifyDeterminism? })
updateArtifactData({ artifactPath, manifestPath, id, value, theme?, outputPath?, force?, verifyDeterminism?, upgradeContract? })
verifyArtifact({ path, requiredDataBlocks?, startupTimeoutMs? })
verifyArtifactHtml(html, { requiredDataBlocks?, startupTimeoutMs? }?)
assembleArtifactV2({ mode, metadata, theme, themeOutput, dataBlocks, consumerScripts })
renderThemeV1(theme, input)
```

`verifyArtifact` accepts a filesystem `path`; in-memory callers use
`verifyArtifactHtml`. Core build calls require an actual Theme Contract v1
object. `updateArtifactData` applies only to interactive artifacts. See
[Artifact Contract v2](artifact-contract-v2.md),
[Theme Contract v1](theme-contract-v1.md), and the
[v1 migration guide](migration-from-internal-v1.md).

## Determinism and installation

Canonical JSON sorts object keys and rejects values that cannot round-trip as
JSON. Data-block IDs and consumer order are checked, a SHA-256 source hash is
embedded, interactive builds may render twice to detect nondeterminism, and the
complete artifact is verified before an atomic write. Existing destinations are
preserved unless the caller explicitly enables `force`.

The repository supports Node 22 from 22.13.0 and Node 24 or newer. CI pins Node
22 and Node 24 so a future, unsupported major does not silently replace the
release matrix.
